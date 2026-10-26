import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  createHarness,
  makeChat,
  MINUTE_MS,
  ORIGIN,
  sessionCookieOf,
  setCookieLines,
  STRONG_PASSWORD,
  WEAK_PASSWORD,
} from './harness.js';

const HOUR_MS = 60 * MINUTE_MS;

function expectSecurityHeaders(response: LightMyRequestResponse): void {
  const csp = String(response.headers['content-security-policy']);
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['x-frame-options']).toBe('DENY');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['referrer-policy']).toBe('same-origin');
}

describe('панель: вход и сессии', () => {
  it('страница входа открыта без сессии: форма с паролем и ничего из базы', async () => {
    const h = createHarness();

    const response = await h.request({ url: '/login' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toContain('<form method="post" action="/login">');
    expect(response.body).toMatch(/<input[^>]*type="password"[^>]*name="password"/);
    expect(response.body).toContain('lang="ru"');
    expect(h.chats.listForPanel).not.toHaveBeenCalled();
  });

  it.each(['/', '/chats', '/chats/1', '/notifications', '/no-such-page', '/chats/1/reply'])(
    'без сессии адрес %s ведёт на вход и не читает базу',
    async (url) => {
      const h = createHarness({ data: { chats: [makeChat(1)] } });

      const response = await h.request({ url });

      expect(response.statusCode).toBe(303);
      expect(response.headers['location']).toBe('/login');
      expect(h.chats.listForPanel).not.toHaveBeenCalled();
      expect(h.chats.getById).not.toHaveBeenCalled();
    },
  );

  it.each(['/logout', '/chats/1/reply', '/chats/1/return'])(
    'без сессии POST %s ведёт на вход и ничего не делает',
    async (url) => {
      const h = createHarness({ data: { chats: [makeChat(1)] } });

      const response = await h.request({ url, form: { text: 'x', csrf: 'x' } });

      expect(response.statusCode).toBe(303);
      expect(response.headers['location']).toBe('/login');
      expect(h.actions()).toEqual([]);
    },
  );

  it('неверный пароль: 401, понятное сообщение, cookie нет, попытка в логе без пароля', async () => {
    const h = createHarness();

    const response = await h.request({ url: '/login', form: { password: 'неверный-пароль-123' } });

    expect(response.statusCode).toBe(401);
    expect(response.body).toContain('Неверный пароль');
    expect(setCookieLines(response)).toEqual([]);
    expect(h.logs()).toContainEqual(expect.objectContaining({ action: 'login_failed' }));
    expect(h.rawLog()).not.toContain('неверный-пароль-123');
  });

  it('верный пароль: переход на список чатов, cookie HttpOnly и SameSite=Strict, без Secure по HTTP', async () => {
    const h = createHarness();

    const response = await h.request({ url: '/login', form: { password: WEAK_PASSWORD } });

    expect(response.statusCode).toBe(303);
    expect(response.headers['location']).toBe('/chats');
    const cookie = setCookieLines(response)[0] ?? '';
    expect(cookie).toMatch(/^tanbala_sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict$/);
    expect(h.logs()).toContainEqual(expect.objectContaining({ action: 'login' }));
    const page = await h.request({ url: '/chats', cookie: sessionCookieOf(response) ?? '' });
    expect(page.statusCode).toBe(200);
  });

  it('новый ID сессии при каждом входе; подложенный заранее ID не принимается и не становится сессией', async () => {
    const h = createHarness();
    const planted = 'tanbala_sid=planted-by-attacker';

    const first = await h.request({
      url: '/login',
      form: { password: WEAK_PASSWORD },
      cookie: planted,
    });
    const second = await h.request({ url: '/login', form: { password: WEAK_PASSWORD } });

    expect(sessionCookieOf(first)).not.toBe(planted);
    expect(sessionCookieOf(first)).not.toBe(sessionCookieOf(second));
    const attacker = await h.request({ url: '/chats', cookie: planted });
    expect(attacker.statusCode).toBe(303);
  });

  it('вошедший, открыв корень сайта, попадает в список чатов', async () => {
    const h = createHarness();
    const { cookie } = await h.login();

    const response = await h.request({ url: '/', cookie });

    expect(response.statusCode).toBe(303);
    expect(response.headers['location']).toBe('/chats');
  });

  it('вошедший открывает страницу входа и попадает в список чатов', async () => {
    const h = createHarness();
    const { cookie } = await h.login();

    const response = await h.request({ url: '/login', cookie });

    expect(response.statusCode).toBe(303);
    expect(response.headers['location']).toBe('/chats');
  });

  it('пустой пароль в настройках не открывает вход никому, в том числе с пустым вводом', async () => {
    const h = createHarness({ password: '' });

    const empty = await h.request({ url: '/login', form: { password: '' } });
    const missing = await h.request({ url: '/login', form: {} });

    expect(empty.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    expect(setCookieLines(empty)).toEqual([]);
    expect(h.logs()).toContainEqual(
      expect.objectContaining({ level: 40, msg: expect.stringContaining('пустой') as unknown }),
    );
  });

  it('выход: сессия закрыта, cookie стёрта, старый cookie панель не открывает', async () => {
    const h = createHarness();
    const { cookie, csrf } = await h.login();

    const response = await h.request({ url: '/logout', cookie, form: { csrf } });

    expect(response.statusCode).toBe(303);
    expect(response.headers['location']).toBe('/login');
    expect(setCookieLines(response)[0]).toMatch(/^tanbala_sid=; .*Max-Age=0/);
    const after = await h.request({ url: '/chats', cookie });
    expect(after.statusCode).toBe(303);
    expect(h.logs()).toContainEqual(expect.objectContaining({ action: 'logout' }));
  });

  it('простой больше двух часов закрывает сессию, а запросы её продлевают', async () => {
    const h = createHarness();
    const { cookie } = await h.login();

    h.advance(119 * MINUTE_MS);
    expect((await h.request({ url: '/chats', cookie })).statusCode).toBe(200);
    h.advance(119 * MINUTE_MS);
    expect((await h.request({ url: '/chats', cookie })).statusCode).toBe(200);
    h.advance(2 * HOUR_MS);

    expect((await h.request({ url: '/chats', cookie })).statusCode).toBe(303);
  });

  it('предельный срок сессии 12 часов не продлить активностью', async () => {
    const h = createHarness();
    const { cookie } = await h.login();

    for (let i = 0; i < 11; i += 1) {
      h.advance(HOUR_MS);
      expect((await h.request({ url: '/chats', cookie })).statusCode).toBe(200);
    }
    h.advance(HOUR_MS);

    expect((await h.request({ url: '/chats', cookie })).statusCode).toBe(303);
  });
});

describe('панель: ограничение попыток входа', () => {
  const wrong = { password: 'неверный' };

  it('пять неудач с одного адреса закрывают вход на десять минут, верный пароль тоже', async () => {
    const h = createHarness();
    for (let i = 0; i < 5; i += 1) {
      expect((await h.request({ url: '/login', form: wrong })).statusCode).toBe(401);
    }

    const blocked = await h.request({ url: '/login', form: { password: WEAK_PASSWORD } });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('600');
    expect(blocked.body).toContain('Слишком много');
    expect(setCookieLines(blocked)).toEqual([]);
    expect(h.logs()).toContainEqual(expect.objectContaining({ action: 'login_blocked' }));

    h.advance(10 * MINUTE_MS);
    expect((await h.request({ url: '/login', form: { password: WEAK_PASSWORD } })).statusCode).toBe(
      303,
    );
  });

  it('другой клиент за доверенным локальным прокси (X-Forwarded-For) считается отдельно', async () => {
    const h = createHarness();
    const attacker = { 'x-forwarded-for': '203.0.113.1' };
    for (let i = 0; i < 5; i += 1) {
      await h.request({ url: '/login', form: wrong, headers: attacker });
    }

    const blocked = await h.request({ url: '/login', form: wrong, headers: attacker });
    const other = await h.request({
      url: '/login',
      form: { password: WEAK_PASSWORD },
      headers: { 'x-forwarded-for': '203.0.113.2' },
    });

    expect(blocked.statusCode).toBe(429);
    expect(other.statusCode).toBe(303);
  });

  it('успешный вход обнуляет счётчик неудач', async () => {
    const h = createHarness();
    for (let i = 0; i < 4; i += 1) await h.request({ url: '/login', form: wrong });
    await h.request({ url: '/login', form: { password: WEAK_PASSWORD } });
    for (let i = 0; i < 4; i += 1) await h.request({ url: '/login', form: wrong });

    const response = await h.request({ url: '/login', form: wrong });

    expect(response.statusCode).toBe(401);
  });
});

describe('панель: заголовок Host, HTTPS и прокси', () => {
  it.each([
    'evil.example.com',
    '127.0.0.1',
    '127.0.0.1:3101',
    'localhost',
    '127.0.0.1.evil.com:3100',
  ])('чужой Host «%s»: 403 на странице входа, списке и CSS', async (host) => {
    const h = createHarness();
    const { cookie } = await h.login();
    h.chats.listForPanel.mockClear();

    for (const url of ['/login', '/chats', '/panel.css']) {
      const response = await h.request({ url, host, cookie });
      expect(response.statusCode, url).toBe(403);
      expect(response.body).not.toContain('Клиент');
    }
    expect(h.chats.listForPanel).not.toHaveBeenCalled();
  });

  it('localhost с портом панели принимается', async () => {
    const h = createHarness();

    const response = await h.request({ url: '/login', host: 'localhost:3100' });

    expect(response.statusCode).toBe(200);
  });

  it('слабый пароль: домен из настроек не принимается, вход за Caddy закрыт', async () => {
    const h = createHarness({ allowedHosts: ['panel.example.kz'] });

    const response = await h.request({ url: '/login', host: 'panel.example.kz' });

    expect(response.statusCode).toBe(403);
  });

  it('сильный пароль и домен в настройках: вход по HTTPS через прокси даёт Secure и HSTS', async () => {
    const h = createHarness({ password: STRONG_PASSWORD, allowedHosts: ['panel.example.kz'] });
    const secure = {
      host: 'panel.example.kz',
      origin: 'https://panel.example.kz',
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.5' },
    };

    const response = await h.request({
      url: '/login',
      form: { password: STRONG_PASSWORD },
      ...secure,
    });

    expect(response.statusCode).toBe(303);
    expect(setCookieLines(response)[0]).toMatch(/; HttpOnly; SameSite=Strict; Secure$/);
    expect(response.headers['strict-transport-security']).toMatch(/^max-age=\d+$/);
    const cookie = sessionCookieOf(response) ?? '';
    const page = await h.request({ url: '/chats', cookie, ...secure });
    expect(page.statusCode).toBe(200);
  });

  it('по HTTP без прокси Secure и HSTS не ставятся', async () => {
    const h = createHarness({ password: STRONG_PASSWORD });

    const response = await h.request({ url: '/login', form: { password: STRONG_PASSWORD } });

    expect(setCookieLines(response)[0]).not.toContain('Secure');
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('панель: защита изменяющих запросов', () => {
  it.each([
    ['чужой сайт', 'http://evil.example.com'],
    ['схема не та', 'https://127.0.0.1:3100'],
    ['null', 'null'],
    ['чужой порт', 'http://127.0.0.1:3101'],
  ])('Origin «%s» отклоняется даже при верном токене', async (_label, origin) => {
    const h = createHarness({
      data: { chats: [makeChat(1, { control: { status: 'manager', by: 'bot' } })] },
    });
    const { cookie, csrf } = await h.login();

    const response = await h.request({ url: '/chats/1/return', cookie, origin, form: { csrf } });

    expect(response.statusCode).toBe(403);
    expect(h.actions()).toEqual([]);
  });

  it('нет ни Origin, ни Referer: отказ; свой Referer вместо Origin годится', async () => {
    const h = createHarness({
      data: { chats: [makeChat(1, { control: { status: 'manager', by: 'bot' } })] },
    });
    const { cookie, csrf } = await h.login();

    const without = await h.request({
      url: '/chats/1/return',
      cookie,
      origin: null,
      form: { csrf },
    });
    const foreign = await h.request({
      url: '/chats/1/return',
      cookie,
      origin: null,
      referer: 'http://evil.example.com/chats/1',
      form: { csrf },
    });
    const own = await h.request({
      url: '/chats/1/return',
      cookie,
      origin: null,
      referer: `${ORIGIN}/chats/1`,
      form: { csrf },
    });

    expect(without.statusCode).toBe(403);
    expect(foreign.statusCode).toBe(403);
    expect(own.statusCode).toBe(303);
    expect(h.actions()).toEqual(['returnToBot']);
  });

  it('вход тоже проверяет Origin: чужой сайт не получает сессию', async () => {
    const h = createHarness();

    const response = await h.request({
      url: '/login',
      origin: 'http://evil.example.com',
      form: { password: WEAK_PASSWORD },
    });

    expect(response.statusCode).toBe(403);
    expect(setCookieLines(response)).toEqual([]);
  });

  it('токена CSRF нет, он чужой или принадлежит другой сессии: 403', async () => {
    const h = createHarness({
      data: { chats: [makeChat(1, { control: { status: 'manager', by: 'bot' } })] },
    });
    const mine = await h.login();
    const other = await h.login();

    const forms: readonly Record<string, string>[] = [
      {},
      { csrf: '' },
      { csrf: 'подделка' },
      { csrf: other.csrf },
    ];
    for (const form of forms) {
      const response = await h.request({ url: '/chats/1/return', cookie: mine.cookie, form });
      expect(response.statusCode).toBe(403);
      expect(response.body).toContain('Запрос отклонён');
    }
    expect(h.actions()).toEqual([]);
    const ok = await h.request({
      url: '/chats/1/return',
      cookie: mine.cookie,
      form: { csrf: mine.csrf },
    });
    expect(ok.statusCode).toBe(303);
  });

  it('выход тоже требует токена CSRF: чужая страница не разлогинит владельца', async () => {
    const h = createHarness();
    const { cookie } = await h.login();

    const response = await h.request({ url: '/logout', cookie, form: {} });

    expect(response.statusCode).toBe(403);
    expect((await h.request({ url: '/chats', cookie })).statusCode).toBe(200);
  });
});

describe('панель: заголовки безопасности и ошибки', () => {
  it('заголовки безопасности стоят на страницах, перенаправлениях, 403, 404 и CSS', async () => {
    const h = createHarness();
    const { cookie } = await h.login();

    const responses = [
      await h.request({ url: '/login' }),
      await h.request({ url: '/chats', cookie }),
      await h.request({ url: '/chats' }),
      await h.request({ url: '/no-such-page', cookie }),
      await h.request({ url: '/login', host: 'evil.example.com' }),
      await h.request({ url: '/panel.css' }),
      await h.request({
        url: '/login',
        form: { password: 'x' },
        origin: 'http://evil.example.com',
      }),
    ];

    expect(responses.map((response) => response.statusCode)).toEqual([
      200, 200, 303, 404, 403, 200, 403,
    ]);
    for (const response of responses) expectSecurityHeaders(response);
  });

  it('CSS отдаётся отдельным адресом без входа и не содержит внешних ресурсов', async () => {
    const h = createHarness();

    const response = await h.request({ url: '/panel.css' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(response.body).toContain('{');
    expect(response.body).not.toMatch(/url\(|@import|expression\(|javascript:/i);
  });

  it('все страницы без скриптов и без inline-стилей: стили только отдельным файлом', async () => {
    const h = createHarness({ data: { chats: [makeChat(1)] } });
    const { cookie } = await h.login();

    for (const url of ['/login', '/chats', '/chats/1', '/notifications']) {
      const body = (await h.request({ url, cookie: url === '/login' ? undefined : cookie })).body;
      expect(body, url).toContain('<link rel="stylesheet" href="/panel.css">');
      expect(body, url).not.toMatch(/<script|\sstyle=|\son\w+=|javascript:/i);
    }
  });

  it('ошибка в репозитории: 500 без стека и без текста ошибки, подробности в логе', async () => {
    const h = createHarness();
    const { cookie } = await h.login();
    h.chats.listForPanel.mockImplementation(() => {
      throw new Error('секретная причина 77001234567');
    });

    const response = await h.request({ url: '/chats', cookie });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('Внутренняя ошибка');
    expect(response.body).not.toMatch(/секретная|77001234567|\bat\s.+\(|\.ts:\d+/);
    expectSecurityHeaders(response);
    expect(h.logs().some((line) => line['level'] === 50)).toBe(true);
    expect(h.rawLog()).not.toContain('77001234567');
  });

  it('неподдерживаемый тип тела: 415; слишком большое тело: 413', async () => {
    const h = createHarness();

    const json = await h.request({
      url: '/login',
      payload: '{"password":"admin"}',
      contentType: 'application/json',
    });
    const big = await h.request({ url: '/login', payload: `password=${'x'.repeat(70_000)}` });

    expect(json.statusCode).toBe(415);
    expect(big.statusCode).toBe(413);
    expectSecurityHeaders(json);
  });

  it('тело формы с кодировкой в Content-Type разбирается так же', async () => {
    const h = createHarness();

    const response = await h.request({
      url: '/login',
      form: { password: WEAK_PASSWORD },
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
    });

    expect(response.statusCode).toBe(303);
  });

  it('адрес с неверной записью: страница 400 с заголовками безопасности, а не JSON Fastify с адресом из запроса', async () => {
    const h = createHarness();

    const response = await h.request({ url: '/%E0%A4%A' });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toContain('Некорректный запрос');
    expect(response.body).not.toContain('%E0%A4%A');
    expectSecurityHeaders(response);
  });

  it('HEAD ходит теми же маршрутами: без сессии на вход, страница входа без тела', async () => {
    const h = createHarness();

    const closed = await h.app.inject({
      method: 'HEAD',
      url: '/chats',
      headers: { host: '127.0.0.1:3100' },
    });
    const open = await h.app.inject({
      method: 'HEAD',
      url: '/login',
      headers: { host: '127.0.0.1:3100' },
    });

    expect(closed.statusCode).toBe(303);
    expect(open.statusCode).toBe(200);
    expect(open.body).toBe('');
    expectSecurityHeaders(open);
  });

  it('запрос OPTIONS от чужого сайта не получает разрешающих заголовков CORS', async () => {
    const h = createHarness();

    const response = await h.app.inject({
      method: 'OPTIONS',
      url: '/chats',
      headers: {
        host: '127.0.0.1:3100',
        origin: 'http://evil.example.com',
        'access-control-request-method': 'POST',
      },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('после входа неизвестный адрес даёт страницу 404, а чужие методы не работают', async () => {
    const h = createHarness();
    const { cookie } = await h.login();

    const missing = await h.request({ url: '/no-such-page', cookie });
    const put = await h.request({ method: 'PUT', url: '/chats', cookie, form: { a: 'b' } });
    const del = await h.request({ method: 'DELETE', url: '/chats/1', cookie });

    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain('Страница не найдена');
    expect([put.statusCode, del.statusCode]).toEqual([404, 404]);
  });

  it.each([
    '/qr',
    '/qr.png',
    '/session',
    '/whatsapp',
    '/config',
    '/settings',
    '/env',
    '/api/session',
    '/admin',
    '/logs',
  ])('маршрута %s нет: панель не показывает сессию WhatsApp, QR и настройки', async (url) => {
    const h = createHarness();
    const { cookie } = await h.login();

    const response = await h.request({ url, cookie });

    expect(response.statusCode).toBe(404);
  });
});
