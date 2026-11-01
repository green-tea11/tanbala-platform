import { z } from 'zod';
import type { ReviewProblemKind, ReviewResult } from '../domain/types.js';
import { cleanLine } from './clean-text.js';

/** Замечания уходят модели при повторе черновика: короткие и немногочисленные, иначе они сами станут промптом. */
const MAX_PROBLEMS = 5;
const MAX_PROBLEM_CHARS = 300;

/** Проверка не прошла, а замечаний модель не дала: черновик всё равно не уходит, а повтору нужна подсказка. */
const GENERAL_PROBLEM =
  'Проверка не пройдена, причина не названа. Перепиши ответ строго по документам: без цен, сроков, скидок, количества оборудования, моделей и обещаний.';

/** Номера пунктов инструкции проверки (agent/prompts.ts, REVIEW_INSTRUCTION): по ним код решает вид замечания. */
export const REVIEW_RULES = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  '11',
  '12',
  '13',
] as const;

export type ReviewRule = (typeof REVIEW_RULES)[number];

/**
 * Пункты о стиле разговора: 11 (несколько вопросов подряд) и 12 (повтор вопроса, вопрос о том, что клиент уже сказал).
 * Остальные пункты о фактах, обещаниях, цене, сроках и компании клиента.
 */
const STYLE_RULES: ReadonlySet<ReviewRule> = new Set<ReviewRule>(['11', '12']);

/**
 * Вид замечания по номеру пункта (ревью 01.11.2026): решает код, а не модель, поэтому обещание, названное «тоном»,
 * стилем не станет. Только пункты 11 и 12 style, любой другой fact.
 */
export function problemKindOf(rule: ReviewRule): ReviewProblemKind {
  return STYLE_RULES.has(rule) ? 'style' : 'fact';
}

/**
 * Схема ответа проверки: плоский объект, все поля обязательны (structured outputs вместо запрещённого prefill).
 * Без transform: вход и выход совпадают. Противоречия в ответе снимает normalizeReview. У каждого замечания номер
 * пункта инструкции, по нему код определяет вид замечания (пункт 3 задания 01.11.2026, problemKindOf).
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
 * модель написала ok true. ok false без замечаний => одно общее замечание (вида fact). Замечания после cleanLine: одна
 * строка, не длиннее 300 знаков, не больше пяти. ok true остаётся только без единого замечания. styleOnly: все замечания
 * модели вида style (problemKindOf), считая пустые и не вошедшие в пять (любое fact снимает пометку).
 */
export function normalizeReview(raw: RawReview): ReviewResult {
  const problems = raw.problems
    .map((problem) => cleanLine(problem.text, MAX_PROBLEM_CHARS))
    .filter((problem) => problem !== '')
    .slice(0, MAX_PROBLEMS);
  if (problems.length > 0) {
    const styleOnly = raw.problems.every((problem) => problemKindOf(problem.rule) === 'style');
    return styleOnly ? { ok: false, problems, styleOnly } : { ok: false, problems };
  }
  return raw.ok ? { ok: true } : { ok: false, problems: [GENERAL_PROBLEM] };
}

/** Итог проверки пустого черновика: проверять нечего, пропустить его нельзя. LLM для него не вызывается. */
export const EMPTY_DRAFT_REVIEW: ReviewResult = { ok: false, problems: ['Черновик пуст.'] };

/**
 * Что проверяется. answer: обычный ответ, чат остаётся у бота. handoff: сообщение о передаче чата коллеге
 * (исходы hot, no_answer, asked_human): после него чат уходит коллеге (менеджеру), поэтому в нём допустима фраза
 * «Уточню у коллеги и вернусь к вам». Время ответа, цена и обещания там нельзя так же, как в ответе.
 */
export type DraftKind = 'answer' | 'handoff';

const ANSWER_TITLE = 'Черновик ответа клиенту, его нужно проверить:';
const HANDOFF_TITLE =
  'Черновик сообщения о передаче чата коллеге (после него чат уходит коллеге), его нужно проверить:';

/**
 * Данные вызова проверки: что известно о компании клиента (companyData, если есть: какие вопросы и данные о ней
 * допустимы), выжимка о клиенте и чего ещё не хватает для расчёта (profileData, если есть: пункт 3 задания 01.11.2026,
 * чтобы проверка не считала выдумкой сказанное раньше окна переписки), затем текст черновика, который нужно проверить,
 * с подписью, обычный ли это ответ или сообщение о передаче (пункт 6 инструкции проверки опирается на эту подпись).
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
