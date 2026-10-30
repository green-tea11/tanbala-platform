import { UNKNOWN_ACTOR, type AuditRepo } from '../db/audit.js';
import type { Role, UsersRepo, UserWithHash } from '../db/users.js';
import type { Clock } from '../shared/clock.js';
import type { Logger } from '../shared/logger.js';
import { limiterKey } from './client-key.js';
import type { HashGate, LoginLimiter, LoginTicket } from './login-limiter.js';
import type { PasswordHasher } from './passwords.js';
import { isValidUserName, normalizeUserName } from './policy.js';
import type { ClientInfo, SessionService, StartedSession } from './sessions.js';

export interface LoginInput {
  readonly name: string;
  readonly password: string;
  readonly client: ClientInfo;
  /** Значение cookie, с которым пришёл запрос: при входе оно закрывается, выдаётся новый id. */
  readonly previousToken: string | null;
}

export type LoginOutcome =
  | {
      readonly kind: 'ok';
      readonly session: StartedSession;
      readonly user: { readonly name: string; readonly role: Role };
    }
  /** Неверное имя или пароль (или пользователь отключён): единственный случай ответа 401. */
  | { readonly kind: 'invalid' }
  | { readonly kind: 'limited'; readonly retryAfterMs: number }
  | { readonly kind: 'busy' };

export interface LoginDeps {
  readonly users: UsersRepo;
  readonly sessions: SessionService;
  readonly hasher: PasswordHasher;
  readonly limiter: LoginLimiter;
  readonly gate: HashGate;
  readonly audit: AuditRepo;
  readonly clock: Clock;
  readonly logger: Logger;
}

export type LoginService = (input: LoginInput) => Promise<LoginOutcome>;

/** Имя для журнала: только если такой пользователь есть. */
function actorOf(user: UserWithHash | null): string {
  return user === null ? UNKNOWN_ACTOR : user.name;
}

/** Совпал ли пароль; null: семафор занят и расчёта не было. */
async function checkPassword(
  deps: LoginDeps,
  user: UserWithHash | null,
  password: string,
): Promise<boolean | null> {
  try {
    const result = await deps.gate.run(() =>
      user === null
        ? deps.hasher.verifyDummy(password)
        : deps.hasher.verify(password, user.passwordHash),
    );
    return result.ok ? result.value : null;
  } catch (error: unknown) {
    // Сбой расчёта не должен выглядеть верным паролем: считаем неверным.
    deps.logger.error({ err: error }, 'Сбой проверки пароля');
    return false;
  }
}

/**
 * Пароль проверен: решение по свежей строке пользователя. Пароль, роль или «активен» могли смениться командой
 * на сервере, пока считался хэш (~100 мс): тогда вход не удаётся, а не переживает смену пароля.
 */
function currentUser(deps: LoginDeps, checked: UserWithHash | null): UserWithHash | null {
  if (checked === null) return null;
  const fresh = deps.users.findByName(checked.name);
  const unchanged = fresh !== null && fresh.passwordHash === checked.passwordHash;
  return unchanged && fresh.active ? fresh : null;
}

async function checkAndStart(
  deps: LoginDeps,
  input: LoginInput,
  name: string,
  ticket: LoginTicket,
): Promise<LoginOutcome> {
  const { ip } = input.client;
  const user = isValidUserName(name) ? deps.users.findByName(name) : null;
  const matches = await checkPassword(deps, user, input.password);
  if (matches === null) {
    ticket.cancelled();
    deps.logger.warn({ action: 'login_busy', ip }, 'Вход отклонён: идут другие проверки');
    return { kind: 'busy' };
  }
  const fresh = matches ? currentUser(deps, user) : null;
  if (fresh === null) {
    ticket.failed();
    deps.audit.write({ actor: actorOf(user), action: 'login_failed', ip }, deps.clock.now());
    deps.logger.warn({ action: 'login_failed', ip }, 'Неверное имя или пароль');
    return { kind: 'invalid' };
  }
  ticket.succeeded();
  deps.sessions.end(input.previousToken);
  const session = deps.sessions.start(fresh.id, input.client);
  deps.audit.write({ actor: fresh.name, action: 'login', ip }, deps.clock.now());
  return { kind: 'ok', session, user: { name: fresh.name, role: fresh.role } };
}

/**
 * Вход по имени и паролю. Порядок: допуск ограничителя (попытка засчитывается до хэша; адрес IPv6 считается по
 * сети /64), поиск пользователя, расчёт хэша через общий семафор (для несуществующего имени — подставной хэш того
 * же веса), сессия с новым id. Любой сбой по пути освобождает допуск (finally), иначе адрес и имя остались бы
 * «заняты» до перезапуска. Отказы ограничителя пишутся только в лог (не в журнал): поток 429 не раздувает базу.
 */
export function createLoginService(deps: LoginDeps): LoginService {
  return async (input) => {
    const name = normalizeUserName(input.name).slice(0, 64);
    const { ip } = input.client;
    const admission = deps.limiter.admit(limiterKey(ip), name, deps.clock.now());
    if (!admission.ok) {
      deps.logger.warn({ action: 'login_blocked', ip, reason: admission.reason }, 'Вход отклонён');
      return admission.reason === 'busy'
        ? { kind: 'busy' }
        : { kind: 'limited', retryAfterMs: admission.retryAfterMs };
    }
    try {
      return await checkAndStart(deps, input, name, admission.ticket);
    } finally {
      // Уже закрытый допуск не меняется; не закрытый (исключение) — возвращается.
      admission.ticket.cancelled();
    }
  };
}
