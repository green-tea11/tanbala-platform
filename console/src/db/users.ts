import type { Db } from './connection.js';

export type Role = 'owner' | 'manager';
export const ROLES: readonly Role[] = ['owner', 'manager'];

/** Пользователь консоли без хэша пароля. */
export interface User {
  readonly id: number;
  readonly name: string;
  readonly role: Role;
  readonly active: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Пользователь с хэшем пароля: только для проверки входа. */
export interface UserWithHash extends User {
  readonly passwordHash: string;
}

export interface NewUser {
  readonly name: string;
  readonly passwordHash: string;
  readonly role: Role;
}

/** Такое имя уже занято. */
export class UserExistsError extends Error {
  override readonly name = 'UserExistsError';
}

interface UserRow {
  id: number;
  name: string;
  password_hash: string;
  role: string;
  active: number;
  created_at: number;
  updated_at: number;
}

function toRole(value: string): Role {
  return value === 'owner' ? 'owner' : 'manager';
}

function toUser(row: UserRow): UserWithHash {
  return {
    id: row.id,
    name: row.name,
    role: toRole(row.role),
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    passwordHash: row.password_hash,
  };
}

function withoutHash(user: UserWithHash): User {
  const { passwordHash: _hash, ...rest } = user;
  return rest;
}

export interface UsersRepo {
  findByName(name: string): UserWithHash | null;
  list(): readonly User[];
  create(user: NewUser, nowMs: number): User;
  /** Новый пароль; все сессии пользователя закрываются. Нет такого имени: false. */
  setPassword(name: string, passwordHash: string, nowMs: number): boolean;
  /** Новая роль; все сессии пользователя закрываются. Нет такого имени: false. */
  setRole(name: string, role: Role, nowMs: number): boolean;
  /** Отключение закрывает все сессии пользователя; включение сессий не создаёт. Нет такого имени: false. */
  setActive(name: string, active: boolean, nowMs: number): boolean;
}

/**
 * Пользователи консоли. Смена пароля, роли и отключение закрывают сессии пользователя в той же транзакции:
 * роль и «активен» действуют сразу, а не после выхода.
 */
export function createUsersRepo(db: Db): UsersRepo {
  const byName = db.prepare<[string], UserRow>('SELECT * FROM users WHERE name = ?');
  const all = db.prepare<[], UserRow>('SELECT * FROM users ORDER BY name');
  const insert = db.prepare(
    'INSERT INTO users (name, password_hash, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
  );
  const closeSessions = db.prepare(
    'DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE name = ?)',
  );
  const updateAndClose = (sql: string, closes: boolean) => {
    const statement = db.prepare(sql);
    return db.transaction((name: string, ...values: unknown[]): boolean => {
      const changed = statement.run(...values, name).changes > 0;
      if (changed && closes) closeSessions.run(name);
      return changed;
    });
  };
  const setPassword = updateAndClose(
    'UPDATE users SET password_hash = ?, updated_at = ? WHERE name = ?',
    true,
  );
  const setRole = updateAndClose('UPDATE users SET role = ?, updated_at = ? WHERE name = ?', true);
  const disable = updateAndClose(
    'UPDATE users SET active = 0, updated_at = ? WHERE name = ?',
    true,
  );
  const enable = updateAndClose(
    'UPDATE users SET active = 1, updated_at = ? WHERE name = ?',
    false,
  );

  return {
    findByName(name) {
      const row = byName.get(name);
      return row === undefined ? null : toUser(row);
    },
    list() {
      return all.all().map((row) => withoutHash(toUser(row)));
    },
    create(user, nowMs) {
      if (byName.get(user.name) !== undefined) throw new UserExistsError(user.name);
      insert.run(user.name, user.passwordHash, user.role, nowMs, nowMs);
      const created = byName.get(user.name);
      if (created === undefined) throw new Error('Пользователь не сохранился');
      return withoutHash(toUser(created));
    },
    setPassword: (name, passwordHash, nowMs) => setPassword(name, passwordHash, nowMs),
    setRole: (name, role, nowMs) => setRole(name, role, nowMs),
    setActive: (name, active, nowMs) => (active ? enable(name, nowMs) : disable(name, nowMs)),
  };
}
