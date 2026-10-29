import { describe, expect, it } from 'vitest';
import { normalizeDraft, runCodeChecks } from '../../../src/checks/code-checks.js';
import type { PhoneDigits } from '../../../src/domain/types.js';
import {
  ESTIMATE_LATER,
  QUESTION_FIELDS,
  SAFE_QUESTION_TEXTS,
  safeQuestion,
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

  it.each(QUESTION_FIELDS)('вопрос о «%s» проходит проверки кодом и с фразой об ориентире', (field) => {
    expect(codeFindings(safeQuestion(field, false))).toEqual([]);
    expect(codeFindings(safeQuestion(field, true))).toEqual([]);
  });

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
