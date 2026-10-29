import type { CheckFinding } from '../checks/code-checks.js';
import type {
  ReplyDraft,
  ReplyHandoffOutcome,
  ReviewedText,
  ReviewResult,
} from '../domain/types.js';
import type { MinimumField } from '../handoff/minimum.js';

/**
 * Чем закончились проверки текста черновика: без ревью текст модели не уходит никогда.
 * Нарушения проверок кодом (checks/code-checks.ts) уходят модели замечаниями при повторе.
 */
export type DraftGate =
  | {
      readonly kind: 'code_failed';
      readonly findings: readonly [CheckFinding, ...CheckFinding[]];
    }
  | { readonly kind: 'reviewed'; readonly review: ReviewResult };

/**
 * Черновик с текстом клиенту: ответ answer или исход передачи (hot, no_answer, asked_human), у которого модель
 * написала сообщение. И то и другое проверяется одинаково: кодом и вторым вызовом.
 */
export type TextDraft = Extract<ReplyDraft, { readonly text: string }>;

/** Черновик исхода передачи с текстом модели (hot, no_answer, asked_human). */
type HandoffDraft = Extract<ReplyDraft, { readonly outcome: ReplyHandoffOutcome }>;

/** Всё, что известно о черновике к моменту решения. kind на верхнем уровне сужает тип без проверки полей. */
export type DecisionInput =
  | {
      /** Текст прошёл проверки кодом и второй вызов (или не прошёл): решение зависит от итога и попытки. */
      readonly kind: 'text';
      readonly draft: TextDraft;
      readonly gate: DraftGate;
      readonly attempt: 1 | 2;
    }
  | {
      /**
       * Исход, у которого нечего проверять: complaint (фраза фиксированная) или исход передачи с пустым text.
       * text исхода передачи здесь не учитывается: клиенту уйдёт фиксированная фраза по причине.
       */
      readonly kind: 'handoff_outcome';
      readonly draft: Exclude<ReplyDraft, { readonly outcome: 'answer' }>;
    };

/** Что делать с черновиком: отправить, переписать с замечаниями или передать менеджеру. */
export type Decision =
  | { readonly kind: 'send'; readonly text: ReviewedText }
  | { readonly kind: 'retry'; readonly feedback: readonly string[] }
  /** Ответ не прошёл проверки дважды: фиксированная фраза check_failed. */
  | { readonly kind: 'handoff'; readonly reason: 'check_failed' }
  /**
   * Передача по решению вызова ответа; text есть, если сообщение модели прошло проверки. aboutPrice только у hot без
   * text: клиент спрашивал цену, фиксированная фраза о цене.
   */
  | {
      readonly kind: 'handoff';
      readonly reason: ReplyHandoffOutcome;
      readonly text?: ReviewedText;
      readonly aboutPrice?: boolean;
    }
  | { readonly kind: 'handoff'; readonly reason: 'complaint'; readonly stopRequested: boolean };

/**
 * Фиксированные вопросы о недостающем для передачи по цене (решение владельца 29.10.2026): уходят клиенту, если модель
 * и после замечания хочет передать чат по цене раньше времени. Тексты свои, без LLM: проверки кодом они проходят
 * (это проверяют тесты), поэтому к ReviewedText приводятся здесь, как проверенный текст модели. Те же вопросы для
 * модели (в третьем лице) в handoff/minimum.ts (QUESTIONS): меняя вопрос здесь, поправьте и там.
 */
export const PRICE_QUESTION_TEXTS: Readonly<Record<MinimumField, string>> = {
  scope:
    'Цена сильно зависит от объёма. Подскажите, что нужно учитывать: только ввоз и вывоз или где лежит каждая вещь? Это нужно, чтобы коллега сразу назвал ориентир.',
  itemCount:
    'Цена сильно зависит от объёма. Подскажите, сколько примерно вещей нужно учитывать? Это нужно, чтобы коллега сразу назвал ориентир.',
  has1C:
    'Цена сильно зависит от объёма. Подскажите, у вас есть 1С и какая? Это нужно, чтобы коллега сразу назвал ориентир.',
  company:
    'Цена сильно зависит от объёма. Подскажите, как называется ваша компания? Это нужно, чтобы коллега сразу назвал ориентир.',
  problem:
    'Цена сильно зависит от объёма. Подскажите, какую задачу вы хотите решить учётом? Это нужно, чтобы коллега сразу назвал ориентир.',
};

/** Фиксированный вопрос о недостающем поле минимума как текст, который можно отправить. */
export function priceQuestion(field: MinimumField): ReviewedText {
  return PRICE_QUESTION_TEXTS[field] as ReviewedText;
}

/** Замечание повтору, когда проверка не пройдена, а причин не назвала: иначе повтор был бы слепым. */
const GENERIC_FEEDBACK =
  'Проверка не пройдена. Перепиши ответ строго по документам: без цен, сроков, обещаний и фактов, которых в них нет';

/**
 * Развилка шагов с 3 по 5 плана. Чистая функция: все ветки покрываются юнит-тестами без LLM.
 * Решение о передаче принимает вызов ответа (исход черновика), а не оценка интереса: уровень интереса здесь не
 * участвует. handoff_outcome: complaint (со stopRequested) и исходы передачи без текста передаются по своей причине
 * с фиксированной фразой. text: проверки кодом или второй вызов не пройдены: попытка 1 => retry с замечаниями
 * (нарушения кода или замечания проверки), попытка 2 => для ответа handoff check_failed, для исхода передачи та же
 * причина без текста (клиенту уйдёт фиксированная фраза, причина не меняется). Проверки пройдены => answer даёт
 * send, исход передачи даёт handoff с этим текстом вместо фиксированной фразы. Здесь и только здесь текст
 * приводится к ReviewedText. Без ревью текст не отправляется никогда. Передача hot без текста с aboutPrice черновика
 * несёт aboutPrice: клиенту уйдёт фиксированная фраза о цене.
 */
export function decideAction(input: DecisionInput): Decision {
  if (input.kind === 'handoff_outcome') return handoffFor(input.draft);
  const { draft, gate, attempt } = input;
  const feedback = feedbackOf(gate);
  if (feedback === null) return passed(draft);
  return attempt === 1 ? { kind: 'retry', feedback } : exhausted(draft);
}

function handoffFor(draft: Exclude<ReplyDraft, { readonly outcome: 'answer' }>): Decision {
  return draft.outcome === 'complaint'
    ? { kind: 'handoff', reason: 'complaint', stopRequested: draft.stopRequested }
    : byReply(draft);
}

/** Передача по исходу черновика с фиксированной фразой: у hot после вопроса цены с пометкой aboutPrice. */
function byReply(draft: HandoffDraft): Decision {
  return draft.outcome === 'hot' && draft.aboutPrice === true
    ? { kind: 'handoff', reason: 'hot', aboutPrice: true }
    : { kind: 'handoff', reason: draft.outcome };
}

/** Проверки пройдены: ответ уходит клиенту, сообщение передачи уходит вместо фиксированной фразы. */
function passed(draft: TextDraft): Decision {
  const text = draft.text as ReviewedText;
  return draft.outcome === 'answer'
    ? { kind: 'send', text }
    : { kind: 'handoff', reason: draft.outcome, text };
}

/** Вторая попытка не помогла: ответ даёт check_failed, исход передачи сохраняет причину и теряет только текст. */
function exhausted(draft: TextDraft): Decision {
  return draft.outcome === 'answer' ? { kind: 'handoff', reason: 'check_failed' } : byReply(draft);
}

/** Замечания для повтора; null, если оба вида проверок пройдены. Всегда новый массив. */
function feedbackOf(gate: DraftGate): readonly string[] | null {
  if (gate.kind === 'code_failed') return gate.findings.map((finding) => finding.detail);
  if (gate.review.ok) return null;
  return gate.review.problems.length === 0 ? [GENERIC_FEEDBACK] : [...gate.review.problems];
}
