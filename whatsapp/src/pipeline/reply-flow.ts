import type { Agent, ConversationContext, DraftKind } from '../agent/agent.js';
import { normalizeDraft, runCodeChecks } from '../checks/code-checks.js';
import type { CompanyPrompt, CompanyQuestion } from '../domain/company.js';
import type { ChatsRepo, Clock, Logger, RejectedDraftsRepo } from '../domain/ports.js';
import type {
  BudgetScope,
  ChatId,
  ChatProgress,
  HandoffNotice,
  InterestAssessment,
  LlmResult,
  NormalizedText,
  PhoneDigits,
  RejectionSource,
  ReplyDraft,
  ReplyHandoffOutcome,
  ReplyMarks,
  ReviewedText,
  StoredMessage,
  StrengthId,
  TurnSignals,
} from '../domain/types.js';
import { HANDOFF_TEXT, HOT_PRICE_HANDOFF_TEXT } from '../messaging/outbox.js';
import { answerPartOf, clientAsksNow } from './answer-part.js';
import { decideAction, type Decision, type DraftGate, type TextDraft } from './decide.js';
import {
  earlyHotFallback,
  earlyHotRemark,
  hotKindOf,
  turnSituation,
  type HotKind,
  type TurnSituation,
} from './handoff-gate.js';
import { nextSafeQuestion } from './safe-questions.js';

/** Что нужно ходу ответа от остальной системы: агент, запись оценки интереса, часы и лог. */
export interface ReplyFlowDeps {
  readonly chats: Pick<ChatsRepo, 'saveAssessment'>;
  readonly agent: Pick<Agent, 'draftReply' | 'reviewDraft' | 'assessInterest'>;
  readonly clock: Pick<Clock, 'now'>;
  readonly logger: Logger;
  /**
   * Отклонённые черновики для панели (пункт 7 задания 29.10.2026): черновик и замечания каждой не пройденной проверки.
   * Нет поля => не сохраняются (тесты конвейера без базы).
   */
  readonly rejectedDrafts?: Pick<RejectedDraftsRepo, 'add'>;
}

/** Ответы двух параллельных вызовов LLM: черновик и оценка интереса. Сбой приходит значением. */
export interface Drafted {
  readonly draft: LlmResult<ReplyDraft>;
  readonly assessment: LlmResult<InterestAssessment>;
}

/**
 * Передача менеджеру. Без text клиенту уходит фиксированная фраза по причине (в том числе при сбое LLM и после
 * отказа от текста модели). С text клиенту уходит сообщение модели, прошедшее проверки кодом и второй вызов:
 * только при hot, no_answer, asked_human.
 */
export type HandoffVerdict =
  | { readonly kind: 'handoff'; readonly notice: HandoffNotice }
  | {
      readonly kind: 'handoff';
      readonly notice: { readonly reason: ReplyHandoffOutcome };
      readonly text: ReviewedText;
    };

/**
 * Ответ клиенту: проверенный текст и вопрос о компании из того черновика answer, чей текст уходит (нет поля => ни о
 * чём). Вопрос запоминается только после отправки: каждый задаётся один раз. signals: клиент в этом ходе спросил цену
 * или отказался отвечать (нет поля => ни того ни другого); записывается тоже только после отправки (chats.recordTurn).
 * marks: этап и сильные стороны черновика answer, чей текст уходит (решение владельца 30.10.2026); только у текста
 * модели, у фиксированных фраз и безопасных вопросов поля нет. Записывается после отправки (chats.recordReply).
 */
export interface SendVerdict {
  readonly kind: 'send';
  readonly text: ReviewedText;
  readonly companyQuestion?: CompanyQuestion;
  readonly signals?: TurnSignals;
  readonly marks?: ReplyMarks;
}

/**
 * Что делать с чатом по итогам хода: отправить проверенный текст, передать менеджеру (с проверенным сообщением
 * модели или с фиксированной фразой) или замолчать из-за исчерпанного дневного лимита API.
 */
export type ReplyVerdict =
  SendVerdict | HandoffVerdict | { readonly kind: 'limit'; readonly scope: BudgetScope };

/**
 * Своего номера в ответах у бота нет: knowledge/whatsapp.md запрещает вставлять номер WhatsApp. Пустой «наш номер»
 * не равен ни одному номеру из текста, поэтому checks/code-checks.checkContacts отклоняет любой номер телефона.
 * Служебное значение на границе бренда PhoneDigits, настоящим номером оно не является.
 */
const NO_OWN_PHONE = '' as PhoneDigits;

const UNAVAILABLE: LlmResult<never> = { ok: false, failure: 'unavailable' };

/** Второй провал проверок ответа: текст без ревью не уходит никогда. */
const CHECK_FAILED: ReplyVerdict = { kind: 'handoff', notice: { reason: 'check_failed' } };

/** Сбой LLM там, где причины передачи ещё нет: fail-closed, клиенту уходит нейтральная фраза. */
const LLM_ERROR: ReplyVerdict = { kind: 'handoff', notice: { reason: 'llm_error' } };

/**
 * Вопрос цены, сроков или договора при понятной задаче или третий вопрос цены: передача hot с фразой «Я уточню у коллеги
 * решение и ориентир под вашу задачу.» (решение владельца 30.10.2026, outbox по HandoffNotice.aboutPrice).
 */
const PRICE_HANDOFF: ReplyVerdict = {
  kind: 'handoff',
  notice: { reason: 'hot', aboutPrice: true },
};

/** Два ухода от вопросов подряд: передача hot с фразой «Уточню у коллеги и вернусь к вам.». */
const REFUSED_HANDOFF: ReplyVerdict = { kind: 'handoff', notice: { reason: 'hot' } };

/** Фраза финала: как и фиксированные вопросы, проходит проверки кодом (это проверяют тесты). */
const SOLUTION_TEXT = HOT_PRICE_HANDOFF_TEXT as ReviewedText;

/** Причина записи уровня hot, когда его назначила не оценка интереса, а вызов ответа. */
const HOT_BY_REPLY =
  'Вызов ответа определил клиента как горячего: он спрашивает цену, сроки или договор.';

type LlmFailed = Extract<LlmResult<unknown>, { readonly ok: false }>;
type Attempt = 1 | 2;

/**
 * Всё, что нужно одной попытке: зависимости, разговор (с ним идут проверки), разговор для повтора черновика (с выжимкой
 * из оценки этого хода, если она есть) и что код знает о ходе для решения о передаче (pipeline/handoff-gate.ts).
 */
interface Flow {
  readonly deps: ReplyFlowDeps;
  readonly context: ConversationContext;
  readonly retryContext: ConversationContext;
  readonly gate: TurnSituation;
}

/**
 * Итог одной попытки: решение принято или нужен повтор черновика с замечаниями. keep: решение, которое остаётся,
 * если повтор не удастся из-за сбоя LLM. У исхода передачи это та же передача с фиксированной фразой (причину
 * решила модель, сбой её не отменяет), у ответа null: тогда сбой даёт llm_error.
 */
type Judgement =
  | { readonly kind: 'verdict'; readonly verdict: ReplyVerdict }
  | {
      readonly kind: 'retry';
      readonly feedback: readonly string[];
      readonly keep: ReplyVerdict | null;
      /**
       * Повтор после раннего hot: если и он не прошёл проверки, уходит этот фиксированный вопрос, а не передача
       * check_failed.
       */
      readonly fallback?: SendVerdict;
    };

/**
 * Итог проверок текста черновика: пройдены кодом или вторым вызовом, либо второй вызов не дал результата.
 * Дальше идёт только нормализованный текст: тот же, что проверен, уходит клиенту.
 */
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
 * Только оценка интереса: ход, в котором бот ждёт ответа на «Вы из компании X?», получает её до черновика. Сбой и
 * исключение как в requestDraft: исключение становится сбоем unavailable с предупреждением в лог.
 */
export async function requestAssessment(
  deps: Pick<ReplyFlowDeps, 'agent' | 'logger'>,
  context: ConversationContext,
): Promise<LlmResult<InterestAssessment>> {
  const [assessment] = await Promise.allSettled([call(() => deps.agent.assessInterest(context))]);
  return settledAssessment(deps.logger, context.chatId, assessment);
}

/**
 * Шаги 4 и 5 плана и развилка. Оценка интереса сохраняется первой, до любой передачи: уровень и выжимка нужны
 * менеджеру в уведомлении (chats.saveAssessment, уровень и выжимка одной транзакцией). Исчерпан дневной лимит API на
 * черновике или на оценке => limit. Дальше черновик проходит попытку: сбой LLM => llm_error (fail-closed); complaint =>
 * передача с фиксированной фразой; answer, hot, no_answer и asked_human с текстом => normalizeDraft, проверки кодом
 * (checks/code-checks.runCodeChecks; название компании клиента из блока о компании в капслоке, ссылках, тире и подмене
 * букв не нарушение), второй вызов agent.reviewDraft (только если проверки кодом пройдены; у hot, no_answer и
 * asked_human с подписью «сообщение о передаче»), затем pipeline/decide.decideAction: проверяется и уходит один и тот же
 * нормализованный текст. Не прошёл: один повтор agent.draftReply с замечаниями (оценка заново не запрашивается). Второй
 * провал: для answer безопасный вопрос (afterCheckFailed), для исхода передачи та же причина и фиксированная фраза. Сбой
 * LLM при проверке или повторе исхода передачи тоже оставляет причину и фиксированную фразу; исчерпанный лимит API даёт
 * limit. Исход передачи с пустым text (или из одних невидимых символов) проверок не проходит: фиксированная фраза по
 * причине. В лог только ID чата, номер попытки, виды нарушений (CheckCode), причина передачи и числа: фрагменты текста
 * клиента и модели в нём недопустимы. context тот же, с которым писался черновик: проверка судит с теми же данными о
 * компании. Вердикт send несёт companyQuestion черновика answer, чей текст уходит (после повтора: повторного черновика).
 * Когда чат уходит коллеге с исходом hot (решение владельца 30.10.2026, pipeline/handoff-gate.ts, по выжимке после оценки
 * этого хода): третий вопрос цены, вопрос цены, сроков или договора при понятной задаче, два ухода от вопросов подряд,
 * финал (для расчёта известно всё). Исход hot модели без такой причины ранний: один повтор черновика с замечанием
 * (earlyHotRemark); повтор снова hot, не получился или не прошёл проверки => готовый вопрос о первом недостающем для
 * расчёта (earlyHotFallback), чат остаётся у бота. Модель ответила answer, а причина есть (кроме финала) => код сам
 * передаёт чат (codeHandoff). Фиксированная фраза hot по причине (withHotPhrase): финал и цена с фразой «Я уточню у
 * коллеги решение и ориентир под вашу задачу.», уходы от вопросов с «Уточню у коллеги и вернусь к вам.». При передаче
 * hot уровень hot записывается в чат (оценка интереса могла дать ниже или не получиться). Вызовов API на ответ три
 * (черновик, оценка, проверка), с повтором пять. Вердикт send несёт сигналы хода (вопрос цены, отказ отвечать), если они
 * меняют ход разговора: конвейер записывает их после отправки.
 */
export async function decideReply(
  deps: ReplyFlowDeps,
  context: ConversationContext,
  drafted: Drafted,
): Promise<ReplyVerdict> {
  const assessment = keepAssessment(deps, context.chatId, drafted.assessment);
  const scope = budgetScopeOf([drafted.draft, drafted.assessment]);
  if (scope !== null) return { kind: 'limit', scope };
  const gate = turnSituation(context, assessment, drafted.draft);
  const retryContext = assessment === null ? context : { ...context, profile: assessment.profile };
  const flow: Flow = { deps, context, retryContext, gate };
  const first = await judgeResult(flow, drafted.draft, 1, null);
  const judged = first.kind === 'verdict' ? first.verdict : await retryOnce(flow, first);
  const verdict = withHotPhrase(gate, isCheckFailed(judged) ? afterCheckFailed(flow) : judged);
  if (isHotHandoff(verdict)) markHot(deps, context, assessment);
  return withSignals(verdict, gate.signals, context.progress);
}

/**
 * Передача hot без текста модели: фиксированная фраза по причине (решение владельца 30.10.2026). Финал: «Я уточню у
 * коллеги решение и ориентир под вашу задачу.» текстом; вопрос цены: та же фраза через outbox (aboutPrice); уходы от
 * вопросов: «Уточню у коллеги и вернусь к вам.».
 */
function withHotPhrase(gate: TurnSituation, verdict: ReplyVerdict): ReplyVerdict {
  if (verdict.kind !== 'handoff' || 'text' in verdict || verdict.notice.reason !== 'hot') {
    return verdict;
  }
  switch (hotKindOf(gate)) {
    case 'final':
      return { kind: 'handoff', notice: { reason: 'hot' }, text: SOLUTION_TEXT };
    case 'price':
    case 'price_third':
      return PRICE_HANDOFF;
    case 'refused':
      return REFUSED_HANDOFF;
    case null:
      return verdict;
  }
}

/**
 * Ответ дважды не прошёл проверки (пункт 2 задания 29.10.2026): чат не уходит менеджеру. Один открытый вопрос по
 * рекомендуемому этапу и первому недостающему для расчёта, который бот ещё не задавал в чате (решение владельца
 * 30.10.2026, safe-questions.nextSafeQuestion: выжимка этого хода, этап последнего ответа, передавался ли чат, все
 * прошлые ответы бота в окне истории); при вопросе цены перед ним фраза об ориентире. Спросить нечего => check_failed.
 * В лог только ID чата и код вопроса.
 */
function afterCheckFailed(flow: Flow): ReplyVerdict {
  const { context, gate, deps } = flow;
  const { chatId } = context;
  const question = nextSafeQuestion(
    {
      profile: gate.profile,
      companyAskable: gate.companyAskable,
      lastBotText: lastBotTextOf(context.history),
      botTexts: botTextsOf(context.history),
      lastStage: context.progress?.lastStage ?? null,
      handedOff: context.progress?.handedOff === true || context.note != null,
    },
    gate.signals.priceAsked,
  );
  if (question === null) {
    deps.logger.info(
      { chatId },
      `Черновик дважды не прошёл проверки, спросить нечего: чат #${chatId}`,
    );
    return CHECK_FAILED;
  }
  const { key, text, companyQuestion } = question;
  deps.logger.info(
    { chatId, question: key, aboutPrice: gate.signals.priceAsked },
    `Черновик дважды не прошёл проверки, клиенту уходит безопасный вопрос: чат #${chatId}`,
  );
  return companyQuestion === undefined
    ? { kind: 'send', text }
    : { kind: 'send', text, companyQuestion };
}

/** Последнее сообщение бота клиенту в окне истории; нет => null. */
function lastBotTextOf(history: readonly StoredMessage[]): string | null {
  const sorted = [...history].sort((a, b) => a.tsMs - b.tsMs || a.id - b.id);
  return sorted.findLast((message) => message.author === 'bot')?.text ?? null;
}

/** Тексты всех сообщений бота клиенту в окне истории: по ним видно, о чём бот уже спрашивал. */
function botTextsOf(history: readonly StoredMessage[]): readonly string[] {
  return history.flatMap((message) =>
    message.author === 'bot' && message.text !== null ? [message.text] : [],
  );
}

/**
 * Ответ уходит: сигналы хода идут с ним, если клиент спросил цену или отказался отвечать, а также если он уходил от
 * вопросов прошлым ходом (ход без отказа обнуляет счёт уходов подряд).
 */
function withSignals(
  verdict: ReplyVerdict,
  signals: TurnSignals,
  progress: ChatProgress | undefined,
): ReplyVerdict {
  if (verdict.kind !== 'send') return verdict;
  const streak = progress?.refusedStreak ?? 0;
  if (!signals.priceAsked && !signals.refused && streak === 0) return verdict;
  return { ...verdict, signals };
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

/** Записывает оценку (уровень и выжимка); сбой оценки: предупреждение и null. */
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

function isHotHandoff(verdict: ReplyVerdict): boolean {
  return verdict.kind === 'handoff' && verdict.notice.reason === 'hot';
}

/**
 * Передача hot: уровень hot должен стоять и в передаче, и в чате. Оценка интереса могла дать ниже или не
 * получиться, поэтому уровень дописывается тут, с выжимкой оценки или, если её нет, с текущей выжимкой чата.
 * Передача читает уровень из чата, так что запись нужна до неё.
 */
function markHot(
  deps: ReplyFlowDeps,
  context: ConversationContext,
  assessment: InterestAssessment | null,
): void {
  if (assessment?.level === 'hot') return;
  deps.chats.saveAssessment(
    context.chatId,
    { level: 'hot', profile: assessment?.profile ?? context.profile, reason: HOT_BY_REPLY },
    deps.clock.now(),
  );
}

/**
 * Один повтор черновика с замечаниями (оценка заново не запрашивается). Сбой повтора оставляет прежнее решение
 * исхода передачи (retry.keep) или даёт llm_error. Второй повтор невозможен по правилу decideAction; если он всё же
 * придёт, текст без проверки не уходит.
 */
async function retryOnce(
  flow: Flow,
  retry: Extract<Judgement, { readonly kind: 'retry' }>,
): Promise<ReplyVerdict> {
  const retried = await call(() => flow.deps.agent.draftReply(flow.retryContext, retry.feedback));
  const second = await judgeResult(flow, retried, 2, retry.keep);
  const verdict = second.kind === 'verdict' ? second.verdict : (second.keep ?? CHECK_FAILED);
  return retry.fallback !== undefined && isCheckFailed(verdict) ? retry.fallback : verdict;
}

function isCheckFailed(verdict: ReplyVerdict): boolean {
  return verdict.kind === 'handoff' && verdict.notice.reason === 'check_failed';
}

/** Ответ вызова черновика: сбой LLM даёт решение сразу (keep или llm_error), иначе разбор черновика. */
async function judgeResult(
  flow: Flow,
  result: LlmResult<ReplyDraft>,
  attempt: Attempt,
  keep: ReplyVerdict | null,
): Promise<Judgement> {
  if (!result.ok) {
    return verdictOf(failureVerdict(flow, 'Черновик ответа не получен', result, keep));
  }
  return judge(flow, result.value, attempt);
}

/**
 * Одна попытка: complaint и исход передачи без текста решаются сразу; текст (answer или сообщение передачи)
 * нормализуется, проверяется кодом и вторым вызовом, затем решение decideAction.
 */
async function judge(flow: Flow, draft: ReplyDraft, attempt: Attempt): Promise<Judgement> {
  if (draft.outcome === 'complaint') {
    return judgementOf(decideAction({ kind: 'handoff_outcome', draft }), null);
  }
  const hot = hotKindOf(flow.gate);
  if (draft.outcome === 'hot' && hot === null) return early(flow, attempt);
  if (draft.outcome === 'answer' && hot !== null && hot !== 'final') {
    return codeHandoff(flow, draft, attempt, hot);
  }
  const text = normalizeDraft(draft.text);
  const keep = keepOf(draft);
  if (draft.outcome !== 'answer' && text.trim() === '') {
    const empty = { ...draft, text: '' };
    return judgementOf(decideAction({ kind: 'handoff_outcome', draft: empty }), keep);
  }
  // Повтор сильной стороны проверяется только у ответа: сообщение о передаче её не рассказывает.
  const usedFacts = draft.outcome === 'answer' ? draft.usedFacts : undefined;
  const checked = await checkDraft(flow, draft.outcome, text, attempt, keep, usedFacts);
  if (checked.kind === 'failed') return verdictOf(checked.verdict);
  const decision = decideAction({
    kind: 'text',
    draft: { ...draft, text: checked.text },
    gate: checked.gate,
    attempt,
  });
  logDroppedText(flow, draft, decision);
  if (draft.outcome !== 'answer') return judgementOf(decision, keep);
  return judgementOf(decision, keep, draft.companyQuestion, marksOf(draft));
}

/**
 * Этап и сильные стороны черновика answer для записи после отправки; черновик не назвал ни того ни другого (подделки
 * LLM в тестах) => отметок нет.
 */
function marksOf(
  draft: Extract<ReplyDraft, { readonly outcome: 'answer' }>,
): ReplyMarks | undefined {
  if (draft.stage === undefined && (draft.usedFacts ?? []).length === 0) return undefined;
  return { stage: draft.stage ?? null, usedFacts: draft.usedFacts ?? [] };
}

/**
 * Ранний hot (pipeline/handoff-gate.ts): попытка 1 => повтор с замечанием (earlyHotRemark; keep и fallback: готовый вопрос
 * о первом недостающем для расчёта), попытка 2 => сразу этот вопрос. Текст hot не проверяется: он не уйдёт. В лог только
 * коды полей и числа.
 */
function early(flow: Flow, attempt: Attempt): Judgement {
  const { chatId } = flow.context;
  const { missing, priceAsks, signals } = flow.gate;
  flow.deps.logger.info(
    { chatId, attempt, missing: [...missing], priceAsks, aboutPrice: signals.priceAsked },
    `Передача рано: задача не понятна или для расчёта известно не всё, чат остаётся у бота: чат #${chatId}`,
  );
  const fallback = fallbackVerdict(flow);
  if (attempt === 2) return verdictOf(fallback);
  return { kind: 'retry', feedback: [earlyHotRemark(flow.gate)], keep: fallback, fallback };
}

function fallbackVerdict(flow: Flow): SendVerdict {
  const { text, companyQuestion } = earlyHotFallback(flow.gate, botTextsOf(flow.context.history));
  return companyQuestion === undefined
    ? { kind: 'send', text }
    : { kind: 'send', text, companyQuestion };
}

/**
 * Модель ответила answer, а чат по правилу владельца уходит коллеге (решение 30.10.2026): при вопросе цены (третий раз
 * или при понятной задаче) фиксированная фраза о решении и ориентире, текст модели не нужен. При двух уходах от вопросов
 * подряд «Уточню у коллеги и вернусь к вам.», а перед ней ответ из черновика, если клиент что-то спросил и это не ход с
 * вопросом цены (answerPartOf); такое сообщение проходит проверки кодом и проверку с подписью «сообщение о передаче» без
 * повтора, не прошло или ответа нет => только фраза. В лог ID чата, причина и числа.
 */
async function codeHandoff(
  flow: Flow,
  draft: Extract<ReplyDraft, { readonly outcome: 'answer' }>,
  attempt: Attempt,
  why: Exclude<HotKind, 'final'>,
): Promise<Judgement> {
  const { chatId, history } = flow.context;
  const { priceAsks, refusedStreak, signals } = flow.gate;
  flow.deps.logger.info(
    { chatId, hot: why, priceAsks, refusedStreak },
    `${CODE_HANDOFF_TEXT[why]}: чат передаётся менеджеру: чат #${chatId}`,
  );
  if (why !== 'refused') return verdictOf(PRICE_HANDOFF);
  // На вопрос цены ответ из черновика не берётся: в нём остаются пересказ слов клиента и обрывки (живой прогон 29.10.2026).
  const part =
    !signals.priceAsked && clientAsksNow(history) ? answerPartOf(normalizeDraft(draft.text)) : null;
  if (part === null) return verdictOf(REFUSED_HANDOFF);
  const text = normalizeDraft(`${part} ${HANDOFF_TEXT}`);
  const checked = await checkDraft(flow, 'hot', text, attempt, REFUSED_HANDOFF);
  if (checked.kind === 'failed') return verdictOf(checked.verdict);
  const hot: TextDraft = { outcome: 'hot', text: checked.text };
  // Без повтора: не прошло => передача hot без текста, фраза «Уточню у коллеги и вернусь к вам.».
  const decision = decideAction({ kind: 'text', draft: hot, gate: checked.gate, attempt: 2 });
  return judgementOf(decision, REFUSED_HANDOFF);
}

const CODE_HANDOFF_TEXT: Readonly<Record<Exclude<HotKind, 'final'>, string>> = {
  price_third: 'Третий вопрос цены',
  price: 'Вопрос цены при понятной задаче',
  refused: 'Клиент дважды подряд уходит от вопросов',
};

/**
 * Решение исхода передачи, если вызов проверки не получился: та же передача с фиксированной фразой (у hot после
 * вопроса цены фраза о цене).
 */
function keepOf(draft: TextDraft): ReplyVerdict | null {
  if (draft.outcome === 'answer') return null;
  return { kind: 'handoff', notice: replyNotice(draft.outcome, draft.aboutPrice) };
}

/** Повод передачи по исходу ответа; aboutPrice остаётся только у hot (фраза о цене) и только если true. */
function replyNotice(reason: ReplyHandoffOutcome, aboutPrice: boolean | undefined): HandoffNotice {
  return reason === 'hot' && aboutPrice === true ? { reason, aboutPrice } : { reason };
}

/** Текст модели при исходе передачи не прошёл проверки: пишется причина, клиенту уйдёт фиксированная фраза. */
function logDroppedText(flow: Flow, draft: TextDraft, decision: Decision): void {
  if (draft.outcome === 'answer' || decision.kind !== 'handoff' || 'text' in decision) return;
  const { chatId } = flow.context;
  flow.deps.logger.info(
    { chatId, reason: draft.outcome },
    `Сообщение передачи не прошло проверки, клиенту уйдёт фиксированная фраза: чат #${chatId}`,
  );
}

/**
 * Нормализованный текст проходит проверки кодом и, если они пройдены, ревью вторым вызовом. Для исхода передачи
 * ревью получает подпись «сообщение о передаче», для ответа обычную. Сбой ревью оставляет keep (или llm_error).
 */
async function checkDraft(
  flow: Flow,
  outcome: TextDraft['outcome'],
  text: NormalizedText,
  attempt: Attempt,
  keep: ReplyVerdict | null,
  usedFacts?: readonly StrengthId[],
): Promise<Checked> {
  const { deps, context } = flow;
  const codeGate = codeGateOf(flow, text, attempt, usedFacts);
  if (codeGate !== null) {
    const remarks = codeGate.findings.map((finding) => finding.detail);
    recordRejection(flow, { attempt, source: 'code', draft: text, remarks });
    return { kind: 'checked', text, gate: codeGate };
  }
  const kind: DraftKind = outcome === 'answer' ? 'answer' : 'handoff';
  const review = await call(() => deps.agent.reviewDraft(context, text, kind));
  if (!review.ok) {
    const verdict = failureVerdict(flow, 'Проверка черновика не получена', review, keep);
    return { kind: 'failed', verdict };
  }
  if (!review.value.ok) {
    deps.logger.info(
      { chatId: context.chatId, attempt, problems: review.value.problems.length },
      `Проверка не пропустила черновик: чат #${context.chatId}`,
    );
    const remarks = [...review.value.problems];
    recordRejection(flow, { attempt, source: 'review', draft: text, remarks });
  }
  return { kind: 'checked', text, gate: { kind: 'reviewed', review: review.value } };
}

interface Rejection {
  readonly attempt: Attempt;
  readonly source: RejectionSource;
  readonly draft: string;
  readonly remarks: readonly string[];
}

/**
 * Отклонённый черновик и замечания проверки в базу для панели. Сбой записи не мешает ответу: предупреждение только с
 * ID чата, попыткой и именем ошибки, без текстов.
 */
function recordRejection(flow: Flow, rejection: Rejection): void {
  const { deps, context } = flow;
  if (deps.rejectedDrafts === undefined) return;
  try {
    deps.rejectedDrafts.add({ chatId: context.chatId, ...rejection, atMs: deps.clock.now() });
  } catch (error: unknown) {
    deps.logger.warn(
      { chatId: context.chatId, attempt: rejection.attempt, errorName: errorNameOf(error) },
      `Отклонённый черновик не сохранён: чат #${context.chatId}`,
    );
  }
}

/**
 * Нарушения проверок кодом или null, если их нет. Цена и обещание допустимы, только если они есть в заметке для бота
 * (указание коллеги, context.note). С номерами сильных сторон черновика (usedFacts) проверяется и повтор уже
 * рассказанного в чате (context.progress.toldFacts). В лог идут только виды нарушений.
 */
function codeGateOf(
  flow: Flow,
  text: NormalizedText,
  attempt: Attempt,
  usedFacts: readonly StrengthId[] | undefined,
): Extract<DraftGate, { readonly kind: 'code_failed' }> | null {
  const { deps, context } = flow;
  const clientText = clientTextOf(context.history);
  const companyName = companyNameOf(context.company);
  const note = context.note?.text ?? null;
  const facts =
    usedFacts === undefined ? {} : { usedFacts, toldFacts: context.progress?.toldFacts ?? [] };
  const [first, ...rest] = runCodeChecks(text, {
    ownPhone: NO_OWN_PHONE,
    clientText,
    companyName,
    note,
    priceTurn: flow.gate.signals.priceAsked,
    ...facts,
  });
  if (first === undefined) return null;
  const findings = [first, ...rest] as const;
  const codes = [...new Set(findings.map((finding) => finding.code))];
  deps.logger.info(
    { chatId: context.chatId, attempt, codes },
    `Черновик не прошёл проверки кодом: чат #${context.chatId}`,
  );
  return { kind: 'code_failed', findings };
}

/**
 * Название компании клиента из блока о компании (кандидат, вопрос о нём задан, подтверждённая): в нём капслок,
 * ссылка, тире и подмена букв не нарушение. Иначе названия нет.
 */
function companyNameOf(company: CompanyPrompt | undefined): string | null {
  switch (company?.kind) {
    case 'candidate':
    case 'asked':
    case 'confirmed':
      return company.name;
    default:
      return null;
  }
}

/** Слова клиента из окна истории: технические термины, которые он написал сам, в ответе разрешены. */
function clientTextOf(history: readonly StoredMessage[]): string {
  return history
    .flatMap((message) =>
      message.author === 'client' && message.text !== null ? [message.text] : [],
    )
    .join('\n');
}

/**
 * Сбой вызова LLM: исчерпанный лимит => limit; иначе keep (исход передачи сохраняет причину и фиксированную фразу)
 * или llm_error с фразой (fail-closed).
 */
function failureVerdict(
  flow: Flow,
  what: string,
  failed: LlmFailed,
  keep: ReplyVerdict | null,
): ReplyVerdict {
  if (failed.failure === 'budget_exceeded') return { kind: 'limit', scope: failed.scope };
  const { chatId } = flow.context;
  flow.deps.logger.warn(
    { chatId, failure: failed.failure },
    `${what}, чат передаётся менеджеру: чат #${chatId}`,
  );
  return keep ?? LLM_ERROR;
}

function verdictOf(verdict: ReplyVerdict): Judgement {
  return { kind: 'verdict', verdict };
}

/**
 * Решение decideAction как итог попытки; question и marks: вопрос о компании и отметки (этап, сильные стороны) из
 * черновика answer, они идут с ответом.
 */
function judgementOf(
  decision: Decision,
  keep: ReplyVerdict | null,
  question?: CompanyQuestion,
  marks?: ReplyMarks,
): Judgement {
  switch (decision.kind) {
    case 'send':
      return verdictOf({
        kind: 'send',
        text: decision.text,
        ...(question === undefined ? {} : { companyQuestion: question }),
        ...(marks === undefined ? {} : { marks }),
      });
    case 'retry':
      return { kind: 'retry', feedback: decision.feedback, keep };
    case 'handoff':
      return verdictOf(handoffOf(decision));
  }
}

function handoffOf(decision: Extract<Decision, { readonly kind: 'handoff' }>): HandoffVerdict {
  if (decision.reason === 'complaint') {
    return {
      kind: 'handoff',
      notice: { reason: 'complaint', stopRequested: decision.stopRequested },
    };
  }
  if (decision.reason === 'check_failed') {
    return { kind: 'handoff', notice: { reason: 'check_failed' } };
  }
  if (decision.text !== undefined) {
    return { kind: 'handoff', notice: { reason: decision.reason }, text: decision.text };
  }
  return { kind: 'handoff', notice: replyNotice(decision.reason, decision.aboutPrice) };
}
