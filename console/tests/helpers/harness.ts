import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach } from 'vitest';
import { createHashGate, createLoginLimiter } from '../../src/auth/login-limiter.js';
import { createScryptHasher, type PasswordHasher } from '../../src/auth/passwords.js';
import { createBackendClient, type ClientLimits } from '../../src/backends/client.js';
import { createLeadsApi } from '../../src/backends/leads.js';
import { createWaApi } from '../../src/backends/wa.js';
import { IN_MEMORY, openDatabase, type Db } from '../../src/db/connection.js';
import type { Role } from '../../src/db/users.js';
import { buildApp, type RouteRecord } from '../../src/server/app.js';
import type { AppContext } from '../../src/server/context.js';
import { createLogger } from '../../src/shared/logger.js';
import {
  createFakeBackends,
  LEADS_TOKEN,
  LEADS_URL,
  WA_TOKEN,
  WA_URL,
  type FakeBackends,
} from './fake-backends.js';

export const PORT = 3200;
export const LOCAL_HOST = `127.0.0.1:${PORT}`;
export const LOCAL_ORIGIN = `http://${LOCAL_HOST}`;
export const DOMAIN = 'panel.tanbala.kz';
export const PASSWORD = 'правильный-пароль-1';
/** 30.10.2026 11:00 по Алматы. */
export const START_MS = Date.parse('2026-10-30T06:00:00Z');
/** Быстрые параметры scrypt для тестов (рабочие проверяются в passwords.test.ts). */
export const FAST_SCRYPT = { N: 1024, r: 8, p: 1 } as const;

export interface FakeClock {
  now(): number;
  advance(ms: number): void;
}

export function createFakeClock(startMs = START_MS): FakeClock {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

/** Хэшер со счётчиком расчётов scrypt (проверка и подставная проверка). */
export interface CountingHasher extends PasswordHasher {
  readonly runs: () => number;
}

export function countingHasher(inner: PasswordHasher): CountingHasher {
  let runs = 0;
  return {
    hash: (password) => inner.hash(password),
    verify: (password, stored) => {
      runs += 1;
      return inner.verify(password, stored);
    },
    verifyDummy: (password) => {
      runs += 1;
      return inner.verifyDummy(password);
    },
    runs: () => runs,
  };
}

export interface RequestOptions {
  readonly session?: Session;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** false — без Origin; строка — свой Origin. По умолчанию Origin нашей страницы у POST. */
  readonly origin?: string | false;
  /** false — без X-CSRF-Token. */
  readonly csrf?: string | false;
}

export interface Session {
  readonly cookie: string;
  readonly csrf: string;
}

export interface Harness {
  readonly app: FastifyInstance;
  readonly context: AppContext;
  readonly routes: readonly RouteRecord[];
  readonly db: Db;
  readonly clock: FakeClock;
  readonly backends: FakeBackends;
  readonly hasher: CountingHasher;
  addUser(name: string, role: Role, password?: string): Promise<void>;
  login(name: string, password?: string, headers?: Record<string, string>): Promise<Session>;
  /** Заводит пользователя и входит. */
  signIn(name: string, role: Role): Promise<Session>;
  request(
    method: 'GET' | 'POST',
    url: string,
    options?: RequestOptions,
  ): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  readonly allowedHosts?: readonly string[];
  readonly localOnlyHealthz?: boolean;
  readonly staticDir?: string;
  readonly limits?: Partial<ClientLimits>;
  readonly hasher?: PasswordHasher;
}

function cookieFrom(response: LightMyRequestResponse): string {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') throw new Error('Нет Set-Cookie');
  return value.split(';')[0] ?? '';
}

/** Консоль с базой в памяти, подменёнными почтой и ботом и быстрыми часами. Только inject, без портов. */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = createFakeClock();
  const db = openDatabase(IN_MEMORY);
  const backends = createFakeBackends();
  const logger = createLogger({ level: 'silent' });
  const limits = { cacheMs: 0, ...options.limits };
  const common = { fetch: backends.fetch, clock, logger, limits };
  const leads = createLeadsApi(
    createBackendClient({ name: 'leads', baseUrl: LEADS_URL, token: LEADS_TOKEN, ...common }),
    logger,
  );
  const wa = createWaApi(
    createBackendClient({ name: 'wa', baseUrl: WA_URL, token: WA_TOKEN, ...common }),
    logger,
  );
  const hasher = countingHasher(options.hasher ?? createScryptHasher(FAST_SCRYPT));
  const { app, context, routes } = buildApp({
    port: PORT,
    allowedHosts: options.allowedHosts ?? [DOMAIN],
    localOnlyHealthz: options.localOnlyHealthz ?? false,
    db,
    leads,
    wa,
    hasher,
    clock,
    logger,
    staticDir: options.staticDir ?? 'tests/no-such-web-dist',
    limiter: createLoginLimiter(),
    gate: createHashGate(),
  });
  await app.ready();

  const request: Harness['request'] = (method, url, opts = {}) => {
    const headers: Record<string, string> = { host: LOCAL_HOST };
    if (method === 'POST') headers['content-type'] = 'application/json';
    if (method === 'POST' && opts.origin !== false) headers['origin'] = opts.origin ?? LOCAL_ORIGIN;
    if (opts.session !== undefined) headers['cookie'] = opts.session.cookie;
    const csrf = opts.csrf ?? opts.session?.csrf;
    if (method === 'POST' && csrf !== undefined && csrf !== false) headers['x-csrf-token'] = csrf;
    const payload = method === 'POST' ? JSON.stringify(opts.body ?? {}) : undefined;
    return app.inject({
      method,
      url,
      headers: { ...headers, ...opts.headers },
      ...(payload === undefined ? {} : { payload }),
    });
  };

  const addUser: Harness['addUser'] = async (name, role, password = PASSWORD) => {
    context.users.create({ name, role, passwordHash: await hasher.hash(password) }, clock.now());
  };

  const login: Harness['login'] = async (name, password = PASSWORD, headers = {}) => {
    const response = await request('POST', '/api/login', { body: { name, password }, headers });
    if (response.statusCode !== 200) throw new Error(`Вход не удался: ${response.statusCode}`);
    const body = response.json<{ csrfToken: string }>();
    return { cookie: cookieFrom(response), csrf: body.csrfToken };
  };

  return {
    app,
    context,
    routes,
    db,
    clock,
    backends,
    hasher,
    addUser,
    login,
    signIn: async (name, role) => {
      await addUser(name, role);
      return login(name);
    },
    request,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

/** Фабрика консолей для файла тестов: всё, что открыто в тесте, закрывается после него. */
export function harnessPerTest(): (options?: HarnessOptions) => Promise<Harness> {
  const open: Harness[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((item) => item.close()));
  });
  return async (options) => {
    const harness = await createHarness(options);
    open.push(harness);
    return harness;
  };
}
