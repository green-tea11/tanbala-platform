import { describe, expect, it } from 'vitest';
import type { CompanyPrompt, CompanySummary } from '../../../src/domain/company.js';
import { companyAskable, companyNameOf } from '../../../src/pipeline/company-name.js';
import { OFF_SUMMARY } from '../handoff/fakes.js';

// Компания клиента для безопасного вопроса знакомства: можно ли спросить о ней сейчас и известно ли её название.

describe('pipeline/company-name: компания для вопроса знакомства', () => {
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
