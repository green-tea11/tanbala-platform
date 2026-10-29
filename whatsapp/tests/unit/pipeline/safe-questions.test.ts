import { describe, expect, it } from 'vitest';
import { normalizeDraft, runCodeChecks } from '../../../src/checks/code-checks.js';
import type { ClientProfile, PhoneDigits } from '../../../src/domain/types.js';
import { handoffMinimum } from '../../../src/handoff/minimum.js';
import {
  askedFields,
  ESTIMATE_LATER,
  groupQuestion,
  minimumSafeQuestion,
  nextSafeQuestion,
  QUESTION_FIELDS,
  QUESTION_GROUPS,
  type QuestionField,
} from '../../../src/pipeline/safe-questions.js';

// Фиксированные вопросы о квалификации клиента (решение 29.10.2026, группы с вечера): уходят без модели, поэтому без
// фактов о Tanbala, цен и обещаний и проходят проверки кодом. Один вопрос на группу (компания; что учитывать; где и
// сколько; 1С), только о невыясненном. На ходу с вопросом цены перед вопросом фраза «Ориентир коллега назовёт, когда
// поймём ваш объект».

const NO_PHONE = '' as PhoneDigits;

function codeFindings(text: string) {
  return runCodeChecks(normalizeDraft(text), { ownPhone: NO_PHONE, clientText: '' });
}

/** Все непустые подмножества полей группы: вопрос бывает о любой их части. */
function subsets(group: readonly QuestionField[]): QuestionField[][] {
  return Array.from({ length: 2 ** group.length - 1 }, (_, mask) =>
    group.filter((_field, index) => ((mask + 1) & (1 << index)) !== 0),
  );
}

const ALL_SUBSETS = QUESTION_GROUPS.flatMap(subsets);

/** Полный вопрос каждой группы (решение владельца 29.10.2026 вечером). */
const GROUP_TEXTS = [
  'Подскажите, как называется ваша компания и чем она занимается?',
  'Подскажите, какие вещи нужно учитывать, в чём они лежат (коробки, паллеты или поштучно) и есть ли среди них металл или жидкости?',
  'Подскажите, в каком городе ваш объект, какое у вас помещение (склад, открытая площадка или магазин) и сколько примерно вещей нужно учитывать?',
  'Подскажите, есть ли у вас 1С и какая?',
];

describe('pipeline/safe-questions: группы', () => {
  it('четыре группы по порядку: компания, что учитывать, где и сколько, 1С', () => {
    expect(QUESTION_GROUPS).toEqual([
      ['company', 'business'],
      ['items', 'packaging', 'material'],
      ['city', 'premises', 'itemCount'],
      ['has1C', 'oneCName'],
    ]);
    expect(QUESTION_FIELDS).toEqual(QUESTION_GROUPS.flat());
  });

  it('полный вопрос группы одним предложением', () => {
    expect(QUESTION_GROUPS.map((group) => groupQuestion(group, false))).toEqual(GROUP_TEXTS);
    expect(groupQuestion(['has1C'], false)).toBe('Подскажите, есть ли у вас 1С и какая?');
    expect(groupQuestion(['oneCName'], false)).toBe('Подскажите, какая у вас конфигурация 1С?');
  });

  it('только о невыясненном: вторая и дальше части с местоимением, порядок полей как в группе', () => {
    expect(groupQuestion(['material', 'packaging'], false)).toBe(
      'Подскажите, в чём лежат вещи (коробки, паллеты или поштучно) и есть ли среди них металл или жидкости?',
    );
    expect(groupQuestion(['business'], false)).toBe('Подскажите, чем занимается ваша компания?');
    expect(groupQuestion(['premises', 'itemCount'], false)).toBe(
      'Подскажите, какое у вас помещение (склад, открытая площадка или магазин) и сколько примерно вещей нужно учитывать?',
    );
  });

  it('без полей вопроса нет', () => {
    expect(() => groupQuestion([], false)).toThrow(RangeError);
  });

  it.each(ALL_SUBSETS.map((fields) => [fields.join('+'), fields] as const))(
    'вопрос о «%s» проходит проверки кодом и с фразой об ориентире',
    (_name, fields) => {
      expect(codeFindings(groupQuestion(fields, false))).toEqual([]);
      expect(codeFindings(groupQuestion(fields, true))).toEqual([]);
    },
  );

  it.each(ALL_SUBSETS.map((fields) => [fields.join('+'), fields] as const))(
    'вопрос о «%s»: одно предложение-вопрос, без фактов о нас',
    (_name, fields) => {
      const text = groupQuestion(fields, false);

      expect(text.split('?')).toHaveLength(2);
      expect(text.endsWith('?')).toBe(true);
      expect(text).not.toMatch(/Tanbala|мы |наш|цен|стоим|коллег|уточню|бесплат|срок/iu);
    },
  );

  it('на ходу с вопросом цены: сначала фраза об ориентире, затем вопрос', () => {
    expect(ESTIMATE_LATER).toBe('Ориентир коллега назовёт, когда поймём ваш объект.');
    expect(groupQuestion(['material'], true)).toBe(
      `${ESTIMATE_LATER} ${groupQuestion(['material'], false)}`,
    );
  });
});

describe('pipeline/safe-questions: о чём спрашивал прошлый вопрос бота', () => {
  it.each(QUESTION_FIELDS)(
    'фиксированный вопрос о «%s» узнаётся как вопрос об этом поле',
    (field) => {
      expect(askedFields(groupQuestion([field], true)).has(field)).toBe(true);
    },
  );

  it.each(QUESTION_GROUPS.map((group) => [group.join('+'), group] as const))(
    'полный вопрос группы «%s» узнаётся как вопрос о каждом её поле',
    (_name, group) => {
      const asked = askedFields(groupQuestion(group, false));
      expect(group.filter((field) => !asked.has(field))).toEqual([]);
    },
  );

  it.each<[string, QuestionField]>([
    ['Цена сильно зависит от объёма. Сколько примерно вещей нужно учитывать?', 'itemCount'],
    ['Металл и жидкости важны для меток. Из чего сделаны ваши вещи?', 'material'],
    ['Понял. В каком городе склад?', 'city'],
    ['Что именно вы хотите учитывать: товар, инструмент или оборудование?', 'items'],
    ['Да, мы проводим интеграцию с вашей 1С. Какая у вас конфигурация?', 'oneCName'],
    ['Вы из компании ТОО Береке, правильно?', 'company'],
    ['Подскажите, вещи хранятся на складе или на открытой площадке?', 'premises'],
    ['Сколько примерно паллет и коробок у вас проходит через склад?', 'itemCount'],
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
  const KNOWN_BUSINESS: ClientProfile = { ...EMPTY, business: 'дистрибуция' };

  function input(profile: ClientProfile, lastBotText: string | null, companyAskable = false) {
    const minimum = handoffMinimum({ profile, companyName: null, companyAskable });
    return { profile, minimum, lastBotText };
  }

  function next(profile: ClientProfile, lastBotText: string | null, companyAskable = false) {
    return nextSafeQuestion(input(profile, lastBotText, companyAskable), false)?.fields ?? null;
  }

  it('первая группа с невыясненным, только её невыясненные поля', () => {
    expect(next(EMPTY, null, true)).toEqual(['company', 'business']);
    expect(next(EMPTY, null)).toEqual(['business']);
    expect(next(KNOWN_BUSINESS, null)).toEqual(['items', 'packaging', 'material']);
    expect(next({ ...KNOWN_BUSINESS, items: 'запчасти', packaging: 'коробки' }, null)).toEqual([
      'material',
    ]);
  });

  it('группу, о которой бот спросил прошлым сообщением, второй раз подряд не спрашивает', () => {
    const afterItems = { ...KNOWN_BUSINESS, items: 'товар', packaging: 'паллеты' };
    expect(next(afterItems, groupQuestion(['items', 'packaging', 'material'], false))).toEqual([
      'city',
      'premises',
      'itemCount',
    ]);
    expect(next(KNOWN_BUSINESS, 'Из какого материала вещи? В каком городе склад?')).toEqual([
      'has1C',
    ]);
  });

  it('вопрос о компании отмечается как вопрос о названии', () => {
    const question = nextSafeQuestion(input(MINIMUM_DONE, null, true), false);
    expect(question).toEqual({
      fields: ['company', 'business'],
      text: GROUP_TEXTS[0],
      companyQuestion: 'name',
    });
  });

  it('минимум собран: упаковка и конфигурация 1С в своих группах; площадь, учёт и боли отдельно не спрашиваются', () => {
    const almost: ClientProfile = { ...MINIMUM_DONE, business: 'дистрибуция' };
    expect(next(almost, null)).toEqual(['packaging']);
    expect(next({ ...almost, packaging: 'коробки' }, null)).toEqual(['oneCName']);
    expect(next({ ...almost, packaging: 'коробки', has1C: false }, null)).toBeNull();
    expect(next({ ...almost, packaging: 'коробки', oneCName: 'УТ 11' }, null)).toBeNull();
  });

  it('вывод «вероятно» считается выясненным', () => {
    const done = { ...MINIMUM_DONE, business: 'склад', packaging: 'коробки', oneCName: 'УТ' };
    expect(next({ ...done, inferred: ['has1C', 'business'] }, null)).toBeNull();
  });

  it('единственная оставшаяся группа только что спрошена: безопасного вопроса нет', () => {
    const onlyCity: ClientProfile = {
      ...MINIMUM_DONE,
      city: null,
      business: 'дистрибуция',
      packaging: 'коробки',
      oneCName: 'УТ 11',
    };

    expect(next(onlyCity, null)).toEqual(['city']);
    expect(next(onlyCity, groupQuestion(['city'], true))).toBeNull();
  });

  it('вместо ранней передачи по цене: только группа с недостающим из минимума, с фразой об ориентире', () => {
    const question = minimumSafeQuestion(input(EMPTY, null), true);
    expect(question.fields).toEqual(['items', 'packaging', 'material']);
    expect(question.text).toBe(`${ESTIMATE_LATER} ${GROUP_TEXTS[1] ?? ''}`);
    expect(question.companyQuestion).toBeUndefined();
  });

  it('вместо ранней передачи по цене: все группы спрошены, всё равно спрашивается первая', () => {
    const onlyCity = { ...MINIMUM_DONE, city: null };
    expect(
      minimumSafeQuestion(input(onlyCity, groupQuestion(['city'], true)), true).fields,
    ).toEqual(['city']);
  });
});
