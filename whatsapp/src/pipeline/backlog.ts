import type {
  BacklogRepo,
  ChatsRepo,
  Clock,
  Logger,
  MessagesRepo,
  UnitOfWork,
} from '../domain/ports.js';
import type { BacklogChat, ChatId, InboundMessage, NewMessage } from '../domain/types.js';
import { formatBacklogNotification } from '../handoff/notification.js';
import type { ManagerNotifier } from '../handoff/notifier.js';

/**
 * Сообщения клиентов, пришедшие за время простоя бота и старше порога BACKLOG_MAX_AGE_HOURS
 * (решение владельца): бот на них не отвечает, менеджер получает одно уведомление со списком чатов.
 */
export interface BacklogCollector {
  /**
   * Старое сообщение клиента (событие WaEvent 'stale'): сохранить и отметить чат в базе. Сам ничего не отправляет и
   * не отмечает сообщения прочитанными: менеджер увидит их непрочитанными. known_chats не пишет: это делает
   * pipeline/recorder.ts, который обрабатывает то же событие.
   */
  add(message: InboundMessage): void;
  /**
   * Офлайн-очередь разобрана (иногда дважды): одно уведомление о чатах простоя, о которых менеджеру ещё не сообщали.
   * Параллельные вызовы идут по очереди и не отправляют один список дважды. Отказ значит, что уведомление не
   * записалось в базу: чаты остаются в ожидании до следующего flush.
   */
  flush(): Promise<void>;
}

/** Зависимости сбора списка простоя. */
export interface BacklogCollectorDeps {
  chats: ChatsRepo;
  messages: MessagesRepo;
  /** Отметки простоя в базе: без потерь при падении и без дублей при повторной доставке. */
  backlog: BacklogRepo;
  /** Чат, сообщение и отметка простоя в add пишутся одной транзакцией. */
  unitOfWork: UnitOfWork;
  /** Запись уведомления в базу и отправка менеджеру с повтором при сбое (handoff/notifier.ts). */
  notifier: Pick<ManagerNotifier, 'notify'>;
  clock: Clock;
  logger: Logger;
  /** BACKLOG_MAX_AGE_HOURS в миллисекундах: порог простоя для заголовка уведомления. */
  backlogMaxAgeMs: number;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Создаёт сборщик списка простоя. add: чат через chats.upsertByIdentity без смены статуса (новый чат создаётся со
 * статусом bot), сообщение в историю через messages.insertIfNew (author client): панель показывает полную
 * переписку; insertIfNew вернул false (повторная доставка того же waId) => чат не отмечать, иначе backlog.markStale.
 * flush: список берётся из базы (backlog.listPending), а не из памяти. Чат, где после последнего старого сообщения
 * что-то произошло (свежее сообщение клиента, на которое бот отвечает обычным порядком, или уже ответил бот или
 * человек), в список не входит, его отметка закрывается без уведомления. Остальные чаты уходят одним уведомлением
 * (kind 'backlog'); отметка «менеджеру сообщили» ставится, как только уведомление записано в базу, при любом его
 * статусе: повтор отправки ведёт notifier, а в панели дублей нет. Если клиент потом напишет снова, бот отвечает на
 * новое сообщение как обычно; если менеджер ответит с телефона, сработает перехват (pipeline/takeover.ts).
 * Справка: в закрытом режиме сюда попадают только чаты из TEST_ALLOWLIST, остальные отсекает whatsapp/inbound.ts.
 */
export function createBacklogCollector(deps: BacklogCollectorDeps): BacklogCollector {
  let queue: Promise<void> = Promise.resolve();
  return {
    add: (message) => {
      addStale(deps, message);
    },
    flush: () => {
      const run = queue.then(() => flushOnce(deps));
      // Сбой одного flush не должен останавливать следующие.
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

function addStale(deps: BacklogCollectorDeps, message: InboundMessage): void {
  const nowMs = deps.clock.now();
  const saved = deps.unitOfWork.run(() => {
    const chat = deps.chats.upsertByIdentity(message.identity, message.pushName, nowMs);
    const isNew = deps.messages.insertIfNew(toNewMessage(chat.id, message));
    if (isNew) deps.backlog.markStale(chat.id, message.tsMs);
    return { chatId: chat.id, isNew };
  });
  if (!saved.isNew) {
    deps.logger.debug({ chatId: saved.chatId }, 'Повтор старого сообщения пропущен');
    return;
  }
  deps.logger.info(
    { chatId: saved.chatId, kind: message.content.kind },
    'Старое входящее сохранено (простой): чат отмечен для менеджера',
  );
}

function toNewMessage(chatId: ChatId, message: InboundMessage): NewMessage {
  const { waId, content, tsMs } = message;
  const columns =
    content.kind === 'text'
      ? ({ kind: 'text', text: content.text } as const)
      : ({ kind: content.kind, text: null } as const);
  return { chatId, waId, author: 'client', ...columns, tsMs };
}

async function flushOnce(deps: BacklogCollectorDeps): Promise<void> {
  const pending = deps.backlog.listPending();
  if (pending.length === 0) return;
  const active = pending.filter((chat) => hasLaterMessage(deps.messages, chat));
  if (active.length > 0) {
    markNotified(deps, active);
    deps.logger.info({ count: active.length }, 'Чаты простоя уже в работе: в список не вошли');
  }
  const silent = pending.filter((chat) => !active.includes(chat));
  if (silent.length === 0) return;
  const hours = Math.max(1, Math.round(deps.backlogMaxAgeMs / HOUR_MS));
  const status = await deps.notifier.notify(
    'backlog',
    null,
    formatBacklogNotification(silent, hours),
  );
  // Уведомление уже в базе (любой статус): повтор отправки ведёт notifier, чаты второй раз в список не попадут.
  markNotified(deps, silent);
  deps.logger.info({ count: silent.length, status }, 'Список простоя записан для менеджера');
}

/** После последнего старого сообщения в чате что-то появилось: свежее от клиента или ответ бота и человека. */
function hasLaterMessage(messages: MessagesRepo, chat: BacklogChat): boolean {
  const latest = messages.recent(chat.chatId, 1).at(-1);
  return latest !== undefined && latest.tsMs > chat.lastMessageAtMs;
}

function markNotified(deps: BacklogCollectorDeps, chats: readonly BacklogChat[]): void {
  deps.backlog.markNotified(
    chats.map((chat) => chat.chatId),
    deps.clock.now(),
  );
}
