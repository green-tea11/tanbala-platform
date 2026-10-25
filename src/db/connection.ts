import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { UnitOfWork } from '../domain/ports.js';

/** База только в памяти: для тестов. Ей не нужны ни папка, ни WAL. */
const MEMORY_PATH = ':memory:';

/** Сколько ждать, пока другое соединение отпустит блокировку, прежде чем упасть с SQLITE_BUSY. */
const BUSY_TIMEOUT_MS = 5000;

/**
 * Открывает базу SQLite (DATABASE_PATH): диалоги, статусы, выжимки клиентов.
 * Создаёт папку файла; WAL (чтение не ждёт записи), внешние ключи и ожидание блокировки BUSY_TIMEOUT_MS.
 * TODO(этап 8): на VPS права 600 на файл базы; файлы -wal и -shm и бэкапы тоже содержат персональные данные.
 */
export function openDatabase(path: string): Database.Database {
  const isMemory = path === MEMORY_PATH;
  if (!isMemory) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (!isMemory) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

/**
 * Транзакции для нескольких записей подряд (перехват чата, передача менеджеру). Все репозитории на этом же соединении.
 * run(work) выполняет work в db.transaction(...).immediate(): блокировка записи берётся сразу, поэтому прочитанное
 * внутри не устареет до записи. Синхронно; исключение откатывает всё и пробрасывается; вложенный run
 * становится точкой сохранения (SAVEPOINT). Промис из work запрещён: better-sqlite3 бросит TypeError и откатит.
 */
export function createUnitOfWork(db: Database.Database): UnitOfWork {
  return {
    run<T>(work: () => T): T {
      return db.transaction(work).immediate();
    },
  };
}
