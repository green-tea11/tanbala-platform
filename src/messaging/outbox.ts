import type {
  ChatsRepo,
  Clock,
  MessagesRepo,
  MessageSender,
  OutboundIdsRepo,
  OutboundRecord,
} from '../domain/ports.js';
import type {
  Chat,
  ChatId,
  HandoffNotice,
  Jid,
  PhoneDigits,
  ReviewedText,
  SendOrigin,
  WaMessageId,
} from '../domain/types.js';
import { notImplemented } from '../shared/todo.js';
import { isChatAllowlisted } from './allowlist.js';

/**
 * Отправка не состоялась: лимит исходящих, аварийный выключатель автоответов или закрытый режим
 * (чат не из TEST_ALLOWLIST: вторая линия защиты после whatsapp/inbound.ts).
 */
export type SendBlocked = 'skipped_limit' | 'disabled' | 'skipped_test_mode';

/**
 * Вид уведомления менеджеру. У уведомлений о лимите своя квота: исчерпание общего лимита
 * не вытесняет уведомления о горячих клиентах и других передачах.
 * backlog: одно уведомление со списком чатов, где сообщения за время простоя старше порога.
 */
export type ManagerNotifyKind = 'handoff' | 'limit' | 'backlog';

/** Итог уведомления менеджеру: waId нужен для HandoffsRepo.setManagerNotified. */
export type ManagerNotifyResult =
  | { readonly status: 'sent'; readonly waId: WaMessageId }
  | { readonly status: 'no_manager' | 'skipped_limit' };

/** Единственный путь исходящих сообщений с номера бота. */
export interface Outbox {
  /** Ответ клиенту в чат, где есть неотвеченное входящее replyToWaId. ReviewedText: текст прошёл проверки. */
  sendBotReply(
    chatId: ChatId,
    text: ReviewedText,
    replyToWaId: WaMessageId,
  ): Promise<'sent' | 'skipped_manager' | 'skipped_no_inbound' | SendBlocked>;
  /**
   * Фраза клиенту при передаче. Статус чата не проверяет (чат уже у менеджера);
   * текст не параметр: фраза фиксированная по поводу, без LLM и без времени.
   */
  sendHandoffNotice(
    chatId: ChatId,
    notice: HandoffNotice,
    replyToWaId: WaMessageId,
  ): Promise<'sent' | 'skipped_no_inbound' | SendBlocked>;
  /**
   * Ответ на голосовое, пока расшифровки нет: ровно «Сейчас не могу прослушать голосовое, напишите, пожалуйста,
   * текстом» (решение владельца). Текст фиксированный, не параметр; как sendBotReply, учитывает статус manager,
   * неотвеченное входящее, лимиты и рубильник.
   */
  sendVoiceNotice(
    chatId: ChatId,
    replyToWaId: WaMessageId,
  ): Promise<'sent' | 'skipped_manager' | 'skipped_no_inbound' | SendBlocked>;
  /** Уведомление менеджеру на MANAGER_WHATSAPP: единственное исходящее не в ответ. */
  notifyManager(text: string, kind: ManagerNotifyKind): Promise<ManagerNotifyResult>;
  /** Ответ менеджера из панели от имени номера: чат сразу переходит в статус manager. */
  sendFromPanel(chatId: ChatId, text: string): Promise<'sent'>;
}

/** Зависимости исходящих. managerJid: null, если MANAGER_WHATSAPP не задан. */
export interface OutboxDeps {
  sender: MessageSender;
  chats: ChatsRepo;
  messages: MessagesRepo;
  outboundIds: OutboundIdsRepo;
  clock: Clock;
  managerJid: Jid | null;
  /** Закрытый режим: номера из TEST_ALLOWLIST; null, если режим выключен. */
  testAllowlist: ReadonlySet<PhoneDigits> | null;
  random: () => number;
}

/** Фраза в ответ на голосовое, пока расшифровки нет (решение владельца): ровно этот текст, без вариантов. */
export const VOICE_NOTICE_TEXT =
  'Сейчас не могу прослушать голосовое, напишите, пожалуйста, текстом';

/**
 * Предохранитель от петель (например, переписки с чужим автоответчиком): исходящих в один чат клиента
 * за скользящий час. Ответы, фразы передачи и про голосовое считаются вместе.
 */
export const CLIENT_SENDS_PER_CHAT_PER_HOUR = 30;

/** Исходящих во все чаты клиентов за скользящий час. */
export const CLIENT_SENDS_PER_HOUR = 300;

/** Уведомлений менеджеру за скользящий час по видам: квоты раздельные. */
export const MANAGER_NOTIFY_PER_HOUR: Readonly<Record<ManagerNotifyKind, number>> = Object.freeze({
  handoff: 30,
  limit: 10,
  backlog: 3,
});

const HOUR_MS = 60 * 60 * 1000;

/** Варианты фразы: хотя бы один. */
type Variants = readonly [string, ...string[]];

// Фразы передачи (knowledge/whatsapp.md, «Что писать клиенту»): специалист вместо менеджера, без тире и без времени.
const PASSED_WILL_WRITE: Variants = [
  'Передал ваш вопрос специалисту, он вам напишет.',
  'Я передал вопрос специалисту, он вам напишет.',
  'Передал вопрос нашему специалисту, он вам напишет.',
];
const WILL_CHECK: Variants = [
  'Уточню этот вопрос у специалиста.',
  'Этот вопрос уточню у специалиста.',
  'Уточню у специалиста, как лучше ответить на ваш вопрос.',
];
const WILL_PASS: Variants = [
  'Передам ваш вопрос специалисту.',
  'Передам этот вопрос специалисту.',
  'Я передам вопрос специалисту.',
];
const APOLOGY_PASSED: Variants = [
  'Извините, пожалуйста. Передал ваш вопрос специалисту.',
  'Простите за неудобство. Передал вопрос специалисту.',
  'Приношу извинения. Я передал ваш вопрос специалисту.',
];
/** Клиент просит больше не писать: только извинение. */
const APOLOGY_ONLY: Variants = [
  'Извините, пожалуйста.',
  'Простите за беспокойство.',
  'Извините за беспокойство.',
];

const HANDOFF_PHRASES = {
  hot: PASSED_WILL_WRITE,
  asked_human: PASSED_WILL_WRITE,
  no_answer: WILL_CHECK,
  check_failed: WILL_PASS,
  llm_error: WILL_PASS,
} as const satisfies Record<Exclude<HandoffNotice['reason'], 'complaint'>, Variants>;

/** Почему сообщение в чат клиента не отправлено. Extra: свой отказ вида отправки (статус manager). */
type Blocked<Extra extends string> = 'skipped_no_inbound' | SendBlocked | Extra;

/** Сообщение в чат клиента: ответ бота, фраза передачи или фраза про голосовое. */
interface ClientSend {
  readonly chatId: ChatId;
  readonly replyToWaId: WaMessageId;
  readonly origin: Extract<SendOrigin, 'bot_reply' | 'handoff_notice' | 'voice_notice'>;
  readonly text: string;
}

/** Проверка статуса чата: ответ бота и фраза про голосовое молчат при менеджере, фраза передачи статус не смотрит. */
type StatusGate<Extra extends string> = (chat: Chat) => Extra | null;

const silentForManager: StatusGate<'skipped_manager'> = (chat) =>
  chat.control.status === 'manager' ? 'skipped_manager' : null;
const ignoreStatus: StatusGate<never> = () => null;

/** Исходящее без ID и времени: их ставит deliver. */
type Outgoing = Omit<OutboundRecord, 'waId' | 'nowMs'>;

/** Отметка отправки: чей счётчик (чат или вид уведомления) и когда. */
interface Stamp<K> {
  readonly key: K;
  readonly atMs: number;
}

/** Квоты исходящих за скользящий час. В памяти: это предохранитель от петель, а не учёт. */
interface SendQuotas {
  takeClientSlot(chatId: ChatId): boolean;
  takeNotifySlot(kind: ManagerNotifyKind): boolean;
}

/**
 * Создаёт Outbox. Бот пишет только в ответ на входящие и менеджеру; адресат никогда не берётся из текста LLM:
 * чат клиента получает ответ на свой replyJid, уведомление уходит только на managerJid. Отправляется только текст.
 * Каждое исходящее: ID от sender.newMessageId, запись в outbound_ids ДО отправки (иначе эхо от WhatsApp придёт раньше
 * записи и бот примет себя за человека), затем sendText и setResult 'sent' или 'failed'; сбой отправки пробрасывается.
 * Сообщение в чат клиента после отправки сохраняется в истории как сообщение бота (author 'bot', ID отправки).
 * Проверки перед отправкой в чат клиента по порядку, сразу перед sendText и без ожиданий между ними: закрытый режим
 * (номер чата из testAllowlist; номер неизвестен => отказ), статус manager (кроме фразы передачи: чат уже у менеджера;
 * статус перечитывается: человек мог подключиться, пока LLM писал ответ), неотвеченное входящее replyToWaId, лимиты
 * исходящих. «Печатает» с паузой (messaging/typing.ts) показывает конвейер до вызова: здесь паузы нет, иначе клиент
 * ждал бы дважды. Лимиты за скользящий час: CLIENT_SENDS_PER_CHAT_PER_HOUR на чат и CLIENT_SENDS_PER_HOUR на все чаты;
 * уведомления менеджеру по квотам MANAGER_NOTIFY_PER_HOUR раздельно по kind, нет managerJid => 'no_manager'.
 * Фразы передачи фиксированные по поводу, вариант выбирает random; фраза про голосовое одна, origin 'voice_notice'.
 * TODO(этап 3): аварийный выключатель автоответов (итог 'disabled'): нужен источник флага (настройка или панель).
 * TODO(этап 6): sendFromPanel пишет с origin 'panel' и переводит чат в статус manager (by 'panel').
 */
export function createOutbox(deps: OutboxDeps): Outbox {
  const quotas = createSendQuotas(deps.clock);
  return {
    sendBotReply: (chatId, text, replyToWaId) =>
      sendToClient(
        deps,
        quotas,
        { chatId, replyToWaId, origin: 'bot_reply', text },
        silentForManager,
      ),
    sendHandoffNotice: (chatId, notice, replyToWaId) => {
      const text = handoffPhrase(notice, deps.random);
      return sendToClient(
        deps,
        quotas,
        { chatId, replyToWaId, origin: 'handoff_notice', text },
        ignoreStatus,
      );
    },
    sendVoiceNotice: (chatId, replyToWaId) =>
      sendToClient(
        deps,
        quotas,
        { chatId, replyToWaId, origin: 'voice_notice', text: VOICE_NOTICE_TEXT },
        silentForManager,
      ),
    notifyManager: (text, kind) => notifyManager(deps, quotas, text, kind),
    sendFromPanel: () => notImplemented('этап 6', 'messaging/outbox.sendFromPanel'),
  };
}

async function sendToClient<Extra extends string>(
  deps: OutboxDeps,
  quotas: SendQuotas,
  request: ClientSend,
  statusGate: StatusGate<Extra>,
): Promise<'sent' | Blocked<Extra>> {
  assertSendable(request.text);
  // Статус перечитывается здесь, без ожидания до отправки: человек мог подключиться, пока LLM писал ответ.
  const chat = requireChat(deps.chats, request.chatId);
  const blocked = gate(deps, chat, request, statusGate);
  if (blocked !== null) return blocked;
  if (!quotas.takeClientSlot(chat.id)) return 'skipped_limit';
  const outgoing: Outgoing = {
    chatId: chat.id,
    jid: chat.identity.replyJid,
    origin: request.origin,
    text: request.text,
  };
  const waId = await deliver(deps, outgoing);
  deps.messages.insertIfNew({
    chatId: chat.id,
    waId,
    author: 'bot',
    kind: 'text',
    text: request.text,
    tsMs: deps.clock.now(),
  });
  return 'sent';
}

async function notifyManager(
  deps: OutboxDeps,
  quotas: SendQuotas,
  text: string,
  kind: ManagerNotifyKind,
): Promise<ManagerNotifyResult> {
  assertSendable(text);
  if (deps.managerJid === null) return { status: 'no_manager' };
  if (!quotas.takeNotifySlot(kind)) return { status: 'skipped_limit' };
  const waId = await deliver(deps, {
    chatId: null,
    jid: deps.managerJid,
    origin: 'manager_notify',
    text,
  });
  return { status: 'sent', waId };
}

function gate<Extra extends string>(
  deps: OutboxDeps,
  chat: Chat,
  request: ClientSend,
  statusGate: StatusGate<Extra>,
): Blocked<Extra> | null {
  if (!isChatAllowlisted(deps.testAllowlist, chat.identity)) return 'skipped_test_mode';
  const status = statusGate(chat);
  if (status !== null) return status;
  if (!deps.messages.isUnansweredInbound(chat.id, request.replyToWaId)) return 'skipped_no_inbound';
  return null;
}

async function deliver(deps: OutboxDeps, outgoing: Outgoing): Promise<WaMessageId> {
  const waId = deps.sender.newMessageId();
  deps.outboundIds.register({ ...outgoing, waId, nowMs: deps.clock.now() });
  try {
    await deps.sender.sendText(outgoing.jid, outgoing.text, waId);
  } catch (error: unknown) {
    deps.outboundIds.setResult(waId, 'failed');
    throw error;
  }
  deps.outboundIds.setResult(waId, 'sent');
  return waId;
}

function createSendQuotas(clock: Clock): SendQuotas {
  let clientSends: readonly Stamp<ChatId>[] = [];
  let notifySends: readonly Stamp<ManagerNotifyKind>[] = [];
  return {
    takeClientSlot(chatId: ChatId): boolean {
      const nowMs = clock.now();
      const recent = withinHour(clientSends, nowMs);
      const allowed =
        recent.length < CLIENT_SENDS_PER_HOUR &&
        countOf(recent, chatId) < CLIENT_SENDS_PER_CHAT_PER_HOUR;
      clientSends = allowed ? [...recent, { key: chatId, atMs: nowMs }] : recent;
      return allowed;
    },
    takeNotifySlot(kind: ManagerNotifyKind): boolean {
      const nowMs = clock.now();
      const recent = withinHour(notifySends, nowMs);
      const allowed = countOf(recent, kind) < MANAGER_NOTIFY_PER_HOUR[kind];
      notifySends = allowed ? [...recent, { key: kind, atMs: nowMs }] : recent;
      return allowed;
    },
  };
}

function withinHour<K>(stamps: readonly Stamp<K>[], nowMs: number): readonly Stamp<K>[] {
  return stamps.filter((stamp) => stamp.atMs > nowMs - HOUR_MS);
}

function countOf<K>(stamps: readonly Stamp<K>[], key: K): number {
  return stamps.filter((stamp) => stamp.key === key).length;
}

function handoffPhrase(notice: HandoffNotice, random: () => number): string {
  if (notice.reason === 'complaint') {
    return pick(notice.stopRequested ? APOLOGY_ONLY : APOLOGY_PASSED, random);
  }
  return pick(HANDOFF_PHRASES[notice.reason], random);
}

/** Вариант по случайности от 0 до 1; значение вне диапазона прижимается к краю, NaN даёт первый вариант. */
function pick(variants: Variants, random: () => number): string {
  const index = Math.min(Math.max(Math.floor(random() * variants.length), 0), variants.length - 1);
  return variants[index] ?? variants[0];
}

function requireChat(chats: ChatsRepo, chatId: ChatId): Chat {
  const chat = chats.getById(chatId);
  if (chat === null) throw new Error(`Чат #${chatId} не найден: сообщение не отправлено`);
  return chat;
}

function assertSendable(text: string): void {
  if (text.trim() === '') throw new Error('Пустой текст не отправляется');
}
