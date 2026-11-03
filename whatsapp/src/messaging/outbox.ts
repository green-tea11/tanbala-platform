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
  ManagerNotificationKind,
  PhoneDigits,
  ReviewedText,
  SendOrigin,
  WaMessageId,
} from '../domain/types.js';
import { SafeError } from '../shared/safe-error.js';
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
export type ManagerNotifyKind = ManagerNotificationKind;

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
   * Сообщение клиенту при передаче, которое написала модель (hot, no_answer, asked_human) и которое прошло проверки
   * кодом и вторым вызовом: уходит вместо фиксированной фразы sendHandoffNotice. Те же проверки отправки, что и у неё:
   * закрытый режим, неотвеченное входящее replyToWaId, часовые лимиты исходящих; статус чата не проверяет (чат
   * уже у менеджера). ReviewedText: непроверенный текст не примет.
   */
  sendHandoffText(
    chatId: ChatId,
    text: ReviewedText,
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
  /**
   * Можно ли ответить в этот чат из панели: чат существует и проходит закрытый режим (TEST_ALLOWLIST), то же правило
   * messaging/allowlist.ts, что и в sendFromPanel. Только проверка: ничего не пишет и не отправляет. Панель зовёт её
   * до передачи чата менеджеру, чтобы заведомый отказ отправки не оставил чат у менеджера без сообщения.
   */
  canSendFromPanel(chatId: ChatId): boolean;
  /**
   * Ответ менеджера из панели от имени номера. Статус чата не меняет: перед отправкой маршрут панели
   * передаёт чат менеджеру через HandoffService (human_took_over, by 'panel'), а до этого проверяет текст
   * (panelTextProblem) и чат (canSendFromPanel). Отказ приходит PanelSendError, текст которого безопасно
   * показать на странице; сбой отправки пробрасывается как есть.
   */
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
 * Фраза передачи: один голос (решение владельца 29.10.2026). Бот сам уточнит у коллеги, без сроков и без обещаний за
 * другого человека; ровно этот текст, без вариантов.
 */
export const HANDOFF_TEXT = 'Уточню у коллеги и вернусь к вам.';

/**
 * Фраза передачи hot о решении и ориентире (решение владельца 30.10.2026): клиент спрашивает цену, сроки или договор, когда
 * задача понятна, или спрашивает цену третий раз (HandoffNotice.aboutPrice), и финал разговора. Ровно этот текст, без
 * вариантов.
 */
export const HOT_PRICE_HANDOFF_TEXT = 'Я уточню у коллеги решение и ориентир под вашу задачу.';

/** Наибольшая длина ответа из панели (без пробелов по краям), в символах. */
export const PANEL_TEXT_MAX_LENGTH = 4096;

/**
 * Отказ ответа из панели. Текст написан здесь и не содержит номеров и слов клиента, поэтому панель показывает его
 * менеджеру как есть; прочие ошибки отправки панель скрывает за общей фразой.
 */
export class PanelSendError extends SafeError {
  override readonly name = 'PanelSendError';
}

/**
 * Что не так с текстом ответа из панели: пустой после trim или длиннее PANEL_TEXT_MAX_LENGTH. null: текст годится.
 * Одна проверка для маршрута панели (до передачи чата менеджеру) и для sendFromPanel.
 */
export function panelTextProblem(text: string): string | null {
  const length = text.trim().length;
  if (length === 0) return 'Пустое сообщение не отправляется';
  if (length > PANEL_TEXT_MAX_LENGTH) {
    return `Сообщение длиннее ${PANEL_TEXT_MAX_LENGTH} символов: сократите его`;
  }
  return null;
}

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

// Фразы передачи (инструкция ответа, agent/prompts.ts): один голос «Уточню у коллеги и вернусь к вам», без тире
// и без времени. Варианты остались только у извинения при жалобе.
const ONE_VOICE: Variants = [HANDOFF_TEXT];
const APOLOGY_PASSED: Variants = [
  `Извините, пожалуйста. ${HANDOFF_TEXT}`,
  `Простите за неудобство. ${HANDOFF_TEXT}`,
  `Приношу извинения. ${HANDOFF_TEXT}`,
];
/** Клиент просит больше не писать: только извинение. */
const APOLOGY_ONLY: Variants = [
  'Извините, пожалуйста.',
  'Простите за беспокойство.',
  'Извините за беспокойство.',
];

const HANDOFF_PHRASES = {
  hot: ONE_VOICE,
  asked_human: ONE_VOICE,
  no_answer: ONE_VOICE,
  check_failed: ONE_VOICE,
  llm_error: ONE_VOICE,
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
 * Фразы передачи фиксированные по поводу: одна фраза HANDOFF_TEXT (у hot с aboutPrice HOT_PRICE_HANDOFF_TEXT), вариант
 * извинения при жалобе выбирает random; сообщение передачи, написанное моделью
 * (sendHandoffText), уходит с тем же origin 'handoff_notice' и теми же проверками, но своим текстом; фраза про
 * голосовое одна, origin 'voice_notice'.
 * sendFromPanel (ответ человека из панели): текст непустой после trim и не длиннее PANEL_TEXT_MAX_LENGTH, чат существует,
 * закрытый режим как у остальных отправок; запись в outbound_ids с origin 'panel' до отправки, затем сообщение в истории
 * (author 'human_panel', ID отправки). Статус чата не меняет, неотвеченное входящее не требует и часовые квоты бота не
 * расходует: пишет человек, и ему не должен мешать лимит от петель бота. Ошибки: PanelSendError (отказ с понятным
 * текстом) или сбой отправки как есть. canSendFromPanel (чат существует и проходит закрытый режим, как в sendFromPanel)
 * ничего не пишет и не отправляет: её зовёт панель до передачи чата менеджеру.
 * TODO(этап 3): аварийный выключатель автоответов (итог 'disabled'): нужен источник флага (настройка или панель).
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
    sendHandoffText: (chatId, text, replyToWaId) =>
      sendToClient(
        deps,
        quotas,
        { chatId, replyToWaId, origin: 'handoff_notice', text },
        ignoreStatus,
      ),
    sendVoiceNotice: (chatId, replyToWaId) =>
      sendToClient(
        deps,
        quotas,
        { chatId, replyToWaId, origin: 'voice_notice', text: VOICE_NOTICE_TEXT },
        silentForManager,
      ),
    notifyManager: (text, kind) => notifyManager(deps, quotas, text, kind),
    canSendFromPanel: (chatId) => canSendFromPanel(deps, chatId),
    sendFromPanel: (chatId, text) => sendFromPanel(deps, chatId, text),
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

function canSendFromPanel(deps: OutboxDeps, chatId: ChatId): boolean {
  const chat = deps.chats.getById(chatId);
  return chat !== null && isChatAllowlisted(deps.testAllowlist, chat.identity);
}

async function sendFromPanel(deps: OutboxDeps, chatId: ChatId, text: string): Promise<'sent'> {
  const problem = panelTextProblem(text);
  if (problem !== null) throw new PanelSendError(problem);
  const chat = deps.chats.getById(chatId);
  if (chat === null) throw new PanelSendError('Чат не найден: сообщение не отправлено');
  if (!isChatAllowlisted(deps.testAllowlist, chat.identity)) {
    throw new PanelSendError(
      'Закрытый режим: этот чат не из TEST_ALLOWLIST, сообщение не отправлено',
    );
  }
  const body = text.trim();
  const waId = await deliver(deps, {
    chatId: chat.id,
    jid: chat.identity.replyJid,
    origin: 'panel',
    text: body,
  });
  deps.messages.insertIfNew({
    chatId: chat.id,
    waId,
    author: 'human_panel',
    kind: 'text',
    text: body,
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
  if (notice.reason === 'hot' && notice.aboutPrice === true) return HOT_PRICE_HANDOFF_TEXT;
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
