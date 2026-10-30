import type { Db } from './connection.js';

/**
 * Схема базы консоли. Время везде INTEGER, миллисекунды UTC. Пароли только хэшем scrypt, id сессий только SHA-256.
 * Пользователей не удаляют: только отключают (журнал ссылается на имена).
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 32),
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'manager')),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    ip TEXT NOT NULL,
    user_agent TEXT NOT NULL
  ) STRICT;
  CREATE INDEX sessions_by_user ON sessions (user_id, created_at);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    outcome TEXT,
    ip TEXT
  ) STRICT;
  CREATE INDEX audit_by_time ON audit_log (at);

  CREATE TABLE seen_marks (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind, item_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX seen_by_time ON seen_marks (at);
  `,
];

/** Применяет недостающие миграции по PRAGMA user_version, каждую в своей транзакции. */
export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  MIGRATIONS.slice(current).forEach((sql, index) => {
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${current + index + 1}`);
    })();
  });
}

export const SCHEMA_VERSION = MIGRATIONS.length;
