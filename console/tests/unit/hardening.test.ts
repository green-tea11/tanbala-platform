import { describe, expect, it } from 'vitest';
import { limiterKey } from '../../src/auth/client-key.js';
import { createLoginService, type LoginDeps } from '../../src/auth/login.js';
import { createHashGate, createLoginLimiter } from '../../src/auth/login-limiter.js';
import { createScryptHasher } from '../../src/auth/passwords.js';
import { createSessionService } from '../../src/auth/sessions.js';
import {
  ACTION_BODY_LIMIT_BYTES,
  createBackendClient,
  IMPORT_BODY_LIMIT_BYTES,
  type FetchLike,
} from '../../src/backends/client.js';
import { consolePath } from '../../src/backends/paths.js';
import { createReadCache } from '../../src/backends/read-cache.js';
import { UNAVAILABLE } from '../../src/backends/result.js';
import { createSemaphore } from '../../src/backends/semaphore.js';
import { runUserCommand, USAGE } from '../../src/cli/commands.js';
import { isNodeEnvProxyOn, loadConfig } from '../../src/config/env.js';
import { ConfigError } from '../../src/config/errors.js';
import { createAuditRepo } from '../../src/db/audit.js';
import { IN_MEMORY, openDatabase } from '../../src/db/connection.js';
import { createSeenRepo, SEEN_MAX_PER_KIND } from '../../src/db/seen.js';
import { createSessionsRepo } from '../../src/db/sessions.js';
import { createUsersRepo, type UsersRepo } from '../../src/db/users.js';
import { errorMessage } from '../../src/domain/messages.js';
import { sumSpend } from '../../src/domain/spend.js';
import { createLogger } from '../../src/shared/logger.js';
import { json } from '../helpers/fake-backends.js';
import { createFakeClock, FAST_SCRYPT } from '../helpers/harness.js';

const silent = createLogger({ level: 'silent' });
const PASSWORD = 'пароль-владельца';

async function loginSetup(users?: (inner: UsersRepo) => UsersRepo) {
  const db = openDatabase(IN_MEMORY);
  const clock = createFakeClock();
  const hasher = createScryptHasher(FAST_SCRYPT);
  const inner = createUsersRepo(db);
  inner.create({ name: 'owner', role: 'owner', passwordHash: await hasher.hash(PASSWORD) }, 0);
  const deps: LoginDeps = {
    users: users === undefined ? inner : users(inner),
    sessions: createSessionService(createSessionsRepo(db), clock),
    hasher,
    limiter: createLoginLimiter(),
    gate: createHashGate(),
    audit: createAuditRepo(db),
    clock,
    logger: silent,
  };
  const login = createLoginService(deps);
  const attempt = (password = PASSWORD) =>
    login({
      name: 'owner',
      password,
      client: { ip: '1.1.1.1', userAgent: 'x' },
      previousToken: null,
    });
  return { db, inner, hasher, attempt };
}

describe('вход: сбои по пути не запирают имя и адрес', () => {
  it('исключение базы при поиске пользователя: следующая попытка проверяется, а не busy', async () => {
    let fail = true;
    const { attempt } = await loginSetup((inner) => ({
      ...inner,
      findByName: (name) => {
        if (fail) {
          fail = false;
          throw new Error('SQLITE_BUSY');
        }
        return inner.findByName(name);
      },
    }));
    await expect(attempt()).rejects.toThrow('SQLITE_BUSY');
    expect((await attempt()).kind).toBe('ok');
  });

  it('пароль сменили, пока считался хэш: вход не удаётся', async () => {
    const { attempt, inner, hasher } = await loginSetup();
    const newHash = await hasher.hash('новый-пароль-99');
    let changed = false;
    const wrapped = await loginSetup((base) => ({
      ...base,
      findByName: (name) => {
        const found = base.findByName(name);
        if (!changed && found !== null) {
          changed = true;
          base.setPassword(name, newHash, 1);
          return found;
        }
        return found;
      },
    }));
    expect((await wrapped.attempt()).kind).toBe('invalid');
    expect((await attempt()).kind).toBe('ok');
    expect(inner.findByName('owner')).not.toBeNull();
  });
});

describe('ключ ограничителя по адресу', () => {
  it('IPv4 как есть, IPv6 — сеть /64', () => {
    expect(limiterKey('203.0.113.7')).toBe('203.0.113.7');
    expect(limiterKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(limiterKey('2001:DB8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(limiterKey('2001:db8:1:2::9')).toBe('2001:db8:1:2::/64');
    expect(limiterKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(limiterKey('::1')).toBe('0:0:0:0::/64');
    expect(limiterKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(limiterKey('не адрес')).toBe('не адрес');
  });
});

describe('клиент: срок, очередь, итог действий', () => {
  const clientWith = (fetch: FetchLike, limits = {}) =>
    createBackendClient({
      name: 'leads',
      baseUrl: 'http://127.0.0.1:8000',
      token: 'T'.repeat(40),
      fetch,
      clock: createFakeClock(),
      logger: silent,
      limits: { cacheMs: 0, ...limits },
    });
  const path = consolePath(['runs']);

  it('после многих таймаутов места в очереди не теряются', async () => {
    let hang = true;
    const client = clientWith(
      () => (hang ? new Promise<Response>(() => undefined) : Promise.resolve(json({ ok: 1 }))),
      { getTimeoutMs: 10 },
    );
    const timeouts = await Promise.all(
      Array.from({ length: 8 }, (_, index) => client.get(consolePath(['runs', index + 1]))),
    );
    expect(timeouts.every((result) => !result.ok)).toBe(true);
    hang = false;
    expect(await client.get(path)).toMatchObject({ ok: true });
  });

  it('срок считается с постановки в очередь: ждущий запрос не висит дольше срока', async () => {
    const client = clientWith(() => new Promise<Response>(() => undefined), {
      getTimeoutMs: 20,
      maxConcurrent: 1,
    });
    const started = Date.now();
    const [first, second] = await Promise.all([
      client.get(path),
      client.get(consolePath(['blocked'])),
    ]);
    expect(first).toEqual(UNAVAILABLE);
    expect(second).toEqual(UNAVAILABLE);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('действие: соединение отклонено — «недоступно»; обрыв после отправки — «итог неизвестен»', async () => {
    let error: Error = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    const client = clientWith(() => Promise.reject(error));
    expect(await client.post(path, {}, 'owner')).toEqual(UNAVAILABLE);
    error = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    expect(await client.post(path, {}, 'owner')).toEqual({
      ok: false,
      failure: { kind: 'unknown' },
    });
    expect(await client.get(path)).toEqual(UNAVAILABLE);
  });

  it('тело действия больше предела не отправляется; у импорта предел 1.5 МБ', async () => {
    let calls = 0;
    const client = clientWith(() => {
      calls += 1;
      return Promise.resolve(json({ ok: 1 }));
    });
    const big = { text: 'x'.repeat(ACTION_BODY_LIMIT_BYTES) };
    expect(await client.post(path, big, 'owner')).toMatchObject({
      ok: false,
      failure: { kind: 'rejected', status: 413, code: 'too_large' },
    });
    expect(calls).toBe(0);
    expect(await client.post(path, big, 'owner', IMPORT_BODY_LIMIT_BYTES)).toMatchObject({
      ok: true,
    });
  });

  it('чтение, начатое во время действия, в кэш не ложится', async () => {
    const clock = createFakeClock();
    const cache = createReadCache(clock, 10_000);
    let version = 0;
    cache.invalidate();
    let finish: () => void = () => undefined;
    const during = cache.load('k', async () => {
      await new Promise<void>((resolve) => (finish = resolve));
      return { ok: true, status: 200, data: version };
    });
    version = 1;
    cache.invalidate();
    finish();
    expect(await during).toMatchObject({ data: 1 });
    expect(
      await cache.load('k', () => Promise.resolve({ ok: true, status: 200, data: 2 })),
    ).toMatchObject({
      data: 2,
    });
  });

  it('кэш убирает устаревшие ответы при каждой записи', async () => {
    const clock = createFakeClock();
    const cache = createReadCache(clock, 1000);
    let loads = 0;
    const loader = () => {
      loads += 1;
      return Promise.resolve({ ok: true as const, status: 200, data: loads });
    };
    await cache.load('a', loader);
    clock.advance(1000);
    await cache.load('b', loader);
    await cache.load('a', loader);
    expect(loads).toBe(3);
  });
});

describe('семафор', () => {
  it('ожидание отменяется сроком: место не занимается', async () => {
    const semaphore = createSemaphore(1, 5);
    const controller = new AbortController();
    expect(await semaphore.acquire(new AbortController().signal)).toBe(true);
    const waiting = semaphore.acquire(controller.signal);
    controller.abort();
    expect(await waiting).toBe(false);
    semaphore.release();
    expect(await semaphore.acquire(new AbortController().signal)).toBe(true);
    expect(await semaphore.acquire(controller.signal)).toBe(false);
  });
});

describe('мелкие защиты', () => {
  it('отметок «видел» одного вида не больше предела', () => {
    const db = openDatabase(IN_MEMORY);
    const user = createUsersRepo(db).create({ name: 'u', role: 'manager', passwordHash: 'x' }, 0);
    const seen = createSeenRepo(db);
    const ids = Array.from({ length: SEEN_MAX_PER_KIND + 10 }, (_, index) => index + 1);
    seen.mark(user.id, 'handoff', ids, 0);
    const count = db.prepare('SELECT count(*) AS n FROM seen_marks').get() as { n: number };
    expect(count.n).toBe(SEEN_MAX_PER_KIND);
  });

  it('ключи прототипа от приложений ничего не находят', () => {
    expect(errorMessage('constructor')).toBe('Неверный запрос.');
    expect(errorMessage('__proto__')).toBe('Неверный запрос.');
    const row = {
      day: '2026-10-30',
      model: 'constructor',
      calls: 1,
      input: 5,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    expect(sumSpend([row], {})).toMatchObject({ usd: 0, unpricedTokens: 5 });
  });

  it('прокси Node во флагах запуска node — отказ', () => {
    expect(isNodeEnvProxyOn({}, ['--use-env-proxy'])).toBe(true);
    expect(isNodeEnvProxyOn({}, ['--enable-source-maps'])).toBe(false);
    const env = { LEADS_CONSOLE_TOKEN: 'L'.repeat(40), WA_CONSOLE_TOKEN: 'W'.repeat(40) };
    expect(() => loadConfig(env, '/srv/console', ['--use-env-proxy'])).toThrow(ConfigError);
  });
});

describe('команда user: роль по умолчанию и справка', () => {
  it('первый без роли — владелец, следующий — менеджер; --help', async () => {
    const db = openDatabase(IN_MEMORY);
    const out: string[] = [];
    const deps = {
      db,
      hasher: createScryptHasher(FAST_SCRYPT),
      clock: createFakeClock(),
      io: {
        interactive: false,
        readPassword: () => Promise.resolve('пароль-123456'),
        out: (line: string) => out.push(line),
        err: (line: string) => out.push(line),
      },
    };
    expect(await runUserCommand(['user', 'add', 'boss'], deps)).toBe(0);
    expect(await runUserCommand(['user', 'add', 'aigerim'], deps)).toBe(0);
    expect(out).toEqual([
      'Пользователь boss заведён, роль: владелец.',
      'Пользователь aigerim заведён, роль: менеджер.',
    ]);
    expect(await runUserCommand(['--help'], deps)).toBe(0);
    expect(await runUserCommand(['user', 'help'], deps)).toBe(0);
    expect(out.slice(2)).toEqual([USAGE, USAGE]);
  });
});
