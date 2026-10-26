import type { CheckFinding } from '../checks/code-checks.js';
import type {
  HandoffReason,
  InterestAssessment,
  ReplyDraft,
  ReviewedText,
  ReviewResult,
} from '../domain/types.js';

/**
 * Чем закончились проверки черновика с исходом answer: без ревью черновик не уходит никогда.
 * Нарушения проверок кодом (checks/code-checks.ts) уходят модели замечаниями при повторе.
 * skipped: проверки не запускались, потому что клиент горячий и черновик ему не уходит, а вызов ревью стоил бы денег.
 * Для клиента, который не горячий, пропуск проверок отправкой не кончается никогда.
 */
export type DraftGate =
  | {
      readonly kind: 'code_failed';
      readonly findings: readonly [CheckFinding, ...CheckFinding[]];
    }
  | { readonly kind: 'reviewed'; readonly review: ReviewResult }
  | { readonly kind: 'skipped' };

/** Всё, что известно о черновике к моменту решения. kind на верхнем уровне сужает тип без проверки полей. */
export type DecisionInput =
  | {
      readonly kind: 'answer';
      readonly draft: Extract<ReplyDraft, { outcome: 'answer' }>;
      readonly gate: DraftGate;
      readonly attempt: 1 | 2;
      /** Оценка интереса; null, если её ещё нет. */
      readonly assessment: InterestAssessment | null;
    }
  | {
      readonly kind: 'handoff_outcome';
      readonly draft: Exclude<ReplyDraft, { outcome: 'answer' }>;
      readonly assessment: InterestAssessment | null;
    };

/** Причины передачи, которые возвращает decideAction (llm_error решает конвейер, human_took_over перехват). */
export type DecisionHandoffReason = Extract<
  HandoffReason,
  'hot' | 'no_answer' | 'asked_human' | 'check_failed'
>;

/** Что делать с черновиком: отправить, переписать с замечаниями или передать менеджеру. */
export type Decision =
  | { readonly kind: 'send'; readonly text: ReviewedText }
  | { readonly kind: 'retry'; readonly feedback: readonly string[] }
  | { readonly kind: 'handoff'; readonly reason: DecisionHandoffReason }
  | { readonly kind: 'handoff'; readonly reason: 'complaint'; readonly stopRequested: boolean };

/** Замечание повтору, когда проверка не пройдена, а причин не назвала: иначе повтор был бы слепым. */
const GENERIC_FEEDBACK =
  'Проверка не пройдена. Перепиши ответ строго по документам: без цен, сроков, обещаний и фактов, которых в них нет';

/**
 * Развилка шагов с 3 по 5 плана. Чистая функция: все ветки покрываются юнит-тестами без LLM.
 * handoff_outcome: no_answer, asked_human и complaint (со stopRequested) передаются по своей причине, и горячий
 * клиент её не подменяет: уровень интереса уходит менеджеру отдельным полем уведомления.
 * answer: горячий клиент (assessment.level 'hot') => 'hot' при любом исходе проверок: черновик не уходит, клиенту
 * одна фраза передачи, а не два сообщения. Иначе проверки кодом или второй вызов не пройдены: попытка 1 => retry
 * с замечаниями (нарушения кода или замечания проверки), попытка 2 => 'check_failed'.
 * send только при gate reviewed и review.ok; здесь и только здесь текст приводится к ReviewedText. Без ревью
 * черновик не отправляется никогда: gate skipped у клиента, который не горячий, это check_failed без повтора.
 */
export function decideAction(input: DecisionInput): Decision {
  if (input.kind === 'handoff_outcome') return handoffFor(input.draft);
  if (input.assessment?.level === 'hot') return { kind: 'handoff', reason: 'hot' };
  if (input.gate.kind === 'skipped') return { kind: 'handoff', reason: 'check_failed' };
  const feedback = feedbackOf(input.gate);
  if (feedback === null) return { kind: 'send', text: input.draft.text as ReviewedText };
  return input.attempt === 1
    ? { kind: 'retry', feedback }
    : { kind: 'handoff', reason: 'check_failed' };
}

function handoffFor(draft: Exclude<ReplyDraft, { outcome: 'answer' }>): Decision {
  return draft.outcome === 'complaint'
    ? { kind: 'handoff', reason: 'complaint', stopRequested: draft.stopRequested }
    : { kind: 'handoff', reason: draft.outcome };
}

/** Замечания для повтора; null, если оба вида проверок пройдены. Всегда новый массив. */
function feedbackOf(
  gate: Exclude<DraftGate, { readonly kind: 'skipped' }>,
): readonly string[] | null {
  if (gate.kind === 'code_failed') return gate.findings.map((finding) => finding.detail);
  if (gate.review.ok) return null;
  return gate.review.problems.length === 0 ? [GENERIC_FEEDBACK] : [...gate.review.problems];
}
