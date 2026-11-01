import { describe, expect, it } from 'vitest';
import {
  CALC_FIELDS,
  calcKnown,
  calcMissing,
  ESTIMATE_LATER,
  recommendStage,
  stageReplyData,
  STRENGTH_LABELS,
  taskUnderstood,
  type StageInput,
} from '../../../src/agent/stage.js';
import type { ClientProfile, ConversationStage } from '../../../src/domain/types.js';
import { HOT_PRICE_HANDOFF_TEXT } from '../../../src/messaging/outbox.js';
import { EMPTY_PROFILE } from './fakes.js';

/** Выжимка, где известно всё для расчёта (решение владельца 30.10.2026). */
const FULL: ClientProfile = {
  ...EMPTY_PROFILE,
  business: 'склад запчастей',
  items: 'запчасти в коробках',
  itemCount: 'около 10 тысяч позиций',
  monthlyIntake: '500 в месяц',
  passages: 'один вход',
  has1C: true,
  city: 'Алматы',
};

function input(patch: Partial<StageInput> = {}): StageInput {
  return { profile: FULL, lastStage: null, handedOff: false, ...patch };
}

describe('agent/stage: всё для расчёта', () => {
  it('порядок полей: бизнес, что на хранении, сколько, нового в месяц, проходы, 1С, город', () => {
    expect(CALC_FIELDS).toEqual([
      'business',
      'items',
      'itemCount',
      'monthlyIntake',
      'passages',
      'has1C',
      'city',
    ]);
  });

  it('пустая выжимка: не хватает всего по порядку', () => {
    expect(calcMissing(EMPTY_PROFILE)).toEqual(CALC_FIELDS);
  });

  it('пустые и пробельные строки не считаются, has1C false считается выясненным, вывод «вероятно» тоже', () => {
    const profile: ClientProfile = {
      ...FULL,
      items: '  ',
      city: '',
      has1C: false,
      passages: 'два входа',
      inferred: ['passages'],
    };

    expect(calcMissing(profile)).toEqual(['items', 'city']);
  });

  it('остальные поля выжимки (материал, помещение, пересчёт полок) для расчёта не нужны', () => {
    expect(calcMissing({ ...FULL, material: null, premises: null, shelfRecount: null })).toEqual(
      [],
    );
  });
});

describe('agent/stage: рекомендуемый этап', () => {
  it('нет бизнеса: знакомство, при любом прошлом этапе', () => {
    for (const lastStage of [null, 'intro', 'hook', 'details', 'final'] as const) {
      expect(recommendStage(input({ profile: { ...FULL, business: null }, lastStage })).stage).toBe(
        'intro',
      );
    }
  });

  it.each([null, 'intro'] as const)(
    'бизнес известен, бот ещё не был на крючке (прошлый этап %s): крючок, даже если всё известно',
    (lastStage) => {
      expect(recommendStage(input({ lastStage })).stage).toBe('hook');
    },
  );

  it('последний ответ бота на крючке: как это работает', () => {
    expect(recommendStage(input({ lastStage: 'hook' })).stage).toBe('explain');
    expect(
      recommendStage(input({ lastStage: 'hook', profile: { ...FULL, city: null } })).stage,
    ).toBe('explain');
  });

  it.each(['explain', 'details', 'final'] as const)(
    'после этапа %s: чего-то не хватает => боли и детали, всё есть => финал',
    (lastStage: ConversationStage) => {
      expect(
        recommendStage(input({ lastStage, profile: { ...FULL, monthlyIntake: null } })).stage,
      ).toBe('details');
      expect(recommendStage(input({ lastStage })).stage).toBe('final');
    },
  );

  it('чат уже передавался коллеге: финал не предлагается, всё известно => боли и детали', () => {
    expect(recommendStage(input({ lastStage: 'details', handedOff: true }))).toEqual({
      stage: 'details',
      missing: [],
      missingWords: [],
    });
  });

  it('недостающее для расчёта приходит полями и человеческими словами по порядку', () => {
    const advice = recommendStage(
      input({ lastStage: 'explain', profile: { ...EMPTY_PROFILE, business: 'банк' } }),
    );

    expect(advice.missing).toEqual([
      'items',
      'itemCount',
      'monthlyIntake',
      'passages',
      'has1C',
      'city',
    ]);
    expect(advice.missingWords).toEqual([
      'что лежит на хранении',
      'сколько этого примерно',
      'сколько нового приходит в месяц',
      'сколько проходов нужно учитывать',
      'есть ли 1С и какая',
      'город',
    ]);
  });
});

describe('agent/stage: строки данных вызова ответа', () => {
  it('этап по данным системы с номером и названием, недостающее, рассказанное и вопросы цены', () => {
    const text = stageReplyData({
      advice: recommendStage(input({ lastStage: 'hook', profile: { ...FULL, city: null } })),
      toldFacts: ['F2', 'F3'],
      priceAsks: 2,
    });

    expect(text.split('\n')).toEqual([
      'Этап по данным системы: 3 как это работает. Если из последнего сообщения клиента ясно другое (например, он сам знает RFID или уже назвал всё нужное), выбери этап сам и верни его в stage.',
      'Для расчёта не хватает: город.',
      'Задача клиента ещё не понятна: на вопрос цены, сроков или договора ответь «Ориентир коллега назовёт, когда поймём вашу задачу.» и задай один вопрос.',
      'Уже рассказано: F2, F3.',
      'До этого сообщения клиент спрашивал цену 2 раза.',
    ]);
  });

  it.each([
    ['intro', '1 знакомство'],
    ['hook', '2 крючок'],
    ['explain', '3 как это работает'],
    ['details', '4 боли и детали'],
    ['final', '5 финал'],
  ] as const)('этап %s словами: %s', (stage, words) => {
    const text = stageReplyData({ advice: { stage, missing: [], missingWords: [] } });

    expect(text).toContain(`Этап по данным системы: ${words}.`);
  });

  it('всё известно, ничего не рассказано, цену не спрашивал: строки «известно всё», без рассказанного и цены', () => {
    const text = stageReplyData({ advice: recommendStage(input({ lastStage: 'details' })) });

    expect(text).toContain('Для расчёта известно всё.');
    expect(text).not.toMatch(/Уже рассказано|цену/);
  });

  it('вопросы цены: «раз» и «раза» по числу, ноль не пишется', () => {
    const advice = recommendStage(input());

    expect(stageReplyData({ advice, priceAsks: 1 })).toContain('спрашивал цену 1 раз.');
    expect(stageReplyData({ advice, priceAsks: 3 })).toContain('спрашивал цену 3 раза.');
    expect(stageReplyData({ advice, priceAsks: 5 })).toContain('спрашивал цену 5 раз.');
    expect(stageReplyData({ advice, priceAsks: 12 })).toContain('спрашивал цену 12 раз.');
    expect(stageReplyData({ advice, priceAsks: 22 })).toContain('спрашивал цену 22 раза.');
    expect(stageReplyData({ advice, priceAsks: 0 })).not.toMatch(/цену/);
  });
});

describe('agent/stage: задача клиента понятна (решение владельца 30.10.2026)', () => {
  const TASK: ClientProfile = {
    ...EMPTY_PROFILE,
    problemAgreed: true,
    items: 'запчасти',
    itemCount: 'около 3000',
  };

  it('понятна: клиент согласился с трудностью или рассказал о задаче, известно, что на хранении и сколько', () => {
    expect(taskUnderstood(TASK)).toBe(true);
    expect(taskUnderstood({ ...TASK, items: 'вероятно товар', inferred: ['items'] })).toBe(true);
  });

  it.each<[string, Partial<ClientProfile>]>([
    ['нет согласия с трудностью', { problemAgreed: false }],
    ['неизвестно, что на хранении', { items: null }],
    ['неизвестно сколько', { itemCount: null }],
    ['пустая строка вместо числа', { itemCount: '  ' }],
  ])('не понятна: %s', (_name, patch) => {
    expect(taskUnderstood({ ...TASK, ...patch })).toBe(false);
  });

  it('остальное для расчёта (город, 1С, проходы) для понятной задачи не нужно', () => {
    expect(calcMissing(TASK)).toEqual(['business', 'monthlyIntake', 'passages', 'has1C', 'city']);
    expect(taskUnderstood(TASK)).toBe(true);
  });
});

describe('agent/stage: строка о вопросе цены, сроков и договора в данных вызова ответа', () => {
  const advice = recommendStage(input());

  it('задача понятна: передать чат (hot) с фразой о решении и ориентире', () => {
    const text = stageReplyData({ advice, taskUnderstood: true });

    expect(text.split('\n')).toContain(
      'Задача клиента понятна: если он спрашивает цену, сроки или договор, передай чат (hot) с фразой «Я уточню у коллеги решение и ориентир под вашу задачу.».',
    );
    expect(text).toContain(`«${HOT_PRICE_HANDOFF_TEXT}»`);
  });

  it('задача не понятна или поля нет: ответить фразой об ориентире и задать один вопрос', () => {
    const line =
      'Задача клиента ещё не понятна: на вопрос цены, сроков или договора ответь «Ориентир коллега назовёт, когда поймём вашу задачу.» и задай один вопрос.';

    expect(stageReplyData({ advice, taskUnderstood: false }).split('\n')).toContain(line);
    expect(stageReplyData({ advice }).split('\n')).toContain(line);
    expect(line).toContain(`«${ESTIMATE_LATER}»`);
  });

  it('строка идёт сразу после недостающего для расчёта', () => {
    const lines = stageReplyData({ advice, taskUnderstood: true, priceAsks: 1 }).split('\n');

    expect(lines[1]).toBe('Для расчёта известно всё.');
    expect(lines[2]).toMatch(/^Задача клиента понятна/);
    expect(lines[3]).toBe('До этого сообщения клиент спрашивал цену 1 раз.');
  });
});

describe('agent/stage: для менеджера (уведомление и панель)', () => {
  it('что для расчёта известно: по порядку полей, остальное в недостающем', () => {
    const profile = { ...FULL, monthlyIntake: null, city: '  ' };

    expect(calcKnown(profile)).toEqual(['business', 'items', 'itemCount', 'passages', 'has1C']);
    expect(calcMissing(profile)).toEqual(['monthlyIntake', 'city']);
    expect(calcKnown(EMPTY_PROFILE)).toEqual([]);
  });

  it('короткие названия всех сильных сторон F1…F10 владельца, без тире и двоеточий', () => {
    expect(STRENGTH_LABELS).toEqual({
      F1: 'метка читается по радио',
      F2: 'сотни меток за секунду',
      F3: 'антенны на входе и выходе',
      F4: 'ручной сканер',
      F5: 'в метку записан товар',
      F6: 'интеграция с 1С',
      F7: 'своя веб-платформа в дополнение к 1С',
      F8: 'под ключ',
      F9: 'лучше штрихкода',
      F10: 'не госмаркировка',
    });
    expect(Object.values(STRENGTH_LABELS).join(' ')).not.toMatch(/[—–:]/u);
  });
});
