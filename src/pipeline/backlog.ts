import type { BacklogRepo, ChatsRepo, Clock, Logger, MessagesRepo } from '../domain/ports.js';
import type { InboundMessage } from '../domain/types.js';
import type { Outbox } from '../messaging/outbox.js';
import { notImplemented } from '../shared/todo.js';

/**
 * Сообщения клиентов, пришедшие за время простоя бота и старше порога BACKLOG_MAX_AGE_HOURS
 * (решение владельца): бот на них не отвечает, менеджер получает одно уведомление со списком чатов.
 */
export interface BacklogCollector {
  /** Старое сообщение клиента (событие WaEvent 'stale'): сохранить и отметить чат в базе. */
  add(message: InboundMessage): void;
  /** Офлайн-очередь разобрана: одно уведомление о чатах простоя, о которых менеджеру ещё не сообщали. */
  flush(): Promise<void>;
}

/** Зависимости сбора списка простоя. */
export interface BacklogCollectorDeps {
  chats: ChatsRepo;
  messages: MessagesRepo;
  /** Отметки простоя в базе: без потерь при падении и без дублей при повторной доставке. */
  backlog: BacklogRepo;
  outbox: Outbox;
  clock: Clock;
  logger: Logger;
}

/**
 * Создаёт сборщик списка простоя.
 * TODO(этап 2): add: чат через chats.upsertByIdentity без смены статуса (новый чат создаётся со статусом bot), сообщение в историю через messages.insertIfNew (author client): панель показывает полную переписку. insertIfNew вернул false (повторная доставка того же waId) => чат не отмечать. Иначе backlog.markStale(chatId, tsMs). Не отвечать и НЕ отмечать прочитанными: менеджер увидит их непрочитанными.
 * TODO(этап 2): flush вызывает whatsapp/connection.ts в той же очереди событий после разбора офлайн-очереди: список берётся из базы (backlog.listPending), а не из памяти; пусто => ничего; иначе handoff/notification.formatBacklogNotification и outbox.notifyManager(text, 'backlog'); backlog.markNotified ставится только при status 'sent', иначе чаты остаются в ожидании до следующего flush (например после перезапуска). MANAGER_WHATSAPP не задан => только запись в лог, отметку не ставить.
 * TODO(этап 2): чат, где за время простоя есть и свежие сообщения (не старше порога), в список не включать: на него бот отвечает обычным порядком, один ответ на чат.
 * TODO(этап 2): если клиент потом напишет снова, бот отвечает на новое сообщение как обычно; если менеджер ответит с телефона, сработает перехват (pipeline/takeover.ts).
 * TODO(этап 2): в закрытом режиме сюда попадают только чаты из TEST_ALLOWLIST: остальные отсекает whatsapp/inbound.ts.
 */
export function createBacklogCollector(deps: BacklogCollectorDeps): BacklogCollector {
  return notImplemented('этап 2', 'pipeline/backlog.createBacklogCollector');
}
