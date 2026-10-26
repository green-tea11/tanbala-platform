import type { Agent, ConversationContext } from '../agent/agent.js';
import { normalizeDraft, runCodeChecks } from '../checks/code-checks.js';
import type { ChatsRepo, Clock, Logger } from '../domain/ports.js';
import type {
  BudgetScope,
  ChatId,
  HandoffNotice,
  InterestAssessment,
  LlmResult,
  NormalizedText,
  PhoneDigits,
  ReplyDraft,
  ReviewedText,
  StoredMessage,
} from '../domain/types.js';
import { decideAction, type Decision, type DraftGate } from './decide.js';

/** Что нужно ходу ответа от остальной системы: агент, запись оценки интереса, часы и лог. */
export interface ReplyFlowDeps {
  readonly chats: Pick<ChatsRepo, 'saveAssessment'>;
  readonly agent: Pick<Agent, 'draftReply' | 'reviewDraft' | 'assessInterest'>;
  readonly clock: Pick<Clock, 'now'>;
  readonly logger: Logger;
}

/** Ответы двух параллельных вызовов LLM: черновик и оценка интереса. Сбой приходит значением. */
export interface Drafted {
  readonly draft: LlmResult<ReplyDraft>;
  readonly assessment: LlmResult<InterestAssessment>;
}

/**
 * Что делать с чатом по итогам хода: отправить проверенный текст, передать менеджеру с фиксированной фразой
 * (в том числе при сбое LLM) или замолчать из-за исчерпанного дневного лимита API.
 */
export type ReplyVerdict =
  | { readonly kind: 'send'; readonly text: ReviewedText }
  | { readonly kind: 'handoff'; readonly notice: HandoffNotice }
  | { readonly kind: 'limit'; readonly scope: BudgetScope };

/**
 * Своего номера в ответах у бота нет: knowledge/whatsapp.md запрещает вставлять номер WhatsApp. Пустой «наш номер»
 * не равен ни одному номеру из текста, поэтому checks/code-checks.checkContacts отклоняет любой номер телефона.
 * Служебное значение на границе бренда PhoneDigits, настоящим номером оно не является.
 */
const NO_OWN_PHONE = '' as PhoneDigits;

const UNAVAILABLE: LlmResult<never> = { ok: false, failure: 'unavailable' };

/** Второй провал проверок: текст без ревью не уходит никогда. */
const CHECK_FAILED: ReplyVerdict = { kind: 'handoff', notice: { reason: 'check_failed' } };

type LlmFailed = Extract<LlmResult<unknown>, { readonly ok: false }>;
type Attempt = 1 | 2;

/** Всё, что нужно одной попытке: зависимости, разговор и оценка интереса (null, если её нет). */
interface Flow {
  readonly deps: ReplyFlowDeps;
  readonly context: ConversationContext;
  readonly assessment: InterestAssessment | null;
}

/** Итог одной попытки: решение принято или нужен повтор черновика с замечаниями. */
type Judgement =
  | { readonly kind: 'verdict'; readonly verdict: ReplyVerdict }
  | { readonly kind: 'retry'; readonly feedback: readonly string[] };

/** Итог проверок черновика: пройдены кодом или вторым вызовом, либо второй вызов не дал результата. */
type Checked =
  | { readonly kind: 'checked'; readonly text: NormalizedText; readonly gate: DraftGate }
  | { readonly kind: 'failed'; readonly verdict: ReplyVerdict };

/**
 * Шаг 3 плана и оценка интереса: черновик и оценка идут параллельно (третий вызов не ждёт первого), на ответ
 * уходит по одному вызову каждого. Сбой оценки не останавливает ответ: исключение превращается в сбой
 * unavailable с предупреждением в лог. Исключение черновика уходит наружу (его пишет в лог pipeline/batcher.ts),
 * но только после того, как завершится и вторая попытка: висящих промисов не остаётся.
 */
export async function requestDraft(
  deps: Pick<ReplyFlowDeps, 'agent' | 'logger'>,
  context: ConversationContext,
): Promise<Drafted> {
  const [draft, assessment] = await Promise.allSettled([
    call(() => deps.agent.draftReply(context)),
    call(() => deps.agent.assessInterest(context)),
  ]);
  if (draft.status === 'rejected') throw draft.reason;
  return {
    draft: draft.value,
    assessment: settledAssessment(deps.logger, context.chatId, assessment),
  };
}

/**
 * Шаги 4 и 5 плана и развилка. Оценка интереса сохраняется первой, до любой передачи: уровень и выжимка нужны
 * менеджеру в уведомлении (chats.saveAssessment, уровень и выжимка одной транзакцией). Исчерпан дневной лимит API
 * на черновике или на оценке => limit. Дальше черновик проходит попытку: сбой LLM => llm_error (fail-closed);
 * исходы no_answer, asked_human, complaint => передача по своей причине; answer => normalizeDraft, проверки кодом
 * (checks/code-checks.runCodeChecks), второй вызов agent.reviewDraft (только если проверки кодом пройдены), затем
 * pipeline/decide.decideAction: проверяется и уходит один и тот же нормализованный текст. Не прошёл: один повтор
 * agent.draftReply с замечаниями (оценка заново не запрашивается), второй провал => check_failed. Вызовов API на
 * ответ три (черновик, оценка, проверка), с повтором пять. В лог только ID чата, номер попытки, виды нарушений
 * (CheckCode) и числа: фрагменты текста клиента и модели в нём недопустимы.
 */
export async function decideReply(
  deps: ReplyFlowDeps,
  context: ConversationContext,
  drafted: Drafted,
): Promise<ReplyVerdict> {
  const assessment = keepAssessment(deps, context.chatId, drafted.assessment);
  const scope = budgetScopeOf([drafted.draft, drafted.assessment]);
  if (scope !== null) return { kind: 'limit', scope };
  const flow: Flow = { deps, context, assessment };
  const first = await judge(flow, drafted.draft, 1);
  if (first.kind === 'verdict') return first.verdict;
  const retried = await call(() => deps.agent.draftReply(context, first.feedback));
  const second = await judge(flow, retried, 2);
  // По правилу decideAction на попытке 2 повтора нет; если он всё же придёт, текст без проверки не уходит.
  return second.kind === 'verdict' ? second.verdict : CHECK_FAILED;
}

/** Вызов, упавший исключением сразу (заготовка, сбой до первого await), становится отказом промиса. */
function call<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(work());
  });
}

function settledAssessment(
  logger: Logger,
  chatId: ChatId,
  settled: PromiseSettledResult<LlmResult<InterestAssessment>>,
): LlmResult<InterestAssessment> {
  if (settled.status === 'fulfilled') return settled.value;
  logger.warn(
    { chatId, errorName: errorNameOf(settled.reason) },
    `Оценка интереса упала исключением: чат #${chatId}`,
  );
  return UNAVAILABLE;
}

function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Записывает оценку (уровень и выжимка) и отдаёт её решению; сбой оценки: предупреждение и null. */
function keepAssessment(
  deps: ReplyFlowDeps,
  chatId: ChatId,
  result: LlmResult<InterestAssessment>,
): InterestAssessment | null {
  if (result.ok) {
    deps.chats.saveAssessment(chatId, result.value, deps.clock.now());
    return result.value;
  }
  if (result.failure !== 'budget_exceeded') {
    deps.logger.warn(
      { chatId, failure: result.failure },
      `Оценка интереса не получена, ответ идёт без неё: чат #${chatId}`,
    );
  }
  return null;
}

/** Какой дневной лимит исчерпан у первого из вызовов, если исчерпан; черновик проверяется раньше оценки. */
function budgetScopeOf(results: readonly LlmResult<unknown>[]): BudgetScope | null {
  for (const result of results) {
    if (!result.ok && result.failure === 'budget_exceeded') return result.scope;
  }
  return null;
}

/** Одна попытка: разбор ответа модели, проверки черновика и решение. */
async function judge(
  flow: Flow,
  draft: LlmResult<ReplyDraft>,
  attempt: Attempt,
): Promise<Judgement> {
  if (!draft.ok) return verdictOf(failureVerdict(flow, 'Черновик ответа не получен', draft));
  const reply = draft.value;
  if (reply.outcome !== 'answer') {
    const input = { kind: 'handoff_outcome', draft: reply, assessment: flow.assessment } as const;
    return judgementOf(decideAction(input));
  }
  const checked = await checkDraft(flow, reply.text, attempt);
  if (checked.kind === 'failed') return verdictOf(checked.verdict);
  return judgementOf(
    decideAction({
      kind: 'answer',
      draft: { outcome: 'answer', text: checked.text },
      gate: checked.gate,
      attempt,
      assessment: flow.assessment,
    }),
  );
}

/**
 * Нормализация, проверки кодом и, если они пройдены, ревью вторым вызовом. Дальше идёт только нормализованный текст:
 * тот же, что проверен, уходит клиенту.
 */
async function checkDraft(flow: Flow, text: string, attempt: Attempt): Promise<Checked> {
  const { deps, context } = flow;
  const normalized = normalizeDraft(text);
  const codeGate = codeGateOf(flow, normalized, attempt);
  if (codeGate !== null) return { kind: 'checked', text: normalized, gate: codeGate };
  const review = await call(() => deps.agent.reviewDraft(context, normalized));
  if (!review.ok) {
    return {
      kind: 'failed',
      verdict: failureVerdict(flow, 'Проверка черновика не получена', review),
    };
  }
  if (!review.value.ok) {
    deps.logger.info(
      { chatId: context.chatId, attempt, problems: review.value.problems.length },
      `Проверка не пропустила черновик: чат #${context.chatId}`,
    );
  }
  return { kind: 'checked', text: normalized, gate: { kind: 'reviewed', review: review.value } };
}

/** Нарушения проверок кодом или null, если их нет. В лог идут только виды нарушений. */
function codeGateOf(
  flow: Flow,
  text: NormalizedText,
  attempt: Attempt,
): Extract<DraftGate, { readonly kind: 'code_failed' }> | null {
  const { deps, context } = flow;
  const clientText = clientTextOf(context.history);
  const [first, ...rest] = runCodeChecks(text, { ownPhone: NO_OWN_PHONE, clientText });
  if (first === undefined) return null;
  const findings = [first, ...rest] as const;
  const codes = [...new Set(findings.map((finding) => finding.code))];
  deps.logger.info(
    { chatId: context.chatId, attempt, codes },
    `Черновик не прошёл проверки кодом: чат #${context.chatId}`,
  );
  return { kind: 'code_failed', findings };
}

/** Слова клиента из окна истории: технические термины, которые он написал сам, в ответе разрешены. */
function clientTextOf(history: readonly StoredMessage[]): string {
  return history
    .flatMap((message) =>
      message.author === 'client' && message.text !== null ? [message.text] : [],
    )
    .join('\n');
}

/** Сбой вызова LLM: исчерпанный лимит => limit, любой другой => передача llm_error с фразой (fail-closed). */
function failureVerdict(flow: Flow, what: string, failed: LlmFailed): ReplyVerdict {
  if (failed.failure === 'budget_exceeded') return { kind: 'limit', scope: failed.scope };
  const { chatId } = flow.context;
  flow.deps.logger.warn(
    { chatId, failure: failed.failure },
    `${what}, чат передаётся менеджеру: чат #${chatId}`,
  );
  return { kind: 'handoff', notice: { reason: 'llm_error' } };
}

function verdictOf(verdict: ReplyVerdict): Judgement {
  return { kind: 'verdict', verdict };
}

function judgementOf(decision: Decision): Judgement {
  switch (decision.kind) {
    case 'send':
      return verdictOf({ kind: 'send', text: decision.text });
    case 'retry':
      return { kind: 'retry', feedback: decision.feedback };
    case 'handoff':
      return verdictOf({ kind: 'handoff', notice: noticeOf(decision) });
  }
}

function noticeOf(decision: Extract<Decision, { readonly kind: 'handoff' }>): HandoffNotice {
  return decision.reason === 'complaint'
    ? { reason: 'complaint', stopRequested: decision.stopRequested }
    : { reason: decision.reason };
}
