import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from '../../src/server/headers.js';
import { json } from '../helpers/fake-backends.js';
import { stubHome } from '../helpers/fixtures.js';
import { DOMAIN, harnessPerTest, LOCAL_ORIGIN, type Harness } from '../helpers/harness.js';

const start = harnessPerTest();

const EXPECTED_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; " +
  "object-src 'none'";

function expectSecurityHeaders(headers: Record<string, unknown>): void {
  expect(headers['content-security-policy']).toBe(EXPECTED_CSP);
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['referrer-policy']).toBe('same-origin');
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['cross-origin-resource-policy']).toBe('same-origin');
  expect(String(headers['permissions-policy'])).toContain('camera=()');
}

describe('заголовки безопасности', () => {
  it('CSP ровно по плану и без unsafe-inline', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(EXPECTED_CSP);
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe');
  });

  it('на данных /api, на ошибках, на 404 и на странице: все заголовки; данные — no-store', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    const responses = [
      await harness.request('GET', '/api/session', { session }),
      await harness.request('GET', '/api/session'),
      await harness.request('GET', '/api/no-such-route', { session }),
      await harness.request('GET', '/'),
      await harness.request('GET', '/api/chats/abc', { session }),
    ];
    for (const response of responses) {
      expectSecurityHeaders(response.headers);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['strict-transport-security']).toBeUndefined();
    }
  });

  it('ошибка разбора адреса до маршрутов: тоже свой JSON и заголовки', async () => {
    const harness = await start();
    const response = await harness.request('GET', '/api/chats/%E0%A4%A');
    expect(response.statusCode).toBe(400);
    expectSecurityHeaders(response.headers);
  });
});

describe('Host, адрес сокета и HTTPS', () => {
  it('чужой Host: 403 bad_host', async () => {
    const harness = await start();
    for (const host of ['evil.example', '127.0.0.1:3100', 'localhost', `${DOMAIN}:8443`]) {
      const response = await harness.request('GET', '/', { headers: { host } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: 'bad_host' });
    }
  });

  it('домен по HTTP: 403 https_required; X-Forwarded-Proto от 127.0.0.1 даёт HTTPS и HSTS', async () => {
    const harness = await start();
    const plain = await harness.request('GET', '/', { headers: { host: DOMAIN } });
    expect(plain.statusCode).toBe(403);
    expect(plain.json()).toMatchObject({ error: 'https_required' });
    const secure = await harness.request('GET', '/', {
      headers: { host: DOMAIN, 'x-forwarded-proto': 'https' },
    });
    expect(secure.statusCode).toBe(200);
    expect(secure.headers['strict-transport-security']).toBe('max-age=31536000');
  });

  it('соединение не с этой машины: 403, X-Forwarded-For не помогает', async () => {
    const harness = await start();
    const response = await harness.app.inject({
      method: 'GET',
      url: '/',
      remoteAddress: '10.0.0.5',
      headers: { host: '127.0.0.1:3200', 'x-forwarded-for': '127.0.0.1' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('X-Forwarded-Proto от чужого адреса не верится (trustProxy только 127.0.0.1)', async () => {
    const harness = await start();
    const response = await harness.app.inject({
      method: 'GET',
      url: '/',
      remoteAddress: '::1',
      headers: { host: DOMAIN, 'x-forwarded-proto': 'https' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'https_required' });
  });

  it('/healthz только с локальным Host: да/нет по приложениям, без данных', async () => {
    const harness = await start();
    harness.backends.on('GET leads:/runs/active', null);
    const local = await harness.request('GET', '/healthz');
    expect(local.statusCode).toBe(200);
    expect(local.json()).toEqual({ console: true, leads: true, wa: false });
    const outside = await harness.request('GET', '/healthz', {
      headers: { host: DOMAIN, 'x-forwarded-proto': 'https' },
    });
    expect(outside.statusCode).toBe(404);
  });
});

describe('CSRF, Origin и тип тела', () => {
  it('изменяющий запрос без X-CSRF-Token или с чужим: 403 csrf, приложение не вызывается', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    for (const csrf of [false, 'не-тот-токен'] as const) {
      const response = await harness.request('POST', '/api/chats/1/reply', {
        session,
        csrf,
        body: { text: 'Здравствуйте' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: 'csrf' });
    }
    expect(harness.backends.calls).toEqual([]);
  });

  it('токен CSRF чужой сессии не подходит', async () => {
    const harness = await start();
    const owner = await harness.signIn('owner', 'owner');
    const manager = await harness.signIn('manager', 'manager');
    const response = await harness.request('POST', '/api/seen', {
      session: owner,
      csrf: manager.csrf,
      body: { kind: 'handoff', ids: [1] },
    });
    expect(response.statusCode).toBe(403);
  });

  it('изменяющий запрос без Origin или с чужим Origin: 403 bad_origin', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    for (const origin of [false, 'https://evil.example', `https://${DOMAIN}`] as const) {
      const response = await harness.request('POST', '/api/seen', {
        session,
        origin,
        body: { kind: 'handoff', ids: [1] },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: 'bad_origin' });
    }
  });

  it('не JSON (форма, текст, без типа): 415', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    for (const type of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data']) {
      const response = await harness.request('POST', '/api/seen', {
        session,
        headers: { 'content-type': type },
      });
      expect(response.statusCode).toBe(415);
    }
    const noType = await harness.app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { host: '127.0.0.1:3200', origin: LOCAL_ORIGIN },
    });
    expect(noType.statusCode).toBe(415);
  });

  it('JSON с __proto__: 400', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/seen',
      headers: {
        host: '127.0.0.1:3200',
        origin: LOCAL_ORIGIN,
        'content-type': 'application/json',
        cookie: session.cookie,
        'x-csrf-token': session.csrf,
      },
      payload: '{"kind":"handoff","ids":[1],"__proto__":{"x":1}}',
    });
    expect(response.statusCode).toBe(400);
  });

  it('тело больше 64 КБ: 413; импорт принимает до 1.5 МБ', async () => {
    const harness = await start();
    harness.backends.on('POST leads:/history/import', {
      added: 1,
      existing: 0,
      invalid: [],
      invalidMore: 0,
    });
    const session = await harness.signIn('owner', 'owner');
    const big = await harness.request('POST', '/api/chats/1/reply', {
      session,
      body: { text: 'я'.repeat(70 * 1024) },
    });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ error: 'too_large' });
    const imported = await harness.request('POST', '/api/history/import', {
      session,
      body: { kind: 'written', text: `a@b.kz\n${'x'.repeat(1024 * 1024 - 10)}` },
    });
    expect(imported.statusCode).toBe(200);
    const tooBig = await harness.request('POST', '/api/history/import', {
      session,
      body: { kind: 'written', fileBase64: 'A'.repeat(1600 * 1024) },
    });
    expect(tooBig.statusCode).toBe(413);
  });
});

describe('GET ничего не меняет', () => {
  /** Снимок базы без отметки активности сессии (её требует правило простоя 7 дней). */
  function snapshot(h: Harness): string {
    const tables = [
      'SELECT * FROM users ORDER BY id',
      'SELECT id, token_hash, user_id, csrf, created_at, user_agent FROM sessions ORDER BY id',
      'SELECT * FROM audit_log ORDER BY id',
      'SELECT * FROM seen_marks ORDER BY user_id, kind, item_id',
    ];
    return JSON.stringify(tables.map((sql) => h.db.prepare(sql).all()));
  }

  it('все GET-маршруты: база консоли не меняется, почте и боту не уходит ни одного POST', async () => {
    const harness = await start();
    stubHome(harness.backends);
    harness.backends.fallback(() => json({ items: [], total: 0, page: 1, pages: 0, pageSize: 50 }));
    const session = await harness.signIn('owner', 'owner');
    await harness.request('POST', '/api/seen', { session, body: { kind: 'handoff', ids: [7] } });
    const before = snapshot(harness);
    const gets = harness.routes.filter((route) => route.method === 'GET');
    for (const route of gets) {
      const url = route.url.replace(/:[A-Za-z]+/g, '1').replace('*', 'chats/1');
      const response = await harness.request('GET', url, { session });
      expect(response.statusCode).toBeLessThan(500);
    }
    expect(snapshot(harness)).toBe(before);
    expect(harness.backends.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('отметка активности пишется не чаще раза в минуту', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    const lastSeen = () =>
      (harness.db.prepare('SELECT last_seen_at AS at FROM sessions').get() as { at: number }).at;
    const initial = lastSeen();
    harness.clock.advance(30_000);
    await harness.request('GET', '/api/session', { session });
    expect(lastSeen()).toBe(initial);
    harness.clock.advance(31_000);
    await harness.request('GET', '/api/session', { session });
    expect(lastSeen()).toBe(initial + 61_000);
  });
});
