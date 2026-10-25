import type {
  CheckViolation,
  HandoffReason,
  InterestAssessment,
  ReplyDraft,
  ReviewedText,
  ReviewResult,
} from '../domain/types.js';
import { notImplemented } from '../shared/todo.js';

/** Чем закончились проверки черновика с исходом answer: без ревью черновик не уходит никогда. */
export type DraftGate =
  | {
      readonly kind: 'code_failed';
      readonly violations: readonly [CheckViolation, ...CheckViolation[]];
    }
  | { readonly kind: 'reviewed'; readonly review: ReviewResult };

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

/**
 * Развилка шагов с 3 по 5 плана. Чистая функция: все ветки покрываются юнит-тестами без LLM.
 * TODO(этап 4): kind handoff_outcome: no_answer => handoff 'no_answer'; asked_human => 'asked_human'; complaint => 'complaint' со stopRequested.
 * TODO(этап 4): kind answer: горячий клиент (assessment.level 'hot') => handoff 'hot'; gate code_failed или review с ok: false: на попытке 1 => retry с замечаниями, на попытке 2 => handoff 'check_failed'.
 * TODO(этап 4): send только при gate reviewed и review.ok; здесь и только здесь текст приводится к ReviewedText. Без ревью черновик не отправляется никогда.
 */
export function decideAction(input: DecisionInput): Decision {
  return notImplemented('этап 4', 'pipeline/decide.decideAction');
}
