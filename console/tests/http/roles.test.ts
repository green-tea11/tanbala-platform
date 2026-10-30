import { describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase } from '../../src/db/connection.js';
import { buildApp, type RouteRecord } from '../../src/server/app.js';
import { createLogger } from '../../src/shared/logger.js';
import { createScryptHasher } from '../../src/auth/passwords.js';
import { json } from '../helpers/fake-backends.js';
import { createFakeClock, harnessPerTest, FAST_SCRYPT, LOCAL_HOST } from '../helpers/harness.js';

const start = harnessPerTest();

/** Адрес маршрута с подставленными id: /api/chats/:id → /api/chats/1. */
function concreteUrl(route: RouteRecord): string {
  return route.url.replace(/:[A-Za-z]+/g, '1').replace('*', 'chats');
}

/** Таблица ролей из console/docs/PLAN.md, раздел 3. */
const EXPECTED_OWNER_ONLY = [
  'POST /api/runs',
  'POST /api/letters/:id/approve',
  'POST /api/letters/:id/reject',
  'POST /api/letters/:id/edit',
  'POST /api/letters/:id/send-test',
  'POST /api/companies/:id/block',
  'POST /api/companies/:id/whatsapp-clear',
  'POST /api/history/import',
  'GET /api/system',
  'GET /api/system/spend',
  'GET /api/system/audit',
  'GET /api/system/users',
  'GET /api/system/sessions',
  'POST /api/system/sessions/:id/revoke',
  'POST /api/system/sessions/revoke-all',
];

const EXPECTED_PUBLIC = ['POST /api/login', 'POST /api/logout', 'GET /healthz', 'GET /*'];

describe('роли на каждом маршруте', () => {
  it('у каждого зарегистрированного маршрута объявлена роль', async () => {
    const harness = await start();
    expect(harness.routes.length).toBeGreaterThan(30);
    const missing = harness.routes.filter((route) => route.access === undefined);
    expect(missing).toEqual([]);
  });

  it('таблица ролей совпадает с планом: только владелец, открытые, остальное — менеджер и владелец', async () => {
    const harness = await start();
    const keyOf = (route: RouteRecord) => `${route.method} ${route.url}`;
    const owner = harness.routes.filter((route) => route.access === 'owner').map(keyOf);
    const open = harness.routes.filter((route) => route.access === 'public').map(keyOf);
    expect(owner.sort()).toEqual([...EXPECTED_OWNER_ONLY].sort());
    expect(open.sort()).toEqual([...EXPECTED_PUBLIC].sort());
    const manager = harness.routes.filter((route) => route.access === 'manager').map(keyOf);
    expect(manager).toEqual(
      expect.arrayContaining([
        'POST /api/chats/:id/reply',
        'POST /api/chats/:id/return',
        'POST /api/seen',
        'GET /api/home',
        'GET /api/companies',
        'GET /api/research-jobs',
      ]),
    );
  });

  it('менеджер на маршрутах владельца: 403 forbidden и ни одного вызова почты или бота', async () => {
    const harness = await start();
    harness.backends.fallback(() => json({ items: [], total: 0, page: 1, pages: 0, pageSize: 50 }));
    const session = await harness.signIn('manager', 'manager');
    for (const route of harness.routes.filter((item) => item.access === 'owner')) {
      const method = route.method === 'POST' ? 'POST' : 'GET';
      const response = await harness.request(method, concreteUrl(route), { session, body: {} });
      expect({ route: route.url, status: response.statusCode }).toEqual({
        route: route.url,
        status: 403,
      });
      expect(response.json()).toMatchObject({ error: 'forbidden' });
    }
    expect(harness.backends.calls).toEqual([]);
  });

  it('без сессии все закрытые маршруты: 403 no_session, приложения не вызываются', async () => {
    const harness = await start();
    for (const route of harness.routes.filter((item) => item.access !== 'public')) {
      const method = route.method === 'POST' ? 'POST' : 'GET';
      const response = await harness.request(method, concreteUrl(route), { body: {} });
      expect({ route: route.url, status: response.statusCode }).toEqual({
        route: route.url,
        status: 403,
      });
      expect(response.json()).toMatchObject({ error: 'no_session' });
    }
    expect(harness.backends.calls).toEqual([]);
  });

  it('менеджер на своих маршрутах не получает 403', async () => {
    const harness = await start();
    harness.backends.fallback(() => json({ items: [], total: 0, page: 1, pages: 0, pageSize: 50 }));
    const session = await harness.signIn('manager', 'manager');
    for (const route of harness.routes.filter((item) => item.access === 'manager')) {
      const method = route.method === 'POST' ? 'POST' : 'GET';
      const response = await harness.request(method, concreteUrl(route), { session, body: {} });
      expect({ route: route.url, status: response.statusCode }).not.toEqual({
        route: route.url,
        status: 403,
      });
    }
  });

  it('маршрут без объявленной роли отклоняется всегда (по умолчанию отказ)', async () => {
    const db = openDatabase(IN_MEMORY);
    const clock = createFakeClock();
    const unused = {} as never;
    const { app, context } = buildApp({
      port: 3200,
      allowedHosts: [],
      db,
      leads: unused,
      wa: unused,
      hasher: createScryptHasher(FAST_SCRYPT),
      clock,
      logger: createLogger({ level: 'silent' }),
      staticDir: 'tests/no-such-web-dist',
    });
    app.get('/api/naked', () => Promise.resolve({ leaked: true }));
    app.get('/naked-page', () => Promise.resolve({ leaked: true }));
    await app.ready();
    const hasher = createScryptHasher(FAST_SCRYPT);
    context.users.create(
      { name: 'boss', role: 'owner', passwordHash: await hasher.hash('пароль-владельца') },
      clock.now(),
    );
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: {
        host: LOCAL_HOST,
        origin: `http://${LOCAL_HOST}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ name: 'boss', password: 'пароль-владельца' }),
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
    for (const url of ['/api/naked', '/naked-page']) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { host: LOCAL_HOST, cookie },
      });
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain('leaked');
    }
    await app.close();
    db.close();
  });
});
