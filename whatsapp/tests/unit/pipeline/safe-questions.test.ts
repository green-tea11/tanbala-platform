import { describe, expect, it } from 'vitest';
import { normalizeDraft, runCodeChecks } from '../../../src/checks/code-checks.js';
import type { ClientProfile, PhoneDigits } from '../../../src/domain/types.js';
import { handoffMinimum } from '../../../src/handoff/minimum.js';
import {
  askedFields,
  ESTIMATE_LATER,
  nextSafeField,
  QUESTION_FIELDS,
  SAFE_QUESTION_TEXTS,
  safeQuestion,
  type QuestionField,
} from '../../../src/pipeline/safe-questions.js';

// Фиксированные вопросы о квалификации клиента (решение 29.10.2026): уходят без модели, поэтому без фактов о Tanbala,
// цен и обещаний и проходят проверки кодом. На ходу с вопросом цены перед вопросом фраза «Ориентир коллега назовёт,
// когда поймём ваш объект».

const NO_PHONE = '' as PhoneDigits;

function codeFindings(text: string) {
  return runCodeChecks(normalizeDraft(text), { ownPhone: NO_PHONE, clientText: '' });
}

describe('pipeline/safe-questions', () => {
  it('вопрос есть на каждое поле квалификации: минимум и остальное', () => {
    expect([...QUESTION_FIELDS].sort()).toEqual(
      [
        'items',
        'material',
        'itemCount',
        'premises',
        'city',
        'has1C',
        'company',
        'business',
        'packaging',
        'area',
        'turnover',
        'currentTracking',
        'problem',
        'oneCName',
      ].sort(),
    );
    expect(Object.keys(SAFE_QUESTION_TEXTS).sort()).toEqual([...QUESTION_FIELDS].sort());
  });

  it.each(QUESTION_FIELDS)(
    'вопрос о «%s» проходит проверки кодом и с фразой об ориентире',
    (field) => {
      expect(codeFindings(safeQuestion(field, false))).toEqual([]);
      expect(codeFindings(safeQuestion(field, true))).toEqual([]);
    },
  );

  it.each(QUESTION_FIELDS)('вопрос о «%s»: ровно один вопрос, без фактов о нас', (field) => {
    const text = SAFE_QUESTION_TEXTS[field];

    expect(text.split('?')).toHaveLength(2);
    expect(text.endsWith('?')).toBe(true);
    expect(text).not.toMatch(/Tanbala|мы |наш|цен|стоим|коллег|уточню|бесплат|срок/iu);
  });

  it('на ходу с вопросом цены: сначала фраза об ориентире, затем вопрос', () => {
    expect(ESTIMATE_LATER).toBe('Ориентир коллега назовёт, когда поймём ваш объект.');
    expect(safeQuestion('material', true)).toBe(
      `${ESTIMATE_LATER} ${SAFE_QUESTION_TEXTS.material}`,
    );
    expect(safeQuestion('material', false)).toBe(SAFE_QUESTION_TEXTS.material);
  });
});

describe('pipeline/safe-questions: о чём спрашивал прошлый вопрос бота', () => {
  it.each(QUESTION_FIELDS)(
    'фиксированный вопрос о «%s» узнаётся как вопрос об этом поле',
    (field) => {
      expect(askedFields(safeQuestion(field, true)).has(field)).toBe(true);
    },
  );

  it.each<[string, QuestionField]>([
    ['Цена сильно зависит от объёма. Сколько примерно вещей нужно учитывать?', 'itemCount'],
    ['Металл и жидкости важны для меток. Из чего сделаны ваши вещи?', 'material'],
    ['Понял. В каком городе склад?', 'city'],
    ['На больших складах обычно непросто понять, вся ли партия ушла. Как у вас с этим?', 'problem'],
    ['Что именно вы хотите учитывать: товар, инструмент или оборудование?', 'items'],
    ['Да, мы проводим интеграцию с вашей 1С. Какая у вас конфигурация?', 'oneCName'],
    ['Вы из компании ТОО Береке, правильно?', 'company'],
    ['Подскажите, вещи хранятся на складе или на открытой площадке?', 'premises'],
  ])('вопрос модели «%s» спрашивает о «%s»', (text, field) => {
    expect(askedFields(text).has(field)).toBe(true);
  });

  it('утверждение без вопроса ничего не спрашивает', () => {
    expect(
      askedFields('Металл и жидкости важны для выбора метки. Учёт подбираем под задачу.').size,
    ).toBe(0);
  });
});

describe('pipeline/safe-questions: какой вопрос задать вместо отклонённого черновика', () => {
  const EMPTY: ClientProfile = {
    business: null,
    items: null,
    packaging: null,
    material: null,
    city: null,
    premises: null,
    area: null,
    scope: null,
    itemCount: null,
    turnover: null,
    currentTracking: null,
    has1C: null,
    oneCName: null,
    problem: null,
    specifics: null,
    problemAgreed: false,
    inferred: [],
  };
  const MINIMUM_DONE: ClientProfile = {
    ...EMPTY,
    items: 'запчасти',
    material: 'металл',
    itemCount: 'около 3000',
    premises: 'склад',
    city: 'Алматы',
    has1C: true,
  };

  function next(profile: ClientProfile, lastBotText: string | null, companyAskable = false) {
    const minimum = handoffMinimum({ profile, companyName: null, companyAskable });
    return nextSafeField({ profile, minimum, lastBotText });
  }

  it('первое недостающее из минимума по порядку', () => {
    expect(next(EMPTY, null)).toBe('items');
    expect(next({ ...EMPTY, items: 'запчасти' }, null)).toBe('material');
  });

  it('о чём бот спросил прошлым сообщением, второй раз подряд не спрашивает', () => {
    expect(next(EMPTY, safeQuestion('items', false))).toBe('material');
    expect(next(EMPTY, 'Из какого материала вещи? Какие вещи учитываете?')).toBe('itemCount');
  });

  it('компания только если о ней можно спросить', () => {
    const rest = { ...MINIMUM_DONE };

    expect(next(rest, null, true)).toBe('company');
    expect(next(rest, null, false)).toBe('business');
  });

  it('минимум собран: остальное по порядку; конфигурация 1С только если 1С есть', () => {
    expect(next(MINIMUM_DONE, null)).toBe('business');
    const almost: ClientProfile = {
      ...MINIMUM_DONE,
      business: 'дистрибуция',
      packaging: 'коробки',
      area: '5000 м²',
      turnover: 'каждый день',
      currentTracking: 'Excel',
      problem: 'пересорт',
    };
    expect(next(almost, null)).toBe('oneCName');
    expect(next({ ...almost, has1C: false }, null)).toBeNull();
    expect(next({ ...almost, oneCName: 'УТ 11' }, null)).toBeNull();
  });

  it('вывод «вероятно» считается выясненным', () => {
    expect(next({ ...MINIMUM_DONE, inferred: ['has1C'] }, null)).toBe('business');
  });

  it('единственный оставшийся вопрос только что задан: безопасного вопроса нет', () => {
    const onlyCity: ClientProfile = {
      ...MINIMUM_DONE,
      city: null,
      business: 'дистрибуция',
      packaging: 'коробки',
      area: '5000 м²',
      turnover: 'каждый день',
      currentTracking: 'Excel',
      problem: 'пересорт',
      oneCName: 'УТ 11',
    };

    expect(next(onlyCity, null)).toBe('city');
    expect(next(onlyCity, safeQuestion('city', true))).toBeNull();
  });
});
