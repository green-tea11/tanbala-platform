import type Database from 'better-sqlite3';
import type { UnitOfWork } from '../domain/ports.js';
import { notImplemented } from '../shared/todo.js';

/**
 * Открывает базу SQLite (DATABASE_PATH): диалоги, статусы, выжимки клиентов.
 * TODO(этап 2): создать папку файла; pragma journal_mode = WAL, foreign_keys = ON, busy_timeout.
 * TODO(этап 8): на VPS права 600 на файл базы; файлы -wal и -shm и бэкапы тоже содержат персональные данные.
 */
export function openDatabase(path: string): Database.Database {
  return notImplemented('этап 2', 'db/connection.openDatabase');
}

/**
 * Транзакции для нескольких записей подряд (перехват чата, передача менеджеру). Все репозитории на этом же соединении.
 * TODO(этап 3): run(work) через db.transaction(work)() better-sqlite3: синхронно, при исключении откат.
 */
export function createUnitOfWork(db: Database.Database): UnitOfWork {
  return notImplemented('этап 3', 'db/connection.createUnitOfWork');
}
