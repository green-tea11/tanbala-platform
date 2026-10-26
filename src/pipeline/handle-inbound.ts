import { HISTORY_MESSAGES, type Agent, type ConversationContext } from '../agent/agent.js';
import type {
  ChatsRepo,
  Clock,
  Logger,
  MessageSender,
  MessagesRepo,
  Transcriber,
  WhatsAppInbox,
} from '../domain/ports.js';
import type {
  BudgetScope,
  Chat,
  ChatId,
  HandoffNotice,
  HandoffReason,
  InboundMessage,
  PhoneDigits,
  ReviewedText,
  WaMessageId,
} from '../domain/types.js';
import { isChatAllowlisted } from '../messaging/allowlist.js';
import type { Outbox, SendBlocked } from '../messaging/outbox.js';
import { MAX_AUDIO_BYTES } from '../voice/transcriber.js';
import type { ClientBatch } from './batcher.js';
import { decideReply, requestDraft, type ReplyVerdict } from './reply-flow.js';

/** Зависимости конвейера обработки сообщения. TODO(этап 5): сервис передачи handoff/handoff.ts. */
export interface PipelineDeps {
  readonly chats: Pick<ChatsRepo, 'getById' | 'findByJid' | 'setStatus' | 'saveAssessment'>;
  readonly messages: Pick<MessagesRepo, 'recent' | 'markAnswered' | 'setTranscript'>;
  readonly agent: Pick<Agent, 'draftReply' | 'reviewDraft' | 'assessInterest'>;
  readonly outbox: Pick<Outbox, 'sendBotReply' | 'sendHandoffNotice' | 'sendVoiceNotice'>;
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
  /** Отправка упала исключением и после повтора: клиент остался без ответа (ошибка в логе). */
  | { readonly kind: 'send_failed' };

/** Пауза перед повтором отправки, упавшей исключением: за это время сокет успевает переподключиться. */
export const SEND_RETRY_DELAY_MS = 5_000;

/**
 * Пачка старше этого к началу обработки пришла из офлайн-очереди (бот был выключен): живая пачка ждёт
 * не больше склейки и предыдущей пачки чата, это десятки секунд.
 */
const OFFLINE_BATCH_AGE_MS = 2 * 60_000;

/** Лимит расшифровки в символах, как у текста сообщения (whatsapp/inbound.MAX_TEXT_CHARS). */
const MAX_TRANSCRIPT_CHARS = 4096;

const SILENT_MANAGER: PipelineOutcome = { kind: 'silent', reason: 'manager_mode' };
const SEND_FAILED_OUTCOME: PipelineOutcome = { kind: 'send_failed' };

/** Отправка не удалась и после повтора. */
const SEND_FAILED = Symbol('send-failed');

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

/** Расшифровка одного голосового. */
type Heard =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'unheard' }
  | { readonly kind: 'budget'; readonly scope: BudgetScope };

/**
 * Обрабатывает пачку сообщений клиента по шагам раздела плана «Как обрабатывается сообщение». Сообщения уже записаны
 * в базу (pipeline/recorder.ts, дубли по waId туда не доходят). В закрытом режиме сюда приходят только чаты
 * из TEST_ALLOWLIST: остальные отсекает whatsapp/inbound.ts, а outbox и шлюз не отправят в них.
 * 1. Чат перечитывается (по ID, после слияния по адресу); статус manager => бот молчит и не отмечает прочитанным.
 *    Чат не проходит закрытый режим (messaging/allowlist.ts, то же правило, что у outbox) => отказ до расшифровки
 *    и LLM: иначе outbox отсёк бы ответ уже после оплаченных вызовов.
 * 2. Голосовые: при включённой расшифровке скачиваются (inbox.downloadAudio, лимит MAX_AUDIO_BYTES) и расшифровываются;
 *    расшифровка сохраняется в базе (messages.setTranscript) и идёт в историю для LLM как обычный текст клиента,
 *    в том числе в следующих ответах. Сбой, пустая расшифровка или выключенная расшифровка
 *    => одна фраза на пачку через outbox.sendVoiceNotice, даже если голосовых несколько. В живой пачке с текстом
 *    фраза про голосовое уходит, только если черновик answer: сначала она, затем ответ на текст; при передаче
 *    фразы про голосовое нет. В пачке простоя (старше OFFLINE_BATCH_AGE_MS) с текстом ОДИН ответ на чат без фразы
 *    (решение владельца). Исчерпан лимит на расшифровке => как лимит у LLM.
 * 3. Статус перечитывается (расшифровка идёт до минуты), отметка о прочтении (сбой не мешает ответу), снова статус,
 *    затем черновик и оценка интереса параллельно (pipeline/reply-flow.requestDraft, история HISTORY_MESSAGES).
 *    Пришли новые сообщения (ClientBatch.takeNewer), пока шли вызовы => пачка обрабатывается заново вместе с ними.
 * 4. Решение (pipeline/reply-flow.decideReply): оценка интереса сохраняется, текст ответа проходит нормализацию,
 *    проверки кодом и второй вызов LLM, развилка pipeline/decide.decideAction, при провале один повтор с замечаниями.
 *    Вердикт send => «печатает» с паузой typingDelayMs (сбой статуса не мешает ответу), затем outbox.sendBotReply
 *    на последнее сообщение пачки того самого проверенного текста. Пришли новые сообщения, пока шла пауза =>
 *    ответ перегенерируется один раз с ними, уходит один ответ.
 * 5. Временно (до сервиса передачи этапа 5, без уведомления менеджеру): вердикт handoff (hot, no_answer,
 *    asked_human, complaint, check_failed, llm_error) => статус manager (by 'bot') и фиксированная фраза по причине
 *    через outbox.sendHandoffNotice; горячему клиенту уходит одна фраза передачи, а не два сообщения. Вердикт limit
 *    (исчерпан дневной лимит API) => статус manager без фразы клиенту (уведомление менеджеру появится на этапе 5).
 *    Перед каждой отправкой статус чата перечитывается: человек мог подключиться, пока LLM писал ответ.
 * 6. markAnswered один раз в конце пачки и только если что-то ушло: иначе второй ответ пачки получил бы
 *    'skipped_no_inbound'.
 * Сбой отправки исключением повторяется один раз (sendWithRetry), затем ошибка в лог «клиент остался без ответа»;
 * при передаче статус manager остаётся, и это видно в логе. Сбой базы приходит отказом промиса: его пишет в лог
 * pipeline/batcher.ts.
 * TODO(этап 5): все передачи через handoff.handOff: hot, no_answer, asked_human, complaint, check_failed, llm_error, limit, с уведомлением менеджеру.
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
  return outcome;
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
  const heard = await transcribeVoices(deps, chat.id, start);
  if ('scope' in heard) return goSilent(deps, chat.id, heard.scope);
  const answerable = hasText(heard);
  if (!answerable && heard.unheard.size === 0) return { kind: 'silent', reason: 'no_text' };
  // Расшифровка идёт до минуты: человек мог подключиться.
  if (isManagerNow(deps, chat.id)) return SILENT_MANAGER;
  const read = await markRead(deps, chat, heard);
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

function isManagerNow(deps: PipelineDeps, chatId: ChatId): boolean {
  return deps.chats.getById(chatId)?.control.status !== 'bot';
}

// Голосовые.

async function transcribeVoices(
  deps: PipelineDeps,
  chatId: ChatId,
  turn: Turn,
): Promise<Turn | { readonly scope: BudgetScope }> {
  const transcripts = new Map(turn.transcripts);
  const unheard = new Set(turn.unheard);
  for (const message of turn.messages) {
    const { content, waId } = message;
    if (content.kind !== 'voice' || transcripts.has(waId) || unheard.has(waId)) continue;
    const heard = await transcribe(deps, chatId, content.media);
    if (heard.kind === 'budget') return { scope: heard.scope };
    if (heard.kind === 'text') {
      saveTranscript(deps, chatId, waId, heard.text);
      transcripts.set(waId, heard.text);
    } else {
      unheard.add(waId);
    }
  }
  return { ...turn, transcripts, unheard };
}

async function transcribe(
  deps: PipelineDeps,
  chatId: ChatId,
  media: Extract<InboundMessage['content'], { kind: 'voice' }>['media'],
): Promise<Heard> {
  const { transcriber } = deps;
  if (!transcriber.enabled) return { kind: 'unheard' };
  try {
    const clip = await deps.inbox.downloadAudio(media, MAX_AUDIO_BYTES);
    const result = await transcriber.transcribe(clip, chatId);
    if (result.ok) return heardText(result.value);
    if (result.failure === 'budget_exceeded') return { kind: 'budget', scope: result.scope };
    deps.logger.warn({ chatId, failure: result.failure }, 'Голосовое не расшифровано');
  } catch (error: unknown) {
    deps.logger.warn({ chatId, err: error }, 'Голосовое не скачано или не расшифровано');
  }
  return { kind: 'unheard' };
}

/** Расшифровка в базу: следующие ответы видят в истории, что клиент сказал голосом. */
function saveTranscript(deps: PipelineDeps, chatId: ChatId, waId: WaMessageId, text: string): void {
  if (!deps.messages.setTranscript(chatId, waId, text)) {
    deps.logger.warn(
      { chatId },
      'Расшифровка голосового не записана: в базе нет такого голосового без текста',
    );
  }
}

function heardText(raw: string): Heard {
  const text = Array.from(raw.trim()).slice(0, MAX_TRANSCRIPT_CHARS).join('');
  return text === '' ? { kind: 'unheard' } : { kind: 'text', text };
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
  const context = contextOf(deps, chat);
  const drafted = await requestDraft(deps, context);
  const regenerated = regenerate(deps, batch, turn);
  if (regenerated !== null) return regenerated;
  const verdict = await decideReply(deps, context, drafted);
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
      return sendAnswer(deps, batch, chat, turn, verdict.text);
    case 'handoff':
      return handOff(deps, chat.id, turn, verdict.notice);
    case 'limit':
      return Promise.resolve(goSilent(deps, chat.id, verdict.scope));
  }
}

/** Новые сообщения чата во время ответа: обработать пачку заново вместе с ними, но только один раз. */
function regenerate(
  deps: PipelineDeps,
  batch: ClientBatch,
  turn: Turn,
): Promise<PipelineOutcome> | null {
  if (turn.regenerated) return null;
  const newer = batch.takeNewer();
  if (newer.length === 0) return null;
  const messages = [...turn.messages, ...newer];
  return processTurn(deps, batch, { ...turn, messages, regenerated: true });
}

function contextOf(deps: PipelineDeps, chat: Chat): ConversationContext {
  const history = deps.messages.recent(chat.id, HISTORY_MESSAGES);
  return { chatId: chat.id, history, profile: chat.profile, level: chat.level };
}

async function sendAnswer(
  deps: PipelineDeps,
  batch: ClientBatch,
  chat: Chat,
  start: Turn,
  text: ReviewedText,
): Promise<PipelineOutcome> {
  const chatId = chat.id;
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
  if (result === 'sent') return finish(deps, chatId, turn, { kind: 'replied' });
  if (result === 'skipped_manager') return SILENT_MANAGER;
  if (result === 'skipped_no_inbound') return { kind: 'silent', reason: 'duplicate' };
  return { kind: 'blocked', reason: result };
}

/**
 * Отправка через outbox. Сбой исключением (например, старый закрытый сокет при переподключении) повторяется один раз
 * после паузы SEND_RETRY_DELAY_MS; второй сбой => ошибка в лог «клиент остался без ответа» (без номера и текста).
 */
async function sendWithRetry<T>(
  deps: PipelineDeps,
  chatId: ChatId,
  what: string,
  send: () => Promise<T>,
): Promise<T | typeof SEND_FAILED> {
  try {
    return await send();
  } catch (error: unknown) {
    deps.logger.warn(
      { chatId, errorName: errorName(error) },
      `Сбой отправки, повтор: чат #${chatId}`,
    );
  }
  await deps.clock.sleep(SEND_RETRY_DELAY_MS);
  try {
    return await send();
  } catch (error: unknown) {
    deps.logger.error(
      { chatId, errorName: errorName(error) },
      `Клиент остался без ответа: ${what}, чат #${chatId}`,
    );
    return SEND_FAILED;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** «Печатает» на время паузы; статус снимается и при прерванной паузе (остановка), сбой статуса только в лог. */
async function typingPause(deps: PipelineDeps, chat: Chat, text: string): Promise<void> {
  const jid = chat.identity.replyJid;
  await presence(deps, chat.id, () => deps.typing.setTyping(jid, true));
  try {
    await deps.clock.sleep(deps.typingDelayMs(text));
  } finally {
    await presence(deps, chat.id, () => deps.typing.setTyping(jid, false));
  }
}

async function presence(
  deps: PipelineDeps,
  chatId: ChatId,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (error: unknown) {
    deps.logger.warn({ chatId, err: error }, 'Статус «печатает» не отправлен');
  }
}

// Передача менеджеру (временно до этапа 5: без уведомления менеджеру).

async function handOff(
  deps: PipelineDeps,
  chatId: ChatId,
  turn: Turn,
  notice: HandoffNotice,
): Promise<PipelineOutcome> {
  if (isManagerNow(deps, chatId)) return SILENT_MANAGER;
  deps.chats.setStatus(chatId, { status: 'manager', by: 'bot' }, deps.clock.now());
  const result = await sendWithRetry(deps, chatId, 'фраза передачи не ушла, чат у менеджера', () =>
    deps.outbox.sendHandoffNotice(chatId, notice, lastId(turn)),
  );
  const outcome: PipelineOutcome = { kind: 'handed_off', reason: notice.reason };
  if (result === 'sent') return finish(deps, chatId, turn, outcome);
  if (result !== SEND_FAILED) deps.logger.warn({ chatId, result }, 'Фраза передачи не отправлена');
  return outcome;
}

/** Дневной лимит API исчерпан: бот замолкает в чате без фразы клиенту (решение владельца). */
function goSilent(deps: PipelineDeps, chatId: ChatId, scope: BudgetScope): PipelineOutcome {
  if (isManagerNow(deps, chatId)) return SILENT_MANAGER;
  deps.chats.setStatus(chatId, { status: 'manager', by: 'bot' }, deps.clock.now());
  deps.logger.warn({ chatId, scope }, 'Дневной лимит вызовов API исчерпан: бот замолкает в чате');
  return { kind: 'handed_off', reason: 'limit' };
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
