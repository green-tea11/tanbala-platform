import { z } from 'zod';
import type { ReviewResult } from '../domain/types.js';
import { cleanLine } from './clean-text.js';

/** Замечания уходят модели при повторе черновика: короткие и немногочисленные, иначе они сами станут промптом. */
const MAX_PROBLEMS = 5;
const MAX_PROBLEM_CHARS = 300;

/** Проверка не прошла, а замечаний модель не дала: черновик всё равно не уходит, а повтору нужна подсказка. */
const GENERAL_PROBLEM =
  'Проверка не пройдена, причина не названа. Перепиши ответ строго по документам: без цен, сроков, скидок, количества оборудования, моделей и обещаний.';

/**
 * Схема ответа проверки: плоский объект, все поля обязательны (structured outputs вместо запрещённого prefill).
 * Без transform: вход и выход совпадают. Противоречия в ответе снимает normalizeReview.
 */
export const reviewSchema = z.object({
  ok: z
    .boolean()
    .describe(
      'true, если черновик можно отправлять клиенту; false, если есть хотя бы одно нарушение.',
    ),
  problems: z
    .array(z.string())
    .describe(
      'По одному короткому замечанию на каждое нарушение: что не так и как исправить. При ok true пустой список.',
    ),
});

/** Ответ модели до нормализации. */
export interface RawReview {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * Нормализует ответ проверки один раз и fail-closed: замечания главнее флага. Есть замечания => ok false, даже если
 * модель написала ok true. ok false без замечаний => одно общее замечание. Замечания после cleanLine: одна строка,
 * не длиннее 300 знаков, не больше пяти. ok true остаётся только без единого замечания.
 */
export function normalizeReview(raw: RawReview): ReviewResult {
  const problems = raw.problems
    .map((problem) => cleanLine(problem, MAX_PROBLEM_CHARS))
    .filter((problem) => problem !== '')
    .slice(0, MAX_PROBLEMS);
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return raw.ok ? { ok: true } : { ok: false, problems: [GENERAL_PROBLEM] };
}

/** Итог проверки пустого черновика: проверять нечего, пропустить его нельзя. LLM для него не вызывается. */
export const EMPTY_DRAFT_REVIEW: ReviewResult = { ok: false, problems: ['Черновик пуст.'] };

/**
 * Данные вызова проверки: текст черновика, который нужно проверить. Черновик последним, поэтому его конец
 * однозначен: дальше только закрытие блока. Угловые скобки в нём заменяет buildTurns.
 */
export function reviewCallData(draftText: string): string {
  return `Черновик ответа клиенту, его нужно проверить:\n${draftText.trim()}`;
}
