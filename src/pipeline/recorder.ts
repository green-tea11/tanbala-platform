import type {
  BacklogRepo,
  ChatsRepo,
  Clock,
  KnownChatsRepo,
  Logger,
  MessagesRepo,
  UnitOfWork,
} from '../domain/ports.js';
import type {
  Author,
  Chat,
  ChatId,
  ChatIdentity,
  InboundMessage,
  Jid,
  MessageContent,
  MessageKind,
  NewMessage,
  OwnMessage,
} from '../domain/types.js';
import type { HistoryChat } from '../whatsapp/connection.js';
import type { IgnoreReason, WaEvent } from '../whatsapp/inbound.js';

/** Зависимости записи входящих этапа 2. */
export interface InboundRecorderDeps {
  chats: ChatsRepo;
  messages: MessagesRepo;
  /** Отметки чатов простоя: уведомление менеджеру по ним отправит этап 3. */
  backlog: BacklogRepo;
  /** Чаты рабочего номера с перепиской для правила этапа 8: только JID и время. */
  knownChats: KnownChatsRepo;
  /** Чат, сообщение и отметки пишутся одной транзакцией: всё или ничего. */
  unitOfWork: UnitOfWork;
  logger: Logger;
  clock: Clock;
}

/** Запись событий WhatsApp: только записывает, ничего не отправляет и не отмечает прочитанным. */
export interface InboundRecorder {
  /**
   * Разобранное событие whatsapp/inbound.ts. Для client и stale: чат и новое ли сообщение (main отдаёт в очередь
   * ответа только новые); для own и ignore null. Сбой записи приходит отказом промиса.
   */
  onEvent(event: WaEvent): Promise<RecordedInbound | null>;
  /** Чаты первой синхронизации (messaging-history.set) в known_chats одной транзакцией. */
  onHistoryChats(chats: readonly HistoryChat[]): void;
  /** Сколько сообщений пропущено с запуска по каждой причине: снимок, следующие события его не меняют. */
  ignoreStats(): IgnoreStats;
}

/** Счётчики пропусков по причинам whatsapp/inbound.ts. */
export type IgnoreStats = Readonly<Record<IgnoreReason, number>>;

/** Итог записи входящего клиента: чат и было ли сообщение новым (false: повторная доставка того же waId). */
export interface RecordedInbound {
  readonly chatId: ChatId;
  readonly isNew: boolean;
}

type IgnoreEvent = Extract<WaEvent, { readonly type: 'ignore' }>;

/**
 * Все причины с нуля; порядок ключей задаёт порядок в сводке main: сначала редкие, потом частые.
 * Новая причина в IgnoreReason без ключа здесь не скомпилируется.
 */
const ZERO_STATS: IgnoreStats = Object.freeze({
  manager: 0,
  self: 0,
  before_link: 0,
  undecryptable: 0,
  not_allowlisted: 0,
  service: 0,
  protocol: 0,
});

/**
 * Редкие пропуски: строка в лог на каждое сообщение, чтобы было видно, почему бот его не сохранил (например, номер
 * менеджера в TEST_ALLOWLIST даёт manager). Частые (not_allowlisted, service, protocol) только в счётчиках.
 */
const LOGGED_REASONS: ReadonlySet<IgnoreReason> = new Set<IgnoreReason>([
  'manager',
  'self',
  'before_link',
  'undecryptable',
]);

/** Колонки сообщения из его содержимого: текст есть только у текстового, голосовое без текста до этапа 7. */
interface MessageColumns {
  readonly kind: MessageKind;
  readonly text: string | null;
}

/** Сервер адресов @lid: в OwnMessage.chatJid адрес уже нормализован (whatsapp/jid.normalizeJid). */
const LID_SUFFIX = '@lid';

/**
 * Записывает события WhatsApp (сам ничего не отправляет, не отмечает прочитанным, LLM не вызывает).
 * client: чат через upsertByIdentity (имя из профиля обновляется, статус не меняется), сообщение клиента и все
 * адреса чата в known_chats, одной транзакцией. stale: то же плюс отметка простоя временем сообщения; повторная
 * доставка того же waId чат не отмечает (pipeline/backlog.ts). own: чат, найденный по адресу, или новый чат с этим
 * адресом, и его адреса в known_chats; само сообщение не пишется: эхо бота от человека отличает pipeline/takeover.ts,
 * он и пишет сообщение человека (иначе ответ бота попал бы в историю как сообщение с телефона, а менеджер, написавший
 * первым, не нашёл бы чата). ignore: счётчик по причине (ignoreStats); редкие причины
 * (manager, self, before_link, undecryptable) ещё и строкой в лог, частые только счётчиком. ignore с адресом
 * (not_allowlisted, before_link и undecryptable: сообщение не расшифровалось, но чат с перепиской) запоминает чат
 * в known_chats. Логи без текста, имён, номеров и адресов: только ID чата, вид сообщения или причина пропуска.
 * Записи синхронные (better-sqlite3), stop() здесь не вызывается и не ожидается.
 */
export function createInboundRecorder(deps: InboundRecorderDeps): InboundRecorder {
  let stats = ZERO_STATS;
  const recordIgnore = (event: IgnoreEvent): void => {
    stats = incremented(stats, event.reason);
    if (LOGGED_REASONS.has(event.reason)) {
      deps.logger.info(
        { event: event.type, reason: event.reason },
        `Сообщение пропущено: причина ${event.reason}`,
      );
    }
    if ('chatJid' in event) deps.knownChats.touch(event.chatJid, event.tsMs, 'message');
  };
  const record = (event: WaEvent): RecordedInbound | null => {
    if (event.type === 'client' || event.type === 'stale') {
      return recordInbound(deps, event.message, event.type === 'stale');
    }
    if (event.type === 'own') recordOwn(deps, event.message);
    else recordIgnore(event);
    return null;
  };
  return {
    // Промис нужен порту WhatsAppDeps.onEvent: исключение записи становится его отказом, а не броском.
    onEvent: (event) =>
      new Promise<RecordedInbound | null>((resolve) => {
        resolve(record(event));
      }),
    onHistoryChats: (chats) => {
      recordHistory(deps, chats);
    },
    // Счётчики заменяются целиком и заморожены: отданный снимок не меняется.
    ignoreStats: () => stats,
  };
}

function incremented(stats: IgnoreStats, reason: IgnoreReason): IgnoreStats {
  return Object.freeze({ ...stats, [reason]: stats[reason] + 1 });
}

function recordInbound(
  deps: InboundRecorderDeps,
  message: InboundMessage,
  stale: boolean,
): RecordedInbound {
  const nowMs = deps.clock.now();
  const saved = deps.unitOfWork.run((): RecordedInbound => {
    const chat = deps.chats.upsertByIdentity(message.identity, message.pushName, nowMs);
    const isNew = deps.messages.insertIfNew(toNewMessage(chat.id, 'client', message));
    if (stale && isNew) deps.backlog.markStale(chat.id, message.tsMs);
    touchChat(deps.knownChats, chat, message.tsMs);
    return { chatId: chat.id, isNew };
  });
  const { kind } = columnsOf(message.content);
  const text = stale
    ? `Сохранено старое входящее (простой): чат #${saved.chatId} отмечен для менеджера, вид ${kind}`
    : `Сохранено входящее: чат #${saved.chatId}, вид ${kind}`;
  logSaved(deps.logger, saved, kind, text);
  return saved;
}

/** Своё сообщение: чат по адресу (или новый с этим адресом) и known_chats; сообщение пишет pipeline/takeover.ts. */
function recordOwn(deps: InboundRecorderDeps, message: OwnMessage): void {
  const nowMs = deps.clock.now();
  deps.unitOfWork.run(() => {
    const chat =
      deps.chats.findByJid(message.chatJid) ??
      deps.chats.upsertByIdentity(identityOf(message.chatJid), null, nowMs);
    touchChat(deps.knownChats, chat, message.tsMs);
  });
}

/** Чаты синхронизации без времени получают момент синхронизации: чат всё равно известен до переключения этапа 8. */
function recordHistory(deps: InboundRecorderDeps, chats: readonly HistoryChat[]): void {
  if (chats.length === 0) return;
  const nowMs = deps.clock.now();
  deps.unitOfWork.run(() => {
    for (const chat of chats) {
      deps.knownChats.touch(chat.jid, chat.lastMessageAtMs ?? nowMs, 'history');
    }
  });
  deps.logger.info(
    { count: chats.length },
    `Первая синхронизация: чатов записано в known_chats: ${chats.length}`,
  );
}

function toNewMessage(chatId: ChatId, author: Author, message: InboundMessage): NewMessage {
  const { waId, content, tsMs } = message;
  return { chatId, waId, author, ...columnsOf(content), tsMs };
}

function columnsOf(content: MessageContent): MessageColumns {
  return content.kind === 'text'
    ? { kind: 'text', text: content.text }
    : { kind: content.kind, text: null };
}

/** Все известные адреса чата: при переходе WhatsApp с номера на @lid чат узнаётся по любому из них. */
function touchChat(knownChats: KnownChatsRepo, chat: Chat, atMs: number): void {
  const { replyJid, lidJid, pnJid } = chat.identity;
  const addresses = new Set([replyJid, lidJid, pnJid].filter((jid) => jid !== null));
  for (const jid of addresses) knownChats.touch(jid, atMs, 'message');
}

/** Адреса нового чата по одному нормализованному JID: @lid или адрес с номером. */
function identityOf(jid: Jid): ChatIdentity {
  const isLid = jid.endsWith(LID_SUFFIX);
  return { replyJid: jid, lidJid: isLid ? jid : null, pnJid: isLid ? null : jid };
}

function logSaved(logger: Logger, saved: RecordedInbound, kind: MessageKind, text: string): void {
  if (!saved.isNew) {
    logger.debug({ chatId: saved.chatId }, `Повтор сообщения пропущен: чат #${saved.chatId}`);
    return;
  }
  logger.info({ chatId: saved.chatId, kind }, text);
}
