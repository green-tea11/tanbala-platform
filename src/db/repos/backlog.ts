import type Database from 'better-sqlite3';
import type { BacklogRepo } from '../../domain/ports.js';
import { notImplemented } from '../../shared/todo.js';

/**
 * Чаты простоя в SQLite (таблица backlog_chats): одна строка на чат, без потерь при падении и без дублей.
 * TODO(этап 2): markStale: INSERT ... ON CONFLICT(chat_id) DO UPDATE last_message_at = max(старое, новое); отметку notified_at не трогать, если чат уже был в уведомлении, а новое сообщение пришло позже: тогда сбросить notified_at, чтобы менеджер узнал о новом старом сообщении.
 * TODO(этап 2): listPending: строки без notified_at вместе с именем и номером из chats, по времени последнего сообщения.
 * TODO(этап 2): markNotified: notified_at = nowMs для переданных чатов одной транзакцией; только подготовленные запросы.
 */
export function createBacklogRepo(db: Database.Database): BacklogRepo {
  return notImplemented('этап 2', 'db/repos/backlog.createBacklogRepo');
}
