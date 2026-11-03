import { z } from 'zod';
import type { ReviewResult } from '../domain/types.js';
import { cleanLine } from './clean-text.js';

/** Замечания уходят модели при повторе черновика: короткие и немногочисленные, иначе они сами станут промптом. */
const MAX_PROBLEMS = 5;
const MAX_PROBLEM_CHARS = 300;

/** Проверка не прошла, а замечаний модель не дала: черновик всё равно не уходит, а повтору нужна подсказка. */
const GENERAL_PROBLEM =
  'Проверка не пройдена, причина не названа. Перепиши ответ строго по знаниям: без цен, обещаний и того, чего в них нет.';

/**
 * Номера пунктов инструкции проверки (agent/prompts.ts, REVIEW_INSTRUCTION): 1 неправда, 2 цена, 3 обещание (просьба
 * владельца 03.11.2026). Все три о фактах: стиль проверяет код.
 */
export const REVIEW_RULES = ['1', '2', '3'] as const;

export type ReviewRule = (typeof REVIEW_RULES)[number];

/**
 * Схема ответа проверки: плоский объект, все поля обязательны (structured outputs вместо запрещённого prefill).
 * Без transform: вход и выход совпадают. Противоречия в ответе снимает normalizeReview. У каждого замечания номер
 * пункта инструкции: по нему в логе видно, неправда это, цена или обещание.
 */
export const reviewSchema = z.object({
  ok: z
    .boolean()
    .describe(
      'true, если черновик можно отправлять клиенту; false, если есть хотя бы одно нарушение.',
    ),
  problems: z
    .array(
      z.object({
        rule: z
          .enum(REVIEW_RULES)
          .describe('Номер пункта из списка нарушений в инструкции, который нарушен.'),
        text: z.string().describe('Что не так и как исправить, одной фразой.'),
      }),
    )
    .describe('По одному замечанию на каждое нарушение. При ok true пустой список.'),
});

/** Одно замечание модели до нормализации. */
export interface RawReviewProblem {
  readonly rule: ReviewRule;
  readonly text: string;
}

/** Ответ модели до нормализации. */
export interface RawReview {
  readonly ok: boolean;
  readonly problems: readonly RawReviewProblem[];
}

/**
 * Нормализует ответ проверки один раз и fail-closed: замечания главнее флага. Есть замечания => ok false, даже если
 * модель написала ok true. ok false без замечаний => одно общее замечание. Замечания после cleanLine: одна строка, не
 * длиннее 300 знаков, не больше пяти. ok true остаётся только без единого замечания.
 */
export function normalizeReview(raw: RawReview): ReviewResult {
  const problems = raw.problems
    .map((problem) => cleanLine(problem.text, MAX_PROBLEM_CHARS))
    .filter((problem) => problem !== '')
    .slice(0, MAX_PROBLEMS);
  if (problems.length > 0) return { ok: false, problems };
  return raw.ok ? { ok: true } : { ok: false, problems: [GENERAL_PROBLEM] };
}

/** Итог проверки пустого черновика: проверять нечего, пропустить его нельзя. LLM для него не вызывается. */
export const EMPTY_DRAFT_REVIEW: ReviewResult = { ok: false, problems: ['Черновик пуст.'] };

/**
 * Что проверяется. answer: обычный ответ, чат остаётся у бота. handoff: сообщение о передаче чата коллеге
 * (исходы hot, no_answer, asked_human): после него чат уходит коллеге (менеджеру), поэтому в нём допустима фраза
 * «Уточню у коллеги и вернусь к вам» (пункт 3 инструкции проверки). Время ответа, цена и обещания там нельзя так же,
 * как в ответе.
 */
export type DraftKind = 'answer' | 'handoff';

const ANSWER_TITLE = 'Черновик ответа клиенту (чат остаётся у бота), его нужно проверить:';
const HANDOFF_TITLE =
  'Черновик сообщения о передаче чата коллеге (после него чат уходит коллеге), его нужно проверить:';

/**
 * Данные вызова проверки: что известно о компании клиента (companyData, если есть), выжимка о клиенте (profileData,
 * если есть: пункт 3 задания 01.11.2026, чтобы проверка не считала выдумкой сказанное раньше окна переписки), затем
 * текст черновика с подписью, обычный ли это ответ или сообщение о передаче (пункт 3 инструкции проверки опирается
 * на эту подпись).
 * Черновик последним, поэтому его конец однозначен: дальше только закрытие блока. Угловые скобки в нём заменяет
 * buildTurns.
 */
export function reviewCallData(
  draftText: string,
  kind: DraftKind = 'answer',
  companyData: string | null = null,
  profileData: string | null = null,
): string {
  const title = kind === 'handoff' ? HANDOFF_TITLE : ANSWER_TITLE;
  const draft = `${title}\n${draftText.trim()}`;
  return [companyData, profileData, draft].filter((part) => part !== null).join('\n\n');
}
