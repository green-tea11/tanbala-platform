import { toNumber, type BaileysEventMap, type Chat, type WAMessage } from 'baileys';
import type {
  Clock,
  KnownChatSource,
  KnownChatsRepo,
  Logger,
  UnitOfWork,
} from '../domain/ports.js';
import type { Jid } from '../domain/types.js';
import type { WaSocket } from './connection-types.js';
import { classifyUpsert, type ClassifyContext, type WaEvent } from './inbound.js';
import { createLidResolver, jidOf, type LidResolver } from './lid-resolver.js';
import type { UpsertBatch } from './message-intake.js';

// Чаты, о которых узнала проба. Проба подключается сессией бота, и Baileys сразу забирает офлайн-очередь этого
// устройства и подтверждает её серверу: бот после пробы этих сообщений не получит. Правило этапа 8 (чаты с перепиской
// до выключения TEST_MODE ведёт менеджер) держится на known_chats, поэтому проба записывает туда чаты так же, как бот:
// только JID и время, без текста.

const MS_PER_SECOND = 1000;

/** База бота для пробы: только known_chats и транзакции. Открывает её точка входа, закрывает проба. */
export interface ProbeChatStore {
  readonly knownChats: KnownChatsRepo;
  readonly unitOfWork: UnitOfWork;
  close(): void;
}

/** Итог пробы по чатам: числа без JID и текста. */
export interface ProbeChatsSummary {
  /** Сколько сообщений личных чатов (без служебных) пришло пробе: бот их уже не получит. */
  readonly messages: number;
  /** Все ли чаты этих сообщений и синхронизации записаны в known_chats. */
  readonly complete: boolean;
}

/** Запись чатов из событий сокета пробы. */
export interface ProbeChats {
  /** Пачка событий сокета: история и сообщения встают в очередь записи по порядку. Синхронно, не бросает. */
  receive(events: Partial<BaileysEventMap>): void;
  /** Ждёт очередь, в том числе пачки, пришедшие во время ожидания. Не отклоняется. */
  idle(): Promise<void>;
  /** Новые пачки больше не принимаются: дальше база закрывается. Уже принятые дописываются, их ждёт idle. */
  stop(): void;
  /** Итог на этот момент; пока очередь не пуста, complete false. */
  summary(): ProbeChatsSummary;
}

export interface ProbeChatsDeps {
  readonly store: ProbeChatStore;
  /** Сокет пробы: сопоставление @lid и номера (как у бота, whatsapp/lid-resolver.ts). */
  readonly sock: Pick<WaSocket, 'user' | 'signalRepository'>;
  readonly logger: Logger;
  readonly clock: Clock;
}

/** Адрес чата и время активности для known_chats. */
interface Touch {
  readonly jid: Jid;
  readonly atMs: number;
}

/** Разбор одного сообщения: сообщение ли это личного чата, адреса его чата и удался ли разбор. */
interface MessageRead {
  readonly counted: boolean;
  readonly touches: readonly Touch[];
  readonly failed: boolean;
}

const NOT_CHAT: MessageRead = { counted: false, touches: [], failed: false };

/**
 * Разбор как у бота (whatsapp/inbound.classifyUpsert: та же нормализация адресов и тот же отбор личных чатов и
 * служебных сообщений), но без отсева: закрытый режим выключен, момент привязки 0, адресов менеджера и самого бота нет.
 * Так каждое сообщение личного чата, кроме служебного, даёт адреса чата. Лишний чат в known_chats безопасен (он
 * просто достанется менеджеру), пропущенный нарушил бы правило этапа 8.
 */
const OPEN_CONTEXT: Omit<ClassifyContext, 'nowMs' | 'chatPhone' | 'upsertType'> = {
  managerJids: new Set(),
  selfJids: new Set(),
  linkedAtMs: 0,
  backlogMaxAgeMs: Number.MAX_SAFE_INTEGER,
  testAllowlist: null,
};

function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Запись чатов пробы, как у бота (pipeline/recorder.ts): сообщение клиента даёт все адреса чата (номер собеседника
 * через whatsapp/lid-resolver.ts), своё сообщение и пропуски с адресом дают адрес чата, служебные ничего. Чаты
 * синхронизации (messaging-history.set) с временем последнего сообщения, без времени с моментом записи. Каждая пачка
 * пишется одной транзакцией. Сбой разбора или записи: в лог имя ошибки, итог complete false; сообщение, которое не
 * разобралось, всё равно считается. В лог ни JID, ни текста.
 */
export function createProbeChats(deps: ProbeChatsDeps): ProbeChats {
  const resolver = createLidResolver(deps.sock, deps.logger);
  let messages = 0;
  let complete = true;
  let stopped = false;
  const queue = createTaskQueue((error) => {
    complete = false;
    deps.logger.error({ errorName: errorNameOf(error) }, 'Проба не записала чаты в known_chats');
  });
  const recordMessages = async (batch: UpsertBatch): Promise<void> => {
    const reads = await Promise.all(
      batch.messages.map((message) => readMessage(message, batch.type, resolver, deps)),
    );
    messages += reads.filter((read) => read.counted).length;
    if (reads.some((read) => read.failed)) complete = false;
    write(
      deps.store,
      reads.flatMap((read) => read.touches),
      'message',
    );
  };
  return {
    receive: (events) => {
      if (stopped) return;
      const history = events['messaging-history.set'];
      if (history !== undefined) queue.enqueue(() => recordHistory(deps, history.chats));
      const upsert = events['messages.upsert'];
      if (upsert !== undefined) queue.enqueue(() => recordMessages(upsert));
    },
    idle: () => queue.idle(),
    stop: () => {
      stopped = true;
    },
    // Пачка, которая ещё не записана, значит неполный итог: так при сроке закрытия итог не врёт.
    summary: () => ({ messages, complete: complete && queue.pending() === 0 }),
  };
}

/** Очередь задач строго по порядку: сбой задачи уходит в onFailure, следующие задачи идут дальше. */
interface TaskQueue {
  enqueue(task: () => Promise<void> | void): void;
  /** Ждёт все задачи, в том числе поставленные во время ожидания. Не отклоняется. */
  idle(): Promise<void>;
  /** Сколько задач ещё не закончено. */
  pending(): number;
}

function createTaskQueue(onFailure: (error: unknown) => void): TaskQueue {
  let pending = 0;
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue: (task) => {
      pending += 1;
      tail = tail
        .then(task)
        .catch(onFailure)
        .finally(() => {
          pending -= 1;
        });
    },
    idle: async () => {
      let current: Promise<void>;
      do {
        current = tail;
        await current;
      } while (current !== tail);
    },
    pending: () => pending,
  };
}

async function readMessage(
  message: WAMessage,
  upsertType: UpsertBatch['type'],
  resolver: LidResolver,
  deps: ProbeChatsDeps,
): Promise<MessageRead> {
  try {
    const chatPhone = await resolver.chatPhone(message.key);
    const context = { ...OPEN_CONTEXT, nowMs: deps.clock.now(), chatPhone, upsertType };
    const touches = touchesOf(classifyUpsert(message, context));
    return touches === null ? NOT_CHAT : { counted: true, touches, failed: false };
  } catch (error: unknown) {
    deps.logger.error(
      { errorName: errorNameOf(error) },
      'Проба не разобрала сообщение: его чат мог не попасть в known_chats',
    );
    return { counted: true, touches: [], failed: true };
  }
}

/** Адреса чата из разбора, как их пишет бот; null: не сообщение личного чата (служебное или не личный чат). */
function touchesOf(event: WaEvent): readonly Touch[] | null {
  if (event.type === 'client' || event.type === 'stale') {
    const { identity, tsMs } = event.message;
    const jids = new Set(
      [identity.replyJid, identity.lidJid, identity.pnJid].filter((jid) => jid !== null),
    );
    return [...jids].map((jid) => ({ jid, atMs: tsMs }));
  }
  if (event.type === 'own') return [{ jid: event.message.chatJid, atMs: event.message.tsMs }];
  return 'chatJid' in event ? [{ jid: event.chatJid, atMs: event.tsMs }] : null;
}

function recordHistory(deps: ProbeChatsDeps, chats: readonly Chat[]): void {
  const nowMs = deps.clock.now();
  const touches = chats.flatMap((chat): Touch[] => {
    const jid = jidOf(chat.id);
    return jid === null ? [] : [{ jid, atMs: lastMessageMs(chat) ?? nowMs }];
  });
  write(deps.store, touches, 'history');
  if (touches.length > 0) {
    deps.logger.info(
      { count: touches.length },
      `Проба: чатов синхронизации записано в known_chats: ${touches.length}`,
    );
  }
}

/** Пачка одной транзакцией: всё или ничего. */
function write(store: ProbeChatStore, touches: readonly Touch[], source: KnownChatSource): void {
  if (touches.length === 0) return;
  store.unitOfWork.run(() => {
    for (const { jid, atMs } of touches) store.knownChats.touch(jid, atMs, source);
  });
}

/** Время последнего сообщения чата из синхронизации (секунды Baileys => мс), как в whatsapp/message-intake.ts. */
function lastMessageMs(chat: Chat): number | null {
  const seconds = Math.max(
    toNumber(chat.conversationTimestamp),
    chat.lastMessageRecvTimestamp ?? 0,
  );
  return seconds > 0 ? seconds * MS_PER_SECOND : null;
}
