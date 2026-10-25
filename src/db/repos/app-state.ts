import type Database from 'better-sqlite3';
import type { AppStateRepo } from '../../domain/ports.js';
import { notImplemented } from '../../shared/todo.js';

/**
 * Состояние приложения в SQLite (таблица app_state): момент привязки номера.
 * Бот работает только с сообщениями, отправленными после привязки (решение владельца).
 * TODO(этап 2): getLinkedAtMs читает linked_at_ms; setLinkedAtMs записывает с перезаписью (INSERT ... ON CONFLICT DO UPDATE). Когда писать, решает whatsapp/connection.ts: первая привязка и каждая новая (isNewLogin).
 * TODO(этап 2): только подготовленные запросы.
 */
export function createAppStateRepo(db: Database.Database): AppStateRepo {
  return notImplemented('этап 2', 'db/repos/app-state.createAppStateRepo');
}
