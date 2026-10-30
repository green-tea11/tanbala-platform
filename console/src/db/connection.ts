import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './migrations.js';

export type Db = Database.Database;

/** Путь к базе в памяти: для тестов. */
export const IN_MEMORY = ':memory:';

/**
 * Открывает базу консоли (data/console.db): WAL, ожидание блокировки 5 с (команда user на сервере может писать
 * одновременно со службой), внешние ключи, миграции. Папка создаётся с правами только владельца.
 */
export function openDatabase(path: string): Db {
  if (path !== IN_MEMORY) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}
