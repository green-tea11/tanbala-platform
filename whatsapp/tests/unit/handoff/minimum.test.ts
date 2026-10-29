import { describe, expect, it } from 'vitest';
import type { CompanyPrompt, CompanySummary } from '../../../src/domain/company.js';
import type { ClientProfile } from '../../../src/domain/types.js';
import {
  companyAskable,
  companyNameOf,
  handoffMinimum,
  MINIMUM_LABELS,
  minimumReport,
} from '../../../src/handoff/minimum.js';
import { OFF_SUMMARY } from './fakes.js';

// Минимум для передачи по цене (решение владельца 29.10.2026): что учитывать, примерное число вещей, есть ли 1С,
// название компании и согласие клиента, что трудность есть.

const EMPTY: ClientProfile = {
  business: null,
  area: null,
  scope: null,
  itemCount: null,
  has1C: null,
  oneCName: null,
  problem: null,
  specifics: null,
  problemAgreed: false,
};

const FULL: ClientProfile = {
  ...EMPTY,
  scope: 'ввоз и вывоз',
  itemCount: 'около 2000',
  has1C: true,
  problemAgreed: true,
};

describe('handoff/minimum: handoffMinimum', () => {
  it('ничего не известно, о компании можно спросить: не хватает всего, по порядку вопросов', () => {
    const minimum = handoffMinimum({ profile: EMPTY, companyName: null, companyAskable: true });

    expect(minimum).toEqual({
      collected: [],
      missing: ['scope', 'itemCount', 'has1C', 'company', 'problem'],
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
      collected: ['scope', 'itemCount', 'has1C', 'company', 'problem'],
      missing: [],
      unknown: [],
    });
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
      collected: ['scope', 'itemCount', 'has1C', 'problem'],
      missing: [],
      unknown: ['company'],
    });
  });

  it('диалог 28.10: склад, ввоз и вывоз, 1С есть, число вещей и компания не выяснены', () => {
    const profile: ClientProfile = {
      ...EMPTY,
      business: 'склад',
      area: '5000 м²',
      scope: 'ввоз и вывоз',
      has1C: true,
      problemAgreed: true,
    };

    const minimum = handoffMinimum({ profile, companyName: null, companyAskable: true });

    expect(minimum.missing).toEqual(['itemCount', 'company']);
  });

  it('пустое название компании не считается', () => {
    const minimum = handoffMinimum({ profile: FULL, companyName: '  ', companyAskable: true });

    expect(minimum.missing).toEqual(['company']);
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
    const report = minimumReport({ profile: FULL, companyName: null });

    expect(report).toEqual({
      collected: `${MINIMUM_LABELS.scope}, ${MINIMUM_LABELS.itemCount}, ${MINIMUM_LABELS.has1C}, ${MINIMUM_LABELS.problem}`,
      missing: MINIMUM_LABELS.company,
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
