import { describe, expect, it } from 'vitest';
import type { CompanyPrompt, CompanySummary } from '../../../src/domain/company.js';
import type { ClientProfile } from '../../../src/domain/types.js';
import {
  companyAskable,
  companyNameOf,
  handoffMinimum,
  MINIMUM_LABELS,
  minimumReport,
  PRICE_ASKS_FOR_HANDOFF,
} from '../../../src/handoff/minimum.js';
import { OFF_SUMMARY } from './fakes.js';

// Минимум для передачи по цене (решение владельца 29.10.2026, второй круг): компания; что учитывать (какие вещи и
// материал); примерное число вещей; город и тип помещения; есть ли 1С.

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
  monthlyIntake: null,
  passages: null,
  shelfRecount: null,
  inferred: [],
  has1C: null,
  oneCName: null,
  problem: null,
  specifics: null,
  problemAgreed: false,
};

const FULL: ClientProfile = {
  ...EMPTY,
  items: 'запчасти',
  material: 'металл',
  itemCount: 'около 3000',
  city: 'Алматы',
  premises: 'склад',
  has1C: true,
};

describe('handoff/minimum: handoffMinimum', () => {
  it('ничего не известно, о компании можно спросить: не хватает всего, по порядку вопросов', () => {
    const minimum = handoffMinimum({ profile: EMPTY, companyName: null, companyAskable: true });

    expect(minimum).toEqual({
      collected: [],
      missing: ['items', 'material', 'itemCount', 'premises', 'city', 'has1C', 'company'],
      unknown: [],
    });
  });

  it('всё собрано: передаче по цене ничего не мешает', () => {
    const minimum = handoffMinimum({
      profile: FULL,
      companyName: 'ТОО Склад',
      companyAskable: false,
    });

    expect(minimum).toEqual({
      collected: ['items', 'material', 'itemCount', 'premises', 'city', 'has1C', 'company'],
      missing: [],
      unknown: [],
    });
  });

  it('прежний минимум (что отмечать, согласие с трудностью) больше не нужен, а без города и материала нельзя', () => {
    const minimum = handoffMinimum({
      profile: {
        ...EMPTY,
        scope: 'ввоз и вывоз',
        itemCount: 'около 2000',
        has1C: true,
        problemAgreed: true,
        items: 'одежда',
        premises: 'магазин',
      },
      companyName: 'Береке',
      companyAskable: true,
    });

    expect(minimum.missing).toEqual(['material', 'city']);
  });

  it('1С: «нет» тоже ответ, какая 1С для минимума не обязательна', () => {
    const minimum = handoffMinimum({
      profile: { ...FULL, has1C: false },
      companyName: 'Береке',
      companyAskable: true,
    });

    expect(minimum.missing).toEqual([]);
  });

  it('компанию спросить нельзя (уже спрашивали или определение выключено): она не мешает, но не выяснена', () => {
    const minimum = handoffMinimum({ profile: FULL, companyName: null, companyAskable: false });

    expect(minimum).toEqual({
      collected: ['items', 'material', 'itemCount', 'premises', 'city', 'has1C'],
      missing: [],
      unknown: ['company'],
    });
  });

  it('живой тест 29.10: склад 5000 м², ввоз и вывоз, 1С, 3000 позиций: не хватает вещей, материала, города, компании', () => {
    const profile: ClientProfile = {
      ...EMPTY,
      business: 'склад',
      premises: 'склад',
      area: '5000 м²',
      scope: 'ввоз и вывоз',
      itemCount: 'около 3000 позиций',
      has1C: true,
    };

    const minimum = handoffMinimum({ profile, companyName: null, companyAskable: true });

    expect(minimum.missing).toEqual(['items', 'material', 'city', 'company']);
  });

  it('пустые строки не считаются', () => {
    const minimum = handoffMinimum({
      profile: { ...FULL, material: '  ', city: '' },
      companyName: '  ',
      companyAskable: true,
    });

    expect(minimum.missing).toEqual(['material', 'city', 'company']);
  });

  it('четвёртый вопрос цены даёт передачу без минимума (решение владельца 29.10.2026, второй круг)', () => {
    expect(PRICE_ASKS_FOR_HANDOFF).toBe(4);
  });
});

describe('handoff/minimum: компания для минимума', () => {
  it.each<[CompanyPrompt | undefined, boolean]>([
    [undefined, false],
    [{ kind: 'off' }, false],
    [{ kind: 'unknown', askName: true }, true],
    [{ kind: 'unknown', askName: false }, false],
    [{ kind: 'searching' }, false],
    [{ kind: 'candidate', name: 'Береке', city: null, withCity: false }, true],
    [{ kind: 'asked', name: 'Береке', city: null, awaitingAnswer: true }, false],
    [{ kind: 'confirmed', name: 'Береке', rubric: null, pains: [], emailed: false }, false],
  ])('блок %j: спросить о компании можно: %s', (prompt, askable) => {
    expect(companyAskable(prompt)).toBe(askable);
  });

  it('название: подтверждённая компания, иначе со слов клиента, иначе null', () => {
    const confirmed: CompanySummary = {
      ...OFF_SUMMARY,
      status: 'confirmed',
      name: 'ТОО Склад',
      statedName: 'Склад',
    };
    const candidate: CompanySummary = {
      ...OFF_SUMMARY,
      status: 'candidate',
      name: 'ТОО Другая',
      statedName: null,
    };

    expect(companyNameOf(confirmed)).toBe('ТОО Склад');
    expect(companyNameOf({ ...OFF_SUMMARY, status: 'unknown', statedName: ' Береке ' })).toBe(
      'Береке',
    );
    expect(companyNameOf(candidate)).toBeNull();
    expect(companyNameOf(OFF_SUMMARY)).toBeNull();
    expect(companyNameOf(null)).toBeNull();
  });
});

describe('handoff/minimum: отчёт для менеджера', () => {
  it('что собрано и что не удалось выяснить, словами', () => {
    const report = minimumReport({ profile: { ...FULL, city: null }, companyName: null });

    expect(report).toEqual({
      collected: 'какие вещи, материал, примерное число вещей, тип помещения, есть ли 1С',
      missing: 'город, название компании',
    });
  });

  it('ничего не собрано или всё собрано: понятные слова вместо пустого списка', () => {
    expect(minimumReport({ profile: EMPTY, companyName: null }).collected).toBe('ничего');
    expect(minimumReport({ profile: FULL, companyName: 'Береке' }).missing).toBe('всё выяснено');
  });

  it('подписи без тире', () => {
    expect(Object.values(MINIMUM_LABELS).join(' ')).not.toMatch(/[—–]/);
  });
});
