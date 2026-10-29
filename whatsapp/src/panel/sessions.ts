import { randomBytes } from 'node:crypto';

/** Сессия входа в панель. Объект не меняется: продление создаёт новый. */
export interface Session {
  /** Непредсказуемый ID: единственное, что лежит в cookie. */
  readonly id: string;
  /** Токен CSRF этой сессии: скрытое поле каждой формы. */
  readonly csrf: string;
  readonly createdAtMs: number;
  /** Когда сессия истекает, если до тех пор не будет запросов (но не позже createdAtMs + maxLifetimeMs). */
  readonly expiresAtMs: number;
}

/** Сессии панели в памяти: после перезапуска бота вход нужен заново. */
export interface SessionStore {
  /** Новая сессия с новым ID и токеном CSRF: вход всегда выдаёт новый ID, прежний не переиспользуется. */
  create(nowMs: number): Session;
  /** Живая сессия, продлённая на простой; истёкшая удаляется. Нет ID, неизвестный ID, истёкшая => null. */
  find(id: string | null, nowMs: number): Session | null;
  destroy(id: string): void;
}

export interface SessionOptions {
  /** Сколько сессия живёт без запросов. */
  readonly idleTtlMs: number;
  /** Сколько сессия живёт всего, как бы часто ей ни пользовались. */
  readonly maxLifetimeMs: number;
  /** Сколько сессий хранится одновременно; лишняя вытесняет самую старую. */
  readonly maxSessions: number;
}

const HOUR_MS = 60 * 60 * 1000;
const TOKEN_BYTES = 32;

const DEFAULT_OPTIONS: SessionOptions = {
  idleTtlMs: 2 * HOUR_MS,
  maxLifetimeMs: 12 * HOUR_MS,
  maxSessions: 20,
};

/** Случайный токен 256 бит в base64url (43 символа): годится для cookie и для скрытого поля формы. */
function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Создаёт хранилище сессий. Ничего не запускает: истёкшие сессии убираются при обращениях. */
export function createSessionStore(overrides: Partial<SessionOptions> = {}): SessionStore {
  const options: SessionOptions = { ...DEFAULT_OPTIONS, ...overrides };
  const sessions = new Map<string, Session>();
  const expiryOf = (createdAtMs: number, nowMs: number): number =>
    Math.min(nowMs + options.idleTtlMs, createdAtMs + options.maxLifetimeMs);

  const evictToFit = (nowMs: number): void => {
    for (const [id, session] of sessions) {
      if (nowMs >= session.expiresAtMs) sessions.delete(id);
    }
    // Map хранит ключи в порядке создания: первый ключ самая старая сессия.
    while (sessions.size >= options.maxSessions) {
      const oldest = sessions.keys().next();
      if (oldest.done === true) break;
      sessions.delete(oldest.value);
    }
  };

  return {
    create(nowMs: number): Session {
      evictToFit(nowMs);
      const session: Session = Object.freeze({
        id: newToken(),
        csrf: newToken(),
        createdAtMs: nowMs,
        expiresAtMs: expiryOf(nowMs, nowMs),
      });
      sessions.set(session.id, session);
      return session;
    },
    find(id: string | null, nowMs: number): Session | null {
      const session = id === null ? undefined : sessions.get(id);
      if (session === undefined) return null;
      if (nowMs >= session.expiresAtMs) {
        sessions.delete(session.id);
        return null;
      }
      const renewed: Session = Object.freeze({
        ...session,
        expiresAtMs: expiryOf(session.createdAtMs, nowMs),
      });
      sessions.set(renewed.id, renewed);
      return renewed;
    },
    destroy(id: string): void {
      sessions.delete(id);
    },
  };
}
