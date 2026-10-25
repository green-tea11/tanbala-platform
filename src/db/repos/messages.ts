import type Database from 'better-sqlite3';
import type { MessagesRepo } from '../../domain/ports.js';
import { notImplemented } from '../../shared/todo.js';

/**
 * История сообщений в SQLite.
 * TODO(этап 2): только подготовленные запросы; insertIfNew опирается на UNIQUE(chat_id, wa_id): дубль => false.
 * TODO(этап 3): isUnansweredInbound и markAnswered: ответ бота уходит только на неотвеченное входящее.
 * TODO(этап 3): recent отдаёт последние сообщения по времени (с видом и автором) для промпта и панели.
 */
export function createMessagesRepo(db: Database.Database): MessagesRepo {
  return notImplemented('этап 2', 'db/repos/messages.createMessagesRepo');
}
