import { createHash, randomBytes } from 'node:crypto';
import type { SessionLimits, SessionRecord, SessionsRepo } from '../db/sessions.js';
import type { Clock } from '../shared/clock.js';
import { cleanLine } from '../shared/text.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Сессия живёт 30 дней от входа и 7 дней без активности (решение владельца 30.10.2026). */
export const SESSION_LIMITS: SessionLimits = { maxAgeMs: 30 * DAY_MS, idleMs: 7 * DAY_MS };
/** Не больше 10 сессий на пользователя: вытесняются только его самые старые. */
export const MAX_SESSIONS_PER_USER = 10;
/** Отметка активности пишется не чаще раза в минуту: GET почти ничего не пишет в базу. */
export const TOUCH_INTERVAL_MS = 60_000;

const TOKEN_BYTES = 32;
/** Вид id сессии в cookie: 32 байта в base64url. Чужой вид даже не ищется в базе. */
const TOKEN_FORM = /^[A-Za-z0-9_-]{43}$/;
const USER_AGENT_MAX = 200;
const IP_MAX = 64;

export interface ClientInfo {
  readonly ip: string;
  readonly userAgent: string | undefined;
}

export interface StartedSession {
  /** Значение cookie: только у браузера, в базе лишь его SHA-256. */
  readonly token: string;
  readonly csrf: string;
  readonly id: number;
}

export interface SessionService {
  /** Новая сессия при входе: новый id, истёкшие убираются, у пользователя остаются 10 самых новых. */
  start(userId: number, client: ClientInfo): StartedSession;
  /** Живая сессия активного пользователя по значению cookie; иначе null. Ничего не пишет. */
  resolve(token: string | null): SessionRecord | null;
  /** Отметка активности (не чаще раза в минуту): продлевает срок простоя. */
  touch(session: SessionRecord, ip: string): void;
  /** Выход: сессия по значению cookie закрывается. */
  end(token: string | null): void;
  purgeExpired(): number;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Жива ли сессия: пользователь активен, не вышли 30 дней от входа и 7 дней без активности. */
export function isAlive(session: SessionRecord, nowMs: number): boolean {
  return (
    session.userActive &&
    nowMs < session.createdAt + SESSION_LIMITS.maxAgeMs &&
    nowMs < session.lastSeenAt + SESSION_LIMITS.idleMs
  );
}

export function createSessionService(repo: SessionsRepo, clock: Clock): SessionService {
  const validToken = (token: string | null): token is string =>
    token !== null && TOKEN_FORM.test(token);
  return {
    start(userId, client) {
      const nowMs = clock.now();
      repo.purgeExpired(nowMs, SESSION_LIMITS);
      repo.keepNewest(userId, MAX_SESSIONS_PER_USER - 1);
      const token = newToken();
      const csrf = newToken();
      const id = repo.insert(
        {
          tokenHash: hashToken(token),
          userId,
          csrf,
          ip: cleanLine(client.ip, IP_MAX),
          userAgent: cleanLine(client.userAgent ?? '', USER_AGENT_MAX),
        },
        nowMs,
      );
      return { token, csrf, id };
    },
    resolve(token) {
      if (!validToken(token)) return null;
      const session = repo.findByTokenHash(hashToken(token));
      return session !== null && isAlive(session, clock.now()) ? session : null;
    },
    touch(session, ip) {
      const nowMs = clock.now();
      if (nowMs - session.lastSeenAt < TOUCH_INTERVAL_MS) return;
      repo.touch(session.id, nowMs, cleanLine(ip, IP_MAX));
    },
    end(token) {
      if (validToken(token)) repo.deleteByTokenHash(hashToken(token));
    },
    purgeExpired: () => repo.purgeExpired(clock.now(), SESSION_LIMITS),
  };
}
