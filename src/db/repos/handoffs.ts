import type Database from 'better-sqlite3';
import type { HandoffsRepo } from '../../domain/ports.js';
import { notImplemented } from '../../shared/todo.js';

/**
 * Передачи чатов менеджеру в SQLite. Открытая передача на чат одна, поэтому все методы адресуются по chatId.
 * TODO(этап 5): open создаёт передачу с причиной, уровнем и снимком выжимки; частичный уникальный индекс: открытая уже есть => false.
 * TODO(этап 5): open и смену статуса чата выполнять в одной транзакции на общем соединении (handoff/handoff.ts).
 * TODO(этап 5): setManagerNotified хранит ID уведомления (null: не отправлено, видно в панели); resolve закрывает передачу.
 * TODO(этап 5): только подготовленные запросы.
 */
export function createHandoffsRepo(db: Database.Database): HandoffsRepo {
  return notImplemented('этап 5', 'db/repos/handoffs.createHandoffsRepo');
}
