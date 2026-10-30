import type { SessionService } from '../auth/sessions.js';
import { AUDIT_RETENTION_MS, type AuditRepo } from '../db/audit.js';
import type { SeenRepo } from '../db/seen.js';
import type { Clock } from '../shared/clock.js';
import type { Logger } from '../shared/logger.js';

const HOUR_MS = 60 * 60 * 1000;

export interface MaintenanceDeps {
  readonly sessions: SessionService;
  readonly audit: AuditRepo;
  readonly seen: SeenRepo;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** Уборка: истёкшие сессии, журнал и отметки «видел» старше 180 дней. Возвращает, сколько удалено. */
export function runMaintenance(deps: MaintenanceDeps) {
  const cutoff = deps.clock.now() - AUDIT_RETENTION_MS;
  const removed = {
    sessions: deps.sessions.purgeExpired(),
    audit: deps.audit.purgeOlderThan(cutoff),
    seen: deps.seen.purgeOlderThan(cutoff),
  };
  deps.logger.info({ action: 'maintenance', ...removed }, 'Уборка базы консоли');
  return removed;
}

/** Уборка при запуске и раз в час; возвращает остановку таймера. Сбой уборки только пишется в лог. */
export function startMaintenance(deps: MaintenanceDeps, intervalMs = HOUR_MS): () => void {
  const safeRun = (): void => {
    try {
      runMaintenance(deps);
    } catch (error: unknown) {
      deps.logger.error({ err: error }, 'Уборка базы консоли не удалась');
    }
  };
  safeRun();
  const timer = setInterval(safeRun, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
