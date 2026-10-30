import { createLoginService, type LoginService } from '../auth/login.js';
import {
  createHashGate,
  createLoginLimiter,
  type HashGate,
  type LoginLimiter,
} from '../auth/login-limiter.js';
import type { PasswordHasher } from '../auth/passwords.js';
import { createSessionService, type SessionService } from '../auth/sessions.js';
import type { LeadsApi } from '../backends/leads.js';
import type { WaApi } from '../backends/wa.js';
import { createAuditRepo, type AuditEntry, type AuditRepo } from '../db/audit.js';
import type { Db } from '../db/connection.js';
import { createSeenRepo, type SeenRepo } from '../db/seen.js';
import { createSessionsRepo, type SessionsRepo } from '../db/sessions.js';
import { createUsersRepo, type UsersRepo } from '../db/users.js';
import type { Clock } from '../shared/clock.js';
import type { Logger } from '../shared/logger.js';
import { hostRules, type HostRules } from './guard.js';

/** Всё, что нужно серверу консоли. Тесты передают моки приложений и базу в памяти. */
export interface AppDeps {
  readonly port: number;
  readonly allowedHosts: readonly string[];
  readonly db: Db;
  readonly leads: LeadsApi;
  readonly wa: WaApi;
  readonly hasher: PasswordHasher;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Папка собранного интерфейса (web/dist). */
  readonly staticDir: string;
  readonly limiter?: LoginLimiter;
  readonly gate?: HashGate;
}

export interface AppContext {
  readonly deps: AppDeps;
  readonly hosts: HostRules;
  readonly users: UsersRepo;
  readonly sessionsRepo: SessionsRepo;
  readonly sessions: SessionService;
  readonly audit: AuditRepo;
  readonly seen: SeenRepo;
  readonly login: LoginService;
  /** Запись в журнал действий с текущим временем. */
  record(entry: AuditEntry): void;
}

export function createAppContext(deps: AppDeps): AppContext {
  const users = createUsersRepo(deps.db);
  const sessionsRepo = createSessionsRepo(deps.db);
  const sessions = createSessionService(sessionsRepo, deps.clock);
  const audit = createAuditRepo(deps.db);
  const login = createLoginService({
    users,
    sessions,
    hasher: deps.hasher,
    limiter: deps.limiter ?? createLoginLimiter(),
    gate: deps.gate ?? createHashGate(),
    audit,
    clock: deps.clock,
    logger: deps.logger,
  });
  return {
    deps,
    hosts: hostRules(deps.port, deps.allowedHosts),
    users,
    sessionsRepo,
    sessions,
    audit,
    seen: createSeenRepo(deps.db),
    login,
    // Журнал не должен менять итог уже выполненного действия: сбой записи (база занята, диск полон) — только в лог,
    // иначе менеджер увидел бы «ошибку» после ушедшего клиенту ответа и отправил бы его ещё раз.
    record: (entry) => {
      try {
        audit.write(entry, deps.clock.now());
      } catch (error: unknown) {
        deps.logger.error(
          { action: entry.action, errorName: error instanceof Error ? error.name : typeof error },
          'Журнал действий: запись не удалась',
        );
      }
    },
  };
}
