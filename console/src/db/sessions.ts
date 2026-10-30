import type { Db } from './connection.js';
import type { Role } from './users.js';

/** Сессия вместе с текущими ролью и «активен» пользователя (читаются из базы на каждом запросе). */
export interface SessionRecord {
  readonly id: number;
  readonly userId: number;
  readonly userName: string;
  readonly role: Role;
  readonly userActive: boolean;
  readonly csrf: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly ip: string;
  readonly userAgent: string;
}

export interface NewSession {
  readonly tokenHash: string;
  readonly userId: number;
  readonly csrf: string;
  readonly ip: string;
  readonly userAgent: string;
}

export interface SessionLimits {
  /** Сессия живёт не дольше этого от входа. */
  readonly maxAgeMs: number;
  /** Сессия без активности дольше этого истекает. */
  readonly idleMs: number;
}

export interface SessionsRepo {
  insert(session: NewSession, nowMs: number): number;
  findByTokenHash(tokenHash: string): SessionRecord | null;
  touch(id: number, nowMs: number, ip: string): void;
  deleteById(id: number): boolean;
  deleteByTokenHash(tokenHash: string): void;
  deleteForUser(userId: number): number;
  /** Закрывает все сессии, кроме одной (текущей): «выйти везде». */
  deleteAllExcept(id: number): number;
  /** Оставляет у пользователя не больше keep самых новых сессий: вытесняются только его самые старые. */
  keepNewest(userId: number, keep: number): number;
  purgeExpired(nowMs: number, limits: SessionLimits): number;
  listAll(): readonly SessionRecord[];
}

interface SessionRow {
  id: number;
  user_id: number;
  user_name: string;
  role: string;
  active: number;
  csrf: string;
  created_at: number;
  last_seen_at: number;
  ip: string;
  user_agent: string;
}

const SELECT_JOINED = `
  SELECT s.id, s.user_id, u.name AS user_name, u.role, u.active, s.csrf, s.created_at, s.last_seen_at,
         s.ip, s.user_agent
  FROM sessions s JOIN users u ON u.id = s.user_id`;

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    role: row.role === 'owner' ? 'owner' : 'manager',
    userActive: row.active === 1,
    csrf: row.csrf,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    ip: row.ip,
    userAgent: row.user_agent,
  };
}

/** Сессии в SQLite: в базе только SHA-256 от id из cookie, сам id нигде не хранится. */
export function createSessionsRepo(db: Db): SessionsRepo {
  const insert = db.prepare(
    `INSERT INTO sessions (token_hash, user_id, csrf, created_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const byHash = db.prepare<[string], SessionRow>(`${SELECT_JOINED} WHERE s.token_hash = ?`);
  const all = db.prepare<[], SessionRow>(`${SELECT_JOINED} ORDER BY s.last_seen_at DESC`);
  const touch = db.prepare('UPDATE sessions SET last_seen_at = ?, ip = ? WHERE id = ?');
  const deleteById = db.prepare('DELETE FROM sessions WHERE id = ?');
  const deleteByHash = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const deleteForUser = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  const deleteAllExcept = db.prepare('DELETE FROM sessions WHERE id <> ?');
  const keepNewest = db.prepare(
    `DELETE FROM sessions WHERE user_id = ? AND id NOT IN (
       SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
  );
  const purge = db.prepare('DELETE FROM sessions WHERE created_at <= ? OR last_seen_at <= ?');

  return {
    insert(session, nowMs) {
      const result = insert.run(
        session.tokenHash,
        session.userId,
        session.csrf,
        nowMs,
        nowMs,
        session.ip,
        session.userAgent,
      );
      return Number(result.lastInsertRowid);
    },
    findByTokenHash(tokenHash) {
      const row = byHash.get(tokenHash);
      return row === undefined ? null : toRecord(row);
    },
    touch(id, nowMs, ip) {
      touch.run(nowMs, ip, id);
    },
    deleteById: (id) => deleteById.run(id).changes > 0,
    deleteByTokenHash(tokenHash) {
      deleteByHash.run(tokenHash);
    },
    deleteForUser: (userId) => deleteForUser.run(userId).changes,
    deleteAllExcept: (id) => deleteAllExcept.run(id).changes,
    keepNewest: (userId, keep) => keepNewest.run(userId, userId, keep).changes,
    purgeExpired: (nowMs, limits) =>
      purge.run(nowMs - limits.maxAgeMs, nowMs - limits.idleMs).changes,
    listAll: () => all.all().map(toRecord),
  };
}
