import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createSessionService, SESSION_LIMITS } from '../../src/auth/sessions.js';
import { AUDIT_RETENTION_MS, createAuditRepo } from '../../src/db/audit.js';
import { IN_MEMORY, openDatabase } from '../../src/db/connection.js';
import { SCHEMA_VERSION } from '../../src/db/migrations.js';
import { createSeenRepo } from '../../src/db/seen.js';
import { createSessionsRepo } from '../../src/db/sessions.js';
import { createUsersRepo, UserExistsError } from '../../src/db/users.js';
import { runMaintenance, startMaintenance } from '../../src/services/maintenance.js';
import { createLogger } from '../../src/shared/logger.js';
import { createBackends } from '../../src/wiring.js';
import { createFakeClock } from '../helpers/harness.js';

function setup() {
  const db = openDatabase(IN_MEMORY);
  const clock = createFakeClock();
  const users = createUsersRepo(db);
  const user = users.create({ name: 'owner', role: 'owner', passwordHash: 'x' }, clock.now());
  const sessions = createSessionService(createSessionsRepo(db), clock);
  const audit = createAuditRepo(db);
  const seen = createSeenRepo(db);
  const logger = createLogger({ level: 'silent' });
  return { db, clock, users, user, sessions, audit, seen, logger };
}

describe('база консоли', () => {
  it('миграции до последней версии; повторное открытие ничего не ломает', () => {
    const { db } = setup();
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(() =>
      createUsersRepo(db).create({ name: 'owner', role: 'owner', passwordHash: 'x' }, 0),
    ).toThrow(UserExistsError);
  });

  it('отметки «видел»: повтор не дублирует, проверка большими пачками', () => {
    const { seen, user, clock } = setup();
    seen.mark(user.id, 'handoff', [1, 2, 2], clock.now());
    const ids = Array.from({ length: 1200 }, (_, index) => index + 1);
    expect([...seen.seenAmong(user.id, 'handoff', ids)].sort()).toEqual([1, 2]);
    expect(seen.seenAmong(user.id, 'notification', [1]).size).toBe(0);
  });
});

describe('уборка', () => {
  it('истёкшие сессии, журнал и отметки старше 180 дней', () => {
    const deps = setup();
    deps.sessions.start(deps.user.id, { ip: '1.1.1.1', userAgent: undefined });
    deps.audit.write({ actor: 'owner', action: 'old' }, deps.clock.now());
    deps.seen.mark(deps.user.id, 'handoff', [1], deps.clock.now());
    expect(runMaintenance(deps)).toEqual({ sessions: 0, audit: 0, seen: 0 });
    deps.clock.advance(SESSION_LIMITS.idleMs);
    expect(runMaintenance(deps).sessions).toBe(1);
    deps.clock.advance(AUDIT_RETENTION_MS);
    expect(runMaintenance(deps)).toEqual({ sessions: 0, audit: 1, seen: 1 });
  });

  it('по таймеру; сбой только пишется в лог; остановка', () => {
    vi.useFakeTimers();
    try {
      const deps = setup();
      const lines: string[] = [];
      const logger = createLogger({
        level: 'info',
        destination: new Writable({
          write(chunk: Buffer, _encoding, callback) {
            lines.push(chunk.toString());
            callback();
          },
        }),
      });
      const stop = startMaintenance({ ...deps, logger }, 1000);
      expect(lines).toHaveLength(1);
      deps.db.close();
      vi.advanceTimersByTime(1000);
      expect(lines[1]).toContain('Уборка базы консоли не удалась');
      stop();
      vi.advanceTimersByTime(5000);
      expect(lines).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('логгер и сборка клиентов', () => {
  it('пароли, токены, cookie, тексты скрыты; путь без строки запроса', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      destination: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          lines.push(chunk.toString());
          callback();
        },
      }),
    });
    logger.info(
      {
        password: 'секрет',
        token: 'токен',
        nested: { text: 'текст клиента', phone: '77010000001' },
        req: { method: 'GET', url: '/api/chats?q=77010000001' },
        headers: { cookie: 'tanbala_console=abc', 'x-csrf-token': 'csrf' },
      },
      'проверка',
    );
    const line = lines.join('');
    for (const secret of ['секрет', 'токен', 'текст клиента', '77010000001', 'abc', '"csrf"']) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain('"path":"/api/chats"');
  });

  it('клиенты почты и бота по настройкам', () => {
    const backends = createBackends(
      {
        leads: { baseUrl: 'http://127.0.0.1:8000', token: 'L'.repeat(40) },
        wa: { baseUrl: 'http://127.0.0.1:3101', token: 'W'.repeat(40) },
      },
      () => Promise.reject(new Error('нет сети')),
      createFakeClock(),
      createLogger({ level: 'silent' }),
    );
    expect(typeof backends.leads.summary).toBe('function');
    expect(typeof backends.wa.status).toBe('function');
  });
});
