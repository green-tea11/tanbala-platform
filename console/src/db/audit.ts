import type { Db } from './connection.js';

/** Кто в журнале, если при входе назвали несуществующее имя: само имя не пишется. */
export const UNKNOWN_ACTOR = 'неизвестное имя';
/** Кто в журнале для команды user на сервере. */
export const CLI_ACTOR = 'командная строка';
/** Сколько хранится журнал. */
export const AUDIT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Запись журнала действий: кто, что, над чем (id), итог. Без паролей, текстов сообщений, номеров и почт:
 * target только вида «chat:12», «draft:5», «user:name».
 */
export interface AuditEntry {
  readonly actor: string;
  readonly action: string;
  readonly target?: string | null;
  readonly outcome?: string | null;
  readonly ip?: string | null;
}

export interface AuditRecord extends AuditEntry {
  readonly id: number;
  readonly at: number;
}

export interface AuditPage {
  readonly items: readonly AuditRecord[];
  readonly total: number;
}

export interface AuditRepo {
  write(entry: AuditEntry, nowMs: number): void;
  page(page: number, pageSize: number): AuditPage;
  purgeOlderThan(cutoffMs: number): number;
}

interface AuditRow {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  outcome: string | null;
  ip: string | null;
}

export function createAuditRepo(db: Db): AuditRepo {
  const insert = db.prepare(
    'INSERT INTO audit_log (at, actor, action, target, outcome, ip) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const pageQuery = db.prepare<[number, number], AuditRow>(
    'SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ? OFFSET ?',
  );
  const count = db.prepare<[], { total: number }>('SELECT count(*) AS total FROM audit_log');
  const purge = db.prepare('DELETE FROM audit_log WHERE at < ?');

  return {
    write(entry, nowMs) {
      insert.run(
        nowMs,
        entry.actor,
        entry.action,
        entry.target ?? null,
        entry.outcome ?? null,
        entry.ip ?? null,
      );
    },
    page(page, pageSize) {
      const rows = pageQuery.all(pageSize, (page - 1) * pageSize);
      return { items: rows, total: count.get()?.total ?? 0 };
    },
    purgeOlderThan: (cutoffMs) => purge.run(cutoffMs).changes,
  };
}
