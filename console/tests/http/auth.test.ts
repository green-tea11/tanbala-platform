import { describe, expect, it } from 'vitest';
import { SESSION_LIMITS } from '../../src/auth/sessions.js';
import { UNKNOWN_ACTOR } from '../../src/db/audit.js';
import { hashToken } from '../../src/auth/sessions.js';
import {
  harnessPerTest,
  DOMAIN,
  LOCAL_ORIGIN,
  PASSWORD,
  type Harness,
} from '../helpers/harness.js';

const start = harnessPerTest();

function auditActions(h: Harness): { actor: string; action: string }[] {
  return h.context.audit.page(1, 100).items.map(({ actor, action }) => ({ actor, action }));
}

describe('вход', () => {
  it('верный пароль: 200, cookie HttpOnly SameSite=Strict, токен CSRF, запись в журнал', async () => {
    const harness = await start();
    await harness.addUser('owner', 'owner');
    const response = await harness.request('POST', '/api/login', {
      body: { name: 'owner', password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ user: unknown; csrfToken: string }>();
    expect(body.user).toEqual({ name: 'owner', role: 'owner' });
    expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toMatch(
      /^tanbala_console=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/,
    );
    expect(auditActions(harness)).toEqual([{ actor: 'owner', action: 'login' }]);
  });

  it('имя вводится без учёта регистра и пробелов по краям', async () => {
    const harness = await start();
    await harness.addUser('aigerim', 'manager');
    const response = await harness.request('POST', '/api/login', {
      body: { name: '  Aigerim ', password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
  });

  it('по HTTPS через домен: cookie __Host- с Secure', async () => {
    const harness = await start();
    await harness.addUser('owner', 'owner');
    const response = await harness.request('POST', '/api/login', {
      body: { name: 'owner', password: PASSWORD },
      origin: `https://${DOMAIN}`,
      headers: { host: DOMAIN, 'x-forwarded-proto': 'https' },
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['set-cookie'])).toMatch(
      /^__Host-tanbala_console=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure$/,
    );
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
  });

  it('неверный пароль: 401 invalid_credentials, в журнале имя есть', async () => {
    const harness = await start();
    await harness.addUser('owner', 'owner');
    const response = await harness.request('POST', '/api/login', {
      body: { name: 'owner', password: 'не-тот-пароль' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'invalid_credentials' });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(auditActions(harness)).toEqual([{ actor: 'owner', action: 'login_failed' }]);
  });

  it('несуществующее имя: 401, тот же расчёт хэша, в журнале «неизвестное имя»', async () => {
    const harness = await start();
    const response = await harness.request('POST', '/api/login', {
      body: { name: 'ghost', password: PASSWORD },
    });
    expect(response.statusCode).toBe(401);
    expect(harness.hasher.runs()).toBe(1);
    expect(auditActions(harness)).toEqual([{ actor: UNKNOWN_ACTOR, action: 'login_failed' }]);
  });

  it('отключённый пользователь с верным паролем: 401', async () => {
    const harness = await start();
    await harness.addUser('owner', 'owner');
    harness.context.users.setActive('owner', false, harness.clock.now());
    const response = await harness.request('POST', '/api/login', {
      body: { name: 'owner', password: PASSWORD },
    });
    expect(response.statusCode).toBe(401);
  });

  it('слишком длинные поля: 400 без расчёта хэша', async () => {
    const harness = await start();
    const response = await harness.request('POST', '/api/login', {
      body: { name: 'x'.repeat(65), password: PASSWORD },
    });
    expect(response.statusCode).toBe(400);
    expect(harness.hasher.runs()).toBe(0);
  });

  it('новый id при входе: прежняя сессия из cookie закрывается', async () => {
    const harness = await start();
    await harness.addUser('owner', 'owner');
    const first = await harness.login('owner');
    const second = await harness.login('owner', PASSWORD, { cookie: first.cookie });
    expect(second.cookie).not.toBe(first.cookie);
    expect((await harness.request('GET', '/api/session', { session: first })).statusCode).toBe(403);
    expect((await harness.request('GET', '/api/session', { session: second })).statusCode).toBe(
      200,
    );
  });

  it('в базе только SHA-256 id сессии', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    const token = session.cookie.split('=')[1] ?? '';
    const rows = harness.db.prepare('SELECT token_hash FROM sessions').all() as {
      token_hash: string;
    }[];
    expect(rows).toEqual([{ token_hash: hashToken(token) }]);
    expect(JSON.stringify(rows)).not.toContain(token);
  });
});

describe('ограничение попыток', () => {
  it('5 неудач за 10 минут с адреса: шестая — 429 без расчёта хэша, с Retry-After', async () => {
    const harness = await start();
    await harness.addUser('owner', 'owner');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await harness.request('POST', '/api/login', {
        body: { name: 'owner', password: 'неверный-пароль' },
      });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await harness.request('POST', '/api/login', {
      body: { name: 'owner', password: PASSWORD },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: 'rate_limited' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(harness.hasher.runs()).toBe(5);
    harness.clock.advance(10 * 60_000 + 1);
    const later = await harness.request('POST', '/api/login', {
      body: { name: 'owner', password: PASSWORD },
    });
    expect(later.statusCode).toBe(200);
  });

  it('успешный вход попытку не тратит', async () => {
    const harness = await start();
    await harness.addUser('owner', 'owner');
    for (let attempt = 0; attempt < 8; attempt += 1) await harness.login('owner');
    expect(harness.hasher.runs()).toBe(8);
  });

  it('10 за час на одно имя с разных адресов', async () => {
    const harness = await start();
    await harness.addUser('owner', 'owner');
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await harness.request('POST', '/api/login', {
        body: { name: 'owner', password: 'неверный-пароль' },
        headers: { 'x-forwarded-for': `10.0.0.${attempt}` },
      });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await harness.request('POST', '/api/login', {
      body: { name: 'owner', password: PASSWORD },
      headers: { 'x-forwarded-for': '10.0.1.1' },
    });
    expect(blocked.statusCode).toBe(429);
  });

  it('20 одновременных неверных входов с одного адреса: не больше 5 расчётов scrypt', async () => {
    const harness = await start();
    await harness.addUser('owner', 'owner');
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        harness.request('POST', '/api/login', {
          body: { name: 'owner', password: 'неверный-пароль' },
        }),
      ),
    );
    expect(harness.hasher.runs()).toBeLessThanOrEqual(5);
    const statuses = responses.map((response) => response.statusCode);
    expect(statuses.filter((status) => status === 401).length).toBe(harness.hasher.runs());
    expect(statuses.every((status) => status === 401 || status === 429)).toBe(true);
  });

  it('20 одновременных входов с разных адресов и имён: семафор 2 + очередь 4, остальным 429 busy', async () => {
    const harness = await start();
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        harness.request('POST', '/api/login', {
          body: { name: `user${index}`, password: 'неверный-пароль' },
          headers: { 'x-forwarded-for': `10.0.0.${index}` },
        }),
      ),
    );
    expect(harness.hasher.runs()).toBeLessThanOrEqual(6);
    const busy = responses.filter((response) => response.statusCode === 429);
    expect(busy.length).toBe(20 - harness.hasher.runs());
    expect(busy[0]?.json()).toMatchObject({ error: 'busy' });
  });
});

describe('сессия', () => {
  it('GET /api/session отдаёт пользователя и токен CSRF', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    const response = await harness.request('GET', '/api/session', { session });
    expect(response.json()).toEqual({
      user: { name: 'owner', role: 'owner' },
      csrfToken: session.csrf,
    });
  });

  it('нет сессии: 403 no_session, а не 401', async () => {
    const harness = await start();
    const response = await harness.request('GET', '/api/session');
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'no_session' });
  });

  it('мусор в cookie: 403 no_session', async () => {
    const harness = await start();
    const response = await harness.request('GET', '/api/home', {
      session: { cookie: 'tanbala_console=не-тот', csrf: 'x' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('7 дней без активности: сессия истекает', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    harness.clock.advance(SESSION_LIMITS.idleMs - 1000);
    expect((await harness.request('GET', '/api/session', { session })).statusCode).toBe(200);
    harness.clock.advance(SESSION_LIMITS.idleMs - 1000);
    expect((await harness.request('GET', '/api/session', { session })).statusCode).toBe(200);
    harness.clock.advance(SESSION_LIMITS.idleMs + 1);
    expect((await harness.request('GET', '/api/session', { session })).statusCode).toBe(403);
  });

  it('опросы с X-Console-Poll: 1 срок простоя не продлевают', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    const poll = { session, headers: { 'x-console-poll': '1' } };
    harness.clock.advance(SESSION_LIMITS.idleMs - 1000);
    expect((await harness.request('GET', '/api/session', poll)).statusCode).toBe(200);
    harness.clock.advance(2000);
    expect((await harness.request('GET', '/api/session', poll)).statusCode).toBe(403);
  });

  it('30 дней от входа: сессия истекает даже при активности', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    for (let day = 0; day < 29; day += 1) {
      harness.clock.advance(24 * 60 * 60 * 1000);
      expect((await harness.request('GET', '/api/session', { session })).statusCode).toBe(200);
    }
    harness.clock.advance(SESSION_LIMITS.maxAgeMs - 29 * 24 * 60 * 60 * 1000);
    expect((await harness.request('GET', '/api/session', { session })).statusCode).toBe(403);
  });

  it('не больше 10 сессий у пользователя: вытесняется его самая старая, чужие не трогаются', async () => {
    const harness = await start();
    await harness.addUser('owner', 'owner');
    const other = await harness.signIn('manager', 'manager');
    const sessions = [];
    for (let index = 0; index < 11; index += 1) {
      harness.clock.advance(1000);
      sessions.push(await harness.login('owner'));
    }
    const first = sessions[0];
    if (first === undefined) throw new Error('нет сессии');
    expect((await harness.request('GET', '/api/session', { session: first })).statusCode).toBe(403);
    for (const session of sessions.slice(1)) {
      expect((await harness.request('GET', '/api/session', { session })).statusCode).toBe(200);
    }
    expect((await harness.request('GET', '/api/session', { session: other })).statusCode).toBe(200);
  });

  it('смена пароля, роли и отключение закрывают сессии пользователя', async () => {
    const harness = await start();
    const { users } = harness.context;
    const now = harness.clock.now();
    const first = await harness.signIn('owner', 'owner');
    users.setPassword('owner', await harness.hasher.hash('новый-пароль-1'), now);
    expect((await harness.request('GET', '/api/session', { session: first })).statusCode).toBe(403);
    const second = await harness.login('owner', 'новый-пароль-1');
    users.setRole('owner', 'manager', now);
    expect((await harness.request('GET', '/api/session', { session: second })).statusCode).toBe(
      403,
    );
    const third = await harness.login('owner', 'новый-пароль-1');
    users.setActive('owner', false, now);
    expect((await harness.request('GET', '/api/session', { session: third })).statusCode).toBe(403);
  });

  it('роль читается из базы на каждом запросе', async () => {
    const harness = await start();
    const session = await harness.signIn('boss', 'owner');
    expect((await harness.request('GET', '/api/system/users', { session })).statusCode).toBe(200);
    harness.db.prepare("UPDATE users SET role = 'manager' WHERE name = 'boss'").run();
    expect((await harness.request('GET', '/api/system/users', { session })).statusCode).toBe(403);
  });
});

describe('выход', () => {
  it('закрывает сессию, стирает cookie, пишет в журнал', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    const response = await harness.request('POST', '/api/logout', { session, csrf: false });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['set-cookie'])).toBe(
      'tanbala_console=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
    );
    expect((await harness.request('GET', '/api/session', { session })).statusCode).toBe(403);
    expect(auditActions(harness).map((entry) => entry.action)).toEqual(['logout', 'login']);
  });

  it('без сессии тоже 200 (cookie стирается)', async () => {
    const harness = await start();
    const response = await harness.request('POST', '/api/logout');
    expect(response.statusCode).toBe(200);
  });

  it('вход и выход без Origin или с чужим Origin: 403 bad_origin', async () => {
    const harness = await start();
    await harness.addUser('owner', 'owner');
    const body = { name: 'owner', password: PASSWORD };
    for (const origin of [false, 'https://evil.example', 'null', `${LOCAL_ORIGIN}:1`] as const) {
      const login = await harness.request('POST', '/api/login', { body, origin });
      expect(login.statusCode).toBe(403);
      expect(login.json()).toMatchObject({ error: 'bad_origin' });
      const logout = await harness.request('POST', '/api/logout', { origin });
      expect(logout.statusCode).toBe(403);
    }
    expect(harness.hasher.runs()).toBe(0);
  });
});
