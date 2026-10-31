import { HISTORY_MESSAGES, type Agent, type ConversationContext } from '../agent/agent.js';
import type { CompanyService } from '../domain/company.js';
import type {
  ChatsRepo,
  Clock,
  Logger,
  MessageSender,
  MessagesRepo,
  RejectedDraftsRepo,
  Transcriber,
  WhatsAppInbox,
} from '../domain/ports.js';
import type {
  BudgetScope,
  Chat,
  ChatId,
  HandoffReason,
  InboundMessage,
  PhoneDigits,
  WaMessageId,
} from '../domain/types.js';
import type { HandOffRequest, HandoffService } from '../handoff/handoff.js';
import { companyNameOf } from '../handoff/minimum.js';
import { isChatAllowlisted } from '../messaging/allowlist.js';
import type { Outbox, SendBlocked } from '../messaging/outbox.js';
import type { ClientBatch } from './batcher.js';
import { draftWithCompany } from './company-turn.js';
import {
  decideReply,
  type HandoffVerdict,
  type ReplyVerdict,
  type SendVerdict,
} from './reply-flow.js';
import { errorName, SEND_FAILED, sendWithRetry, typingPause } from './sending.js';
import { transcribeVoices } from './voices.js';

export { SEND_RETRY_DELAY_MS } from './sending.js';

/** Зависимости конвейера обработки сообщения. */
export interface PipelineDeps {
  readonly chats: Pick<
    ChatsRepo,
    | 'getById'
    | 'findByJid'
    | 'saveAssessment'
    | 'getProgress'
    | 'recordTurn'
    | 'recordReply'
    | 'getNote'
  >;
  readonly messages: Pick<
    MessagesRepo,
    'recent' | 'markAnswered' | 'setTranscript' | 'isUnansweredInbound'
  >;
  readonly agent: Pick<Agent, 'draftReply' | 'reviewDraft' | 'assessInterest'>;
  readonly outbox: Pick<Outbox, 'sendBotReply' | 'sendVoiceNotice'>;
  /**
   * Сервис передачи менеджеру (handoff/handoff.ts): статус manager, запись передачи, фраза клиенту с повтором
   * отправки и уведомление менеджеру. Конвейер его только вызывает и не оборачивает в повтор.
   */
  readonly handoff: Pick<HandoffService, 'handOff'>;
  /**
   * Определение компании клиента (src/company): блок о компании перед ответом, итог оценки интереса, заданный вопрос
   * о компании, поиск после ответа и сводка (название компании для минимума передачи по цене). Ни один метод не
   * бросает из-за API или WhatsApp.
   */
  readonly company: Pick<
    CompanyService,
    'prepare' | 'applyAssessment' | 'markAsked' | 'identifyAfterReply' | 'summary'
  >;
  readonly transcriber: Transcriber;
  readonly inbox: Pick<WhatsAppInbox, 'markRead' | 'downloadAudio'>;
  /** Статус «печатает»: outbox только отправляет, паузу перед ответом держит конвейер. */
  readonly typing: Pick<MessageSender, 'setTyping'>;
  /** Пауза «печатает» для текста ответа, мс (messaging/typing.ts). */
  typingDelayMs(text: string): number;
  /**
   * Закрытый режим: номера из TEST_ALLOWLIST; null, если режим выключен. Чат не из списка отсекается до оплачиваемых
   * вызовов API (то же правило, что у outbox).
   */
  readonly testAllowlist: ReadonlySet<PhoneDigits> | null;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Отклонённые черновики для панели (pipeline/reply-flow.ts); нет поля => не сохраняются. */
  readonly rejectedDrafts?: Pick<RejectedDraftsRepo, 'add'>;
}

/** Чем закончилась обработка пачки сообщений клиента. */
export type PipelineOutcome =
  | { readonly kind: 'replied' }
  | { readonly kind: 'voice_notice' }
  | {
      readonly kind: 'silent';
      readonly reason: 'manager_mode' | 'duplicate' | 'no_chat' | 'no_text';
    }
  | { readonly kind: 'blocked'; readonly reason: SendBlocked }
  | { readonly kind: 'handed_off'; readonly reason: HandoffReason }
  /** Сервис передачи не смог записать передачу (чата нет, сбой базы): ошибка в логе, клиент остался без ответа. */
  | { readonly kind: 'handoff_failed'; readonly reason: HandoffReason }
  /** Отправка упала исключением и после повтора: клиент остался без ответа (ошибка в логе). */
  | { readonly kind: 'send_failed' };

/**
 * Пачка старше этого к началу обработки пришла из офлайн-очереди (бот был выключен): живая пачка ждёт
 * не больше склейки и предыдущей пачки чата, это десятки секунд.
 */
const OFFLINE_BATCH_AGE_MS = 2 * 60_000;

const SILENT_MANAGER: PipelineOutcome = { kind: 'silent', reason: 'manager_mode' };
const SEND_FAILED_OUTCOME: PipelineOutcome = { kind: 'send_failed' };

/** Что уже сделано с пачкой: переходит в перегенерацию, чтобы не повторять расшифровку и фразы. */
interface Turn {
  readonly messages: readonly InboundMessage[];
  /** Расшифровки голосовых по waId. */
  readonly transcripts: ReadonlyMap<WaMessageId, string>;
  /** Голосовые без расшифровки: на них фраза про голосовое. */
  readonly unheard: ReadonlySet<WaMessageId>;
  /** Уже отмечены прочитанными. */
  readonly read: ReadonlySet<WaMessageId>;
  readonly voiceNoticeSent: boolean;
  /** Ответ уже перегенерирован из-за новых сообщений: второй раз не перегенерируется. */
  readonly regenerated: boolean;
}

/** Итог фразы про голосовое: дальше идёт ответ на текст или конец пачки. */
interface Noticed {
  readonly turn: Turn;
  readonly result: 'sent' | 'not_sent' | 'failed';
}

/**
 * Обрабатывает пачку сообщений клиента по шагам раздела плана «Как обрабатывается сообщение». Сообщения уже записаны
 * в базу (pipeline/recorder.ts, дубли по waId туда не доходят). В закрытом режиме сюда приходят только чаты
 * из TEST_ALLOWLIST: остальные отсекает whatsapp/inbound.ts, а outbox и шлюз не отправят в них.
 * 1. Чат перечитывается (по ID, после слияния по адресу); статус manager => бот молчит и не отмечает прочитанным.
 *    Чат не проходит закрытый режим (messaging/allowlist.ts, то же правило, что у outbox) => отказ до расшифровки
 *    и LLM: иначе outbox отсёк бы ответ уже после оплаченных вызовов. Ни одно сообщение пачки не ждёт ответа (пачку
 *    после возврата чата боту, pipeline/resume.ts, уже отработала прошлая) => молчание duplicate без вызовов.
 * 2. Голосовые: при включённой расшифровке скачиваются (inbox.downloadAudio, лимит MAX_AUDIO_BYTES) и расшифровываются;
 *    расшифровка сохраняется в базе (messages.setTranscript) и идёт в историю для LLM как обычный текст клиента,
 *    в том числе в следующих ответах. Сбой, пустая расшифровка или выключенная расшифровка
 *    => одна фраза на пачку через outbox.sendVoiceNotice, даже если голосовых несколько. В живой пачке с текстом
 *    фраза про голосовое уходит, только если черновик answer: сначала она, затем ответ на текст; при передаче
 *    фразы про голосовое нет. В пачке простоя (старше OFFLINE_BATCH_AGE_MS) с текстом ОДИН ответ на чат без фразы
 *    (решение владельца). Исчерпан лимит на расшифровке => как лимит у LLM.
 * 3. Статус перечитывается (расшифровка идёт до минуты), отметка о прочтении (сбой не мешает ответу), снова статус,
 *    затем company.prepare (бесплатные шаги определения компании, справка, опрос проверки; ходит в сеть, поэтому
 *    после него статус перечитывается ещё раз), затем черновик и оценка интереса с блоком о компании
 *    (pipeline/company-turn.draftWithCompany, история HISTORY_MESSAGES): параллельно, а если бот ждёт ответа на «Вы из
 *    компании X?», сначала оценка, затем черновик. Итог оценки уходит в company.applyAssessment до решения.
 *    Пришли новые сообщения (ClientBatch.takeNewer), пока шли вызовы => пачка обрабатывается заново вместе с ними.
 * 4. Решение (pipeline/reply-flow.decideReply, с тем же контекстом, что у черновика): оценка интереса сохраняется
 *    (она только хранит уровень и выжимку), текст ответа проходит нормализацию, проверки кодом и второй вызов LLM,
 *    развилка pipeline/decide.decideAction, при провале один повтор с замечаниями. Передачу решает вызов ответа
 *    (исходы hot, no_answer, asked_human, complaint). Вердикт send => «печатает» с паузой typingDelayMs (сбой статуса
 *    не мешает ответу), затем outbox.sendBotReply на последнее сообщение пачки того самого проверенного текста;
 *    ушёл (sent) => company.markAsked с вопросом о компании из черновика (нет => none) и ушедшим текстом: после каждого
 *    отправленного ответа, но не при перегенерации и не при передаче. Пришли новые сообщения, пока шла пауза => ответ
 *    перегенерируется один раз с ними, уходит один ответ.
 * 5. Все передачи через сервис deps.handoff (handoff/handoff.ts): вердикт handoff (hot, no_answer, asked_human,
 *    complaint, check_failed, llm_error) => handOff с причиной и ответом на последнее сообщение пачки; вердикт limit
 *    (исчерпан дневной лимит API) => handOff limit со scope, без фразы клиенту. Статус manager, запись передачи,
 *    сообщение клиенту (с повтором отправки), уведомление менеджеру и снятие ожидания ответа на «Вы из компании X?»
 *    (company.stopAwaiting) делает сервис, поэтому markAsked при передаче не нужен. Клиенту уходит одно сообщение:
 *    при hot, no_answer, asked_human это проверенный текст модели (ответ на то, что есть в знаниях, и фраза о
 *    передаче; в запросе передачи поле text), иначе фиксированная фраза по причине. Пришли новые сообщения, пока
 *    шла проверка текста модели => пачка обрабатывается заново один раз, как перед отправкой ответа. Перед передачей
 *    статус чата перечитывается: человек мог подключиться, пока LLM писал ответ. handOff бросает, только если
 *    передачу не записать (чата нет, сбой базы): ошибка в лог без текста, итог handoff_failed, «отвечено» не
 *    ставится.
 * Минимум для передачи по цене (решение владельца 29.10.2026): контекст черновика несёт ход разговора о цене
 * (chats.getProgress), заметку для бота (chats.getNote, указание коллеги до следующей передачи) и название компании
 * из сводки (подтверждённое или со слов клиента); перед решением название
 * читается заново, после оценки интереса. Ответ ушёл (sent) и в этом ходе клиент спросил цену или отказался отвечать
 * => chats.recordTurn: вопрос цены засчитывается, только когда бот на него ответил, поэтому перегенерация пачки его не
 * удваивает. Ушёл текст модели с отметками (этап и сильные стороны, решение владельца 30.10.2026) => chats.recordReply,
 * тоже только после отправки: отклонённые черновики и фиксированные фразы их не меняют.
 * 6. markAnswered один раз в конце пачки и только если что-то ушло (ответ, фраза про голосовое или записанная
 *    передача с фразой): иначе второй ответ пачки получил бы 'skipped_no_inbound'.
 * 7. Итог replied => company.identifyAfterReply (поиск по названию со слов клиента, проверка новой компании, логотип);
 *    его исключение идёт в лог предупреждением и итог не меняет. После передачи, лимита и молчания поиска нет.
 * Сбой отправки ответа или фразы про голосовое исключением повторяется один раз (pipeline/sending.sendWithRetry),
 * затем ошибка в лог «клиент остался без ответа». Сбой базы приходит отказом промиса: его пишет в лог
 * pipeline/batcher.ts. Чат вне TEST_ALLOWLIST не доходит ни до LLM, ни до сервиса компании.
 */
export async function handleClientBatch(
  deps: PipelineDeps,
  batch: ClientBatch,
): Promise<PipelineOutcome> {
  const turn: Turn = {
    messages: batch.messages,
    transcripts: new Map(),
    unheard: new Set(),
    read: new Set(),
    voiceNoticeSent: false,
    regenerated: false,
  };
  const outcome = await processTurn(deps, batch, turn);
  logOutcome(deps.logger, batch.chatId, outcome);
  if (outcome.kind === 'replied') await identifyAfterReply(deps, batch);
  return outcome;
}

/**
 * Поиск компании после ответа по чату, перечитанному из базы (как в начале хода, с поиском по адресу после слияния).
 * Исключение (сбой базы) идёт в лог предупреждением без текста: ответ уже ушёл, итог хода не меняется.
 */
async function identifyAfterReply(deps: PipelineDeps, batch: ClientBatch): Promise<void> {
  const chat = currentChat(deps, batch.chatId, batch.messages);
  if (chat === null) return;
  try {
    await deps.company.identifyAfterReply(chat);
  } catch (error: unknown) {
    deps.logger.warn(
      { chatId: chat.id, errorName: errorName(error) },
      `Поиск компании после ответа не удался: чат #${chat.id}`,
    );
  }
}

async function processTurn(
  deps: PipelineDeps,
  batch: ClientBatch,
  start: Turn,
): Promise<PipelineOutcome> {
  const chat = currentChat(deps, batch.chatId, start.messages);
  if (chat === null) return { kind: 'silent', reason: 'no_chat' };
  if (chat.control.status === 'manager') return SILENT_MANAGER;
  if (!isChatAllowlisted(deps.testAllowlist, chat.identity)) {
    return { kind: 'blocked', reason: 'skipped_test_mode' };
  }
  // Возврат чата боту отдаёт неотвеченное ещё раз: если ответ на всю пачку уже ушёл, вызовы LLM не нужны.
  if (isAllAnswered(deps, chat.id, start.messages)) return { kind: 'silent', reason: 'duplicate' };
  const heard = await transcribeVoices(deps, chat.id, start);
  if ('scope' in heard) return goSilent(deps, chat.id, heard.scope);
  const transcribed: Turn = { ...start, ...heard };
  const answerable = hasText(transcribed);
  if (!answerable && heard.unheard.size === 0) return { kind: 'silent', reason: 'no_text' };
  // Расшифровка идёт до минуты: человек мог подключиться.
  if (isManagerNow(deps, chat.id)) return SILENT_MANAGER;
  const read = await markRead(deps, chat, transcribed);
  if (answerable) return draftAndAnswer(deps, batch, chat, read);
  return answerVoiceOnly(deps, chat.id, read);
}

/** Только голосовые без расшифровки: одна фраза про голосовое, LLM не вызывается. */
async function answerVoiceOnly(
  deps: PipelineDeps,
  chatId: ChatId,
  turn: Turn,
): Promise<PipelineOutcome> {
  const noticed = await voiceNotice(deps, chatId, turn, false);
  if ('kind' in noticed) return noticed;
  if (noticed.result === 'failed') return SEND_FAILED_OUTCOME;
  const sent: PipelineOutcome | null = noticed.result === 'sent' ? { kind: 'voice_notice' } : null;
  return finish(deps, chatId, noticed.turn, sent);
}

/** Чат по ID; после слияния чатов (pipeline/recorder.ts) ID мог исчезнуть: тогда по адресу последнего сообщения. */
function currentChat(
  deps: PipelineDeps,
  chatId: ChatId,
  messages: readonly InboundMessage[],
): Chat | null {
  const last = messages.at(-1);
  return deps.chats.getById(chatId) ?? (last ? deps.chats.findByJid(last.identity.replyJid) : null);
}

/** Пачка не пустая, и ни одно её сообщение не ждёт ответа. */
function isAllAnswered(
  deps: PipelineDeps,
  chatId: ChatId,
  messages: readonly InboundMessage[],
): boolean {
  return (
    messages.length > 0 &&
    messages.every((message) => !deps.messages.isUnansweredInbound(chatId, message.waId))
  );
}

function isManagerNow(deps: PipelineDeps, chatId: ChatId): boolean {
  return deps.chats.getById(chatId)?.control.status !== 'bot';
}

function hasText(turn: Turn): boolean {
  return turn.messages.some(
    (message) => message.content.kind === 'text' || turn.transcripts.has(message.waId),
  );
}

/**
 * Фраза про голосовое одна на пачку; в пачке простоя с текстом её нет: один ответ на чат. В пачке с текстом
 * её шлёт только ответ answer (при передаче фраза про голосовое противоречила бы фразе передачи).
 */
async function voiceNotice(
  deps: PipelineDeps,
  chatId: ChatId,
  turn: Turn,
  answerable: boolean,
): Promise<Noticed | PipelineOutcome> {
  const last = lastUnheard(turn);
  if (last === null || turn.voiceNoticeSent || (answerable && isOffline(deps.clock, turn))) {
    return { turn, result: 'not_sent' };
  }
  if (isManagerNow(deps, chatId)) return SILENT_MANAGER;
  const result = await sendWithRetry(deps, chatId, 'фраза про голосовое не ушла', () =>
    deps.outbox.sendVoiceNotice(chatId, last),
  );
  if (result === 'skipped_manager') return SILENT_MANAGER;
  const noticed: Turn = { ...turn, voiceNoticeSent: true };
  if (result === SEND_FAILED) return { turn: noticed, result: 'failed' };
  if (result !== 'sent') deps.logger.warn({ chatId, result }, 'Фраза про голосовое не отправлена');
  return { turn: noticed, result: result === 'sent' ? 'sent' : 'not_sent' };
}

function lastUnheard(turn: Turn): WaMessageId | null {
  return turn.messages.findLast((message) => turn.unheard.has(message.waId))?.waId ?? null;
}

function isOffline(clock: Clock, turn: Turn): boolean {
  const first = turn.messages[0];
  return first !== undefined && clock.now() - first.tsMs > OFFLINE_BATCH_AGE_MS;
}

// Прочтение, черновик и ответ.

async function markRead(deps: PipelineDeps, chat: Chat, turn: Turn): Promise<Turn> {
  const ids = turn.messages.map((message) => message.waId).filter((id) => !turn.read.has(id));
  try {
    await deps.inbox.markRead(chat.identity.replyJid, ids);
  } catch (error: unknown) {
    deps.logger.warn({ chatId: chat.id, err: error }, 'Отметка о прочтении не отправлена');
  }
  return { ...turn, read: new Set([...turn.read, ...ids]) };
}

async function draftAndAnswer(
  deps: PipelineDeps,
  batch: ClientBatch,
  chat: Chat,
  turn: Turn,
): Promise<PipelineOutcome> {
  // Отметка о прочтении ушла в сеть: человек мог подключиться.
  if (isManagerNow(deps, chat.id)) return SILENT_MANAGER;
  const company = await deps.company.prepare(chat, turn.messages);
  // Определение компании ходит к API и в WhatsApp (до нескольких секунд): человек мог подключиться.
  if (isManagerNow(deps, chat.id)) return SILENT_MANAGER;
  const { context, drafted } = await draftWithCompany(deps, contextOf(deps, chat), company);
  const regenerated = regenerate(deps, batch, turn);
  if (regenerated !== null) return regenerated;
  // Оценка интереса могла записать название компании со слов клиента или подтверждение: минимум по свежей сводке.
  const fresh: ConversationContext = { ...context, companyName: companyNameNow(deps, chat.id) };
  const verdict = await decideReply(deps, fresh, drafted);
  return act(deps, batch, chat, turn, verdict);
}

/** Вердикт хода ответа: отправить проверенный текст, передать менеджеру или замолчать из-за лимита API. */
function act(
  deps: PipelineDeps,
  batch: ClientBatch,
  chat: Chat,
  turn: Turn,
  verdict: ReplyVerdict,
): Promise<PipelineOutcome> {
  switch (verdict.kind) {
    case 'send':
      return sendAnswer(deps, batch, chat, turn, verdict);
    case 'handoff':
      return handOff(deps, batch, chat.id, turn, verdict);
    case 'limit':
      return goSilent(deps, chat.id, verdict.scope);
  }
}

/** Новые сообщения чата во время ответа: обработать пачку заново вместе с ними, но только один раз. */
function regenerate(
  deps: PipelineDeps,
  batch: ClientBatch,
  turn: Turn,
): Promise<PipelineOutcome> | null {
  if (turn.regenerated) return null;
  // Возврат чата боту мог отдать в очередь сообщение, которое уже в этой пачке: второй раз его не брать.
  const newer = batch
    .takeNewer()
    .filter((message) => !turn.messages.some((known) => known.waId === message.waId));
  if (newer.length === 0) return null;
  const messages = [...turn.messages, ...newer];
  return processTurn(deps, batch, { ...turn, messages, regenerated: true });
}

function contextOf(deps: PipelineDeps, chat: Chat): ConversationContext {
  const history = deps.messages.recent(chat.id, HISTORY_MESSAGES);
  return {
    chatId: chat.id,
    history,
    profile: chat.profile,
    level: chat.level,
    progress: deps.chats.getProgress(chat.id),
    companyName: companyNameNow(deps, chat.id),
    note: deps.chats.getNote(chat.id),
  };
}

/**
 * Название компании для минимума из сводки сервиса компании. Сбой чтения (база) ответ не останавливает: название
 * неизвестно, в лог ID чата и имя ошибки.
 */
function companyNameNow(deps: PipelineDeps, chatId: ChatId): string | null {
  try {
    return companyNameOf(deps.company.summary(chatId));
  } catch (error: unknown) {
    deps.logger.warn(
      { chatId, errorName: errorName(error) },
      `Сводка о компании не прочитана: минимум без названия: чат #${chatId}`,
    );
    return null;
  }
}

/**
 * Ответ клиенту; ушёл => отвечено, затем company.markAsked с вопросом о компании из черновика и ушедшим текстом
 * (каждый вопрос задаётся один раз, ожидание ответа на «Вы из компании X?» снимается).
 */
async function sendAnswer(
  deps: PipelineDeps,
  batch: ClientBatch,
  chat: Chat,
  start: Turn,
  verdict: SendVerdict,
): Promise<PipelineOutcome> {
  const chatId = chat.id;
  const { text } = verdict;
  if (isManagerNow(deps, chatId)) return SILENT_MANAGER;
  const noticed = await voiceNotice(deps, chatId, start, true);
  if ('kind' in noticed) return noticed;
  const { turn } = noticed;
  await typingPause(deps, chat, text);
  const regenerated = regenerate(deps, batch, turn);
  if (regenerated !== null) return regenerated;
  const result = await sendWithRetry(deps, chatId, 'ответ не ушёл', () =>
    deps.outbox.sendBotReply(chatId, text, lastId(turn)),
  );
  if (result === SEND_FAILED) return SEND_FAILED_OUTCOME;
  if (result === 'sent') {
    const replied = finish(deps, chatId, turn, { kind: 'replied' });
    deps.company.markAsked(chatId, verdict.companyQuestion ?? 'none', text);
    if (verdict.signals !== undefined) deps.chats.recordTurn(chatId, verdict.signals);
    if (verdict.marks !== undefined) deps.chats.recordReply(chatId, verdict.marks);
    return replied;
  }
  if (result === 'skipped_manager') return SILENT_MANAGER;
  if (result === 'skipped_no_inbound') return { kind: 'silent', reason: 'duplicate' };
  return { kind: 'blocked', reason: result };
}

// Передача менеджеру: всё делает сервис handoff/handoff.ts.

/**
 * Передача с одним сообщением клиенту на последнее сообщение пачки (проверенный текст модели или фиксированная
 * фраза); после неё пачка отмечается отвеченной. Текст модели отвечает на вопросы пачки, поэтому пришли новые
 * сообщения => пачка обрабатывается заново один раз (как перед отправкой ответа).
 */
async function handOff(
  deps: PipelineDeps,
  batch: ClientBatch,
  chatId: ChatId,
  turn: Turn,
  verdict: HandoffVerdict,
): Promise<PipelineOutcome> {
  if (isManagerNow(deps, chatId)) return SILENT_MANAGER;
  if ('text' in verdict) {
    const regenerated = regenerate(deps, batch, turn);
    if (regenerated !== null) return regenerated;
  }
  const request = handOffRequestOf(verdict, lastId(turn));
  if (!(await requestHandOff(deps, chatId, request))) {
    return { kind: 'handoff_failed', reason: request.reason };
  }
  return finish(deps, chatId, turn, { kind: 'handed_off', reason: request.reason });
}

/**
 * Запрос сервису передачи: с text, если клиенту уходит сообщение модели, иначе с фиксированной фразой по поводу; с
 * причиной своими словами (detail) для уведомления менеджеру, если она есть.
 */
function handOffRequestOf(verdict: HandoffVerdict, replyToWaId: WaMessageId): HandOffRequest {
  const detail = verdict.detail === undefined ? {} : { detail: verdict.detail };
  return 'text' in verdict
    ? { reason: verdict.notice.reason, replyToWaId, text: verdict.text, ...detail }
    : { ...verdict.notice, replyToWaId, ...detail };
}

/** Дневной лимит API исчерпан: бот замолкает в чате без фразы клиенту (решение владельца), менеджеру уходит уведомление. */
async function goSilent(
  deps: PipelineDeps,
  chatId: ChatId,
  scope: BudgetScope,
): Promise<PipelineOutcome> {
  if (isManagerNow(deps, chatId)) return SILENT_MANAGER;
  deps.logger.warn({ chatId, scope }, 'Дневной лимит вызовов API исчерпан: бот замолкает в чате');
  if (!(await requestHandOff(deps, chatId, { reason: 'limit', scope }))) {
    return { kind: 'handoff_failed', reason: 'limit' };
  }
  return { kind: 'handed_off', reason: 'limit' };
}

/**
 * Вызов сервиса передачи. Он бросает, только если передачу не записать (чата нет, сбой базы); ошибка идёт в лог
 * без текста сообщений и номеров, пачка не падает. Сбои фразы клиенту и уведомления сервис разбирает сам.
 */
async function requestHandOff(
  deps: PipelineDeps,
  chatId: ChatId,
  request: HandOffRequest,
): Promise<boolean> {
  try {
    await deps.handoff.handOff(chatId, request);
    return true;
  } catch (error: unknown) {
    deps.logger.error(
      { chatId, reason: request.reason, errorName: errorName(error) },
      `Передача менеджеру не записана: чат #${chatId}`,
    );
    return false;
  }
}

/** Конец пачки, когда что-то ушло: входящие пачки отмечаются отвеченными один раз; ничего не ушло => duplicate. */
function finish(
  deps: PipelineDeps,
  chatId: ChatId,
  turn: Turn,
  sent: PipelineOutcome | null,
): PipelineOutcome {
  if (sent === null) return { kind: 'silent', reason: 'duplicate' };
  deps.messages.markAnswered(chatId, lastId(turn));
  return sent;
}

function lastId(turn: Turn): WaMessageId {
  const last = turn.messages.at(-1);
  if (last === undefined) throw new Error('Пустая пачка сообщений: отвечать не на что');
  return last.waId;
}

const OUTCOME_TEXT: Readonly<Record<PipelineOutcome['kind'], string>> = {
  replied: 'Ответ отправлен',
  voice_notice: 'Отправлена фраза про голосовое',
  silent: 'Бот промолчал',
  blocked: 'Ответ не отправлен',
  handed_off: 'Чат передан менеджеру',
  handoff_failed: 'Передача менеджеру не удалась',
  send_failed: 'Клиент остался без ответа',
};

/** Итог пачки в лог: только ID чата, вид итога и причина, без текста и номеров. */
function logOutcome(logger: Logger, chatId: ChatId, outcome: PipelineOutcome): void {
  const reason = 'reason' in outcome ? outcome.reason : undefined;
  const context =
    reason === undefined
      ? { chatId, outcome: outcome.kind }
      : { chatId, outcome: outcome.kind, reason };
  const suffix = reason === undefined ? '' : ` (${reason})`;
  logger.info(context, `${OUTCOME_TEXT[outcome.kind]}${suffix}: чат #${chatId}`);
}
