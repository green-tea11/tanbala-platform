import { describe, expect, it, vi } from 'vitest';
import { buildConsoleApi, startConsoleApi } from '../../../src/panel/console-api.js';
import {
  CONSOLE_PORT,
  CONSOLE_TOKEN,
  createConsoleHarness,
  jsonOf,
  type ConsoleHarness,
} from './console-harness.js';

// Защита API консоли: токен первым, сокет, Host, прокси, браузер, X-Console-User, тело и заголовки ответов.

const STATUS = '/internal/console/status';
const REPLY = '/internal/console/chats/1/reply';

function expectError(
  response: Awaited<ReturnType<ConsoleHarness['request']>>,
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
  const body = jsonOf(response);
  expect(body['error']).toBe(code);
  expect(typeof body['message']).toBe('string');
  expect(Object.keys(body).sort()).toEqual(['error', 'message']);
}

/** Ни одного обращения к данным и действиям: проверка до маршрута. */
function expectUntouched(c: ConsoleHarness): void {
  expect(c.h.chats.getById).not.toHaveBeenCalled();
  expect(c.reads.apiCallsOn).not.toHaveBeenCalled();
  expect(c.h.actions()).toEqual([]);
}

describe('API консоли: токен проверяется первым', () => {
  it.each([
    ['без токена', { 'x-console-token': null }],
    ['неверный токен', { 'x-console-token': `${CONSOLE_TOKEN}x` }],
    [
      'токен бота в X-Internal-Token',
      { 'x-console-token': null, 'x-internal-token': CONSOLE_TOKEN },
    ],
    ['пустой токен', { 'x-console-token': '' }],
  ])('%s: 401 unauthorized на чтении', async (_label, headers) => {
    const c = createConsoleHarness();

    const response = await c.request({ url: STATUS, headers });

    expectError(response, 401, 'unauthorized');
    expectUntouched(c);
  });

  it.each([
    ['несуществующий путь', 'GET', '/internal/console/nope'],
    ['путь вне API', 'GET', '/'],
    ['неверный метод', 'DELETE', STATUS],
    ['OPTIONS', 'OPTIONS', STATUS],
    ['вход старой панели', 'GET', '/login'],
  ] as const)('%s без токена: 401, а не 404', async (_label, method, url) => {
    const c = createConsoleHarness();

    const response = await c.request({ method, url, headers: { 'x-console-token': null } });

    expectError(response, 401, 'unauthorized');
  });

  it('несуществующий путь с токеном: 404 not_found', async () => {
    const c = createConsoleHarness();

    expectError(await c.request({ url: '/internal/console/nope' }), 404, 'not_found');
    expectError(await c.request({ method: 'DELETE', url: STATUS }), 404, 'not_found');
  });

  it('POST без токена с неверным телом и чужим Host: 401 до чтения тела и до проверки Host', async () => {
    const c = createConsoleHarness();

    const response = await c.request({
      url: REPLY,
      body: '{не json',
      headers: { 'x-console-token': null, host: 'evil.example', origin: 'https://evil.example' },
    });

    expectError(response, 401, 'unauthorized');
    expectUntouched(c);
  });

  it('тело больше 16 КБ без токена: 401, а не 413', async () => {
    const c = createConsoleHarness();

    const response = await c.request({
      url: REPLY,
      body: { text: 'я'.repeat(20_000) },
      headers: { 'x-console-token': null },
    });

    expectError(response, 401, 'unauthorized');
  });

  it('неверная запись адреса (ошибка Fastify до маршрута): без токена 401, с токеном 400', async () => {
    const c = createConsoleHarness();

    const anonymous = await c.request({
      url: '/internal/console/chats/%E0%A4%A',
      headers: { 'x-console-token': null },
    });
    const withToken = await c.request({ url: '/internal/console/chats/%E0%A4%A' });

    expect([anonymous.statusCode, withToken.statusCode]).toEqual([401, 400]);
    expect(jsonOf(withToken)['error']).toBe('bad_request');
  });

  it('отказ в журнале одной строкой без токена и пути', async () => {
    const c = createConsoleHarness();

    await c.request({
      url: `${STATUS}?secret=1`,
      headers: { 'x-console-token': 'не-тот-токен-0123456789abcdef0123' },
    });

    expect(c.h.logs()).toContainEqual(
      expect.objectContaining({ module: 'console-api', action: 'token_rejected', level: 40 }),
    );
    expect(c.h.rawLog()).not.toContain('не-тот-токен');
    expect(c.h.rawLog()).not.toContain('secret');
    expect(c.h.rawLog()).not.toContain(CONSOLE_TOKEN);
  });
});

describe('API консоли: откуда можно звать', () => {
  it.each(['203.0.113.5', '192.168.1.10', '::ffff:10.0.0.1'])(
    'сокет не с этого компьютера (%s): 403 даже с токеном',
    async (remoteAddress) => {
      const c = createConsoleHarness();

      const response = await c.request({ url: STATUS, remoteAddress });

      expectError(response, 403, 'forbidden');
      expectUntouched(c);
    },
  );

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    'сокет %s: пропускается',
    async (remoteAddress) => {
      const c = createConsoleHarness();

      expect((await c.request({ url: STATUS, remoteAddress })).statusCode).toBe(200);
    },
  );

  it.each([`127.0.0.1:${CONSOLE_PORT}`, `localhost:${CONSOLE_PORT}`, `LOCALHOST:${CONSOLE_PORT}`])(
    'Host %s: пропускается',
    async (host) => {
      const c = createConsoleHarness();

      expect((await c.request({ url: STATUS, headers: { host } })).statusCode).toBe(200);
    },
  );

  it.each([
    '127.0.0.1',
    'localhost',
    '127.0.0.1:3100',
    'wa.tanbala.kz',
    `evil.example:${CONSOLE_PORT}`,
    `[::1]:${CONSOLE_PORT}`,
  ])('Host %s: 400 bad_request', async (host) => {
    const c = createConsoleHarness();

    expectError(await c.request({ url: STATUS, headers: { host } }), 400, 'bad_request');
  });

  it.each(['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded', 'via'])(
    'заголовок прокси %s: 400 bad_request',
    async (name) => {
      const c = createConsoleHarness();

      const response = await c.request({ url: STATUS, headers: { [name]: '127.0.0.1' } });

      expectError(response, 400, 'bad_request');
      expectUntouched(c);
    },
  );

  it.each([
    ['origin', `http://127.0.0.1:${CONSOLE_PORT}`],
    ['origin', 'null'],
    ['sec-fetch-site', 'same-origin'],
    ['sec-fetch-site', 'none'],
  ])('признак браузера %s: %s => 403 forbidden', async (name, value) => {
    const c = createConsoleHarness();

    expectError(await c.request({ url: STATUS, headers: { [name]: value } }), 403, 'forbidden');
  });
});

describe('API консоли: действия и тело', () => {
  it.each([
    ['без заголовка', null],
    ['пустой', ''],
    ['заглавные', 'Manager'],
    ['пробел', 'a b'],
    ['длиннее 32', 'a'.repeat(33)],
    ['кириллица', 'менеджер'],
  ])('X-Console-User %s: 400 до действий', async (_label, user) => {
    const c = createConsoleHarness();

    const response = await c.request({
      url: REPLY,
      body: { text: 'Добрый день' },
      headers: { 'x-console-user': user },
    });

    expectError(response, 400, 'bad_request');
    expectUntouched(c);
  });

  it('X-Console-User у GET не нужен', async () => {
    const c = createConsoleHarness();

    expect((await c.request({ url: STATUS, headers: { 'x-console-user': null } })).statusCode).toBe(
      200,
    );
  });

  it('тело больше 16 КБ с токеном: 413 too_large, действий нет', async () => {
    const c = createConsoleHarness();

    const response = await c.request({ url: REPLY, body: { text: 'я'.repeat(9_000) } });

    expectError(response, 413, 'too_large');
    expectUntouched(c);
  });

  it.each([
    ['не JSON', '{text:', 'application/json'],
    ['массив', '["текст"]', 'application/json'],
    ['строка JSON', '"текст"', 'application/json'],
    ['null', 'null', 'application/json'],
    ['пустое тело', '', 'application/json'],
    ['форма', 'text=hello', 'application/x-www-form-urlencoded'],
    ['простой текст', 'hello', 'text/plain'],
  ])('тело %s: 400 bad_request, действий нет', async (_label, body, contentType) => {
    const c = createConsoleHarness();

    const response = await c.request({ url: REPLY, body, contentType });

    expectError(response, 400, 'bad_request');
    expectUntouched(c);
  });

  it('POST без тела: 400 bad_request', async () => {
    const c = createConsoleHarness();

    expectError(await c.request({ method: 'POST', url: REPLY }), 400, 'bad_request');
  });

  it('ключ __proto__ в теле ничего не задевает: поле text читается как своё', async () => {
    const c = createConsoleHarness({ data: { chats: [] } });

    const response = await c.request({
      url: REPLY,
      body: '{"__proto__": {"text": "подмена"}, "constructor": 1}',
    });

    expectError(response, 400, 'bad_request');
    expect(({} as Record<string, unknown>)['text']).toBeUndefined();
  });
});

describe('API консоли: ответы и журнал', () => {
  it.each([
    ['чтение', STATUS],
    ['ошибка 401', '/internal/console/nope'],
  ])('%s: заголовки безопасности, no-store, nosniff', async (_label, url) => {
    const c = createConsoleHarness();

    const response = await c.request({
      url,
      headers: url === STATUS ? {} : { 'x-console-token': null },
    });

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });

  it('сбой чтения базы: 503 db_unavailable без текста ошибки, ошибка в лог', async () => {
    const c = createConsoleHarness();
    c.reads.apiCallsOn.mockImplementation(() => {
      throw Object.assign(new Error('database is locked: 77001234567'), { code: 'SQLITE_BUSY' });
    });

    const response = await c.request({ url: STATUS });

    expectError(response, 503, 'db_unavailable');
    expect(response.body).not.toContain('locked');
    expect(c.h.logs()).toContainEqual(
      expect.objectContaining({ level: 50, module: 'console-api-http' }),
    );
    expect(c.h.rawLog()).not.toContain('77001234567');
  });

  it('прочий сбой: 500 internal без текста ошибки', async () => {
    const c = createConsoleHarness();
    c.reads.apiCallsOn.mockImplementation(() => {
      throw new Error('строка испорчена');
    });

    const response = await c.request({ url: STATUS });

    expectError(response, 500, 'internal');
    expect(response.body).not.toContain('испорчена');
  });

  it('строка запроса и токен не попадают в лог Fastify даже при ошибке', async () => {
    const c = createConsoleHarness();

    await c.request({ url: '/internal/console/chats?q=Секретное-имя&page=abc' });
    await c.request({ url: REPLY, body: { text: 'я'.repeat(9_000) } });

    const log = c.h.rawLog();
    expect(log).not.toContain('Секретное');
    expect(log).not.toContain('q=');
    expect(log).not.toContain(CONSOLE_TOKEN);
  });

  it('сборка с токеном не по формату отклоняется: сервер без настоящего токена не собирается', () => {
    const c = createConsoleHarness();

    expect(() => buildConsoleApi({ ...c.deps, token: '' })).toThrow(RangeError);
    expect(() => buildConsoleApi({ ...c.deps, token: 'short' })).toThrow(RangeError);
    expect(() => buildConsoleApi({ ...c.deps, token: `${'a'.repeat(31)} ` })).toThrow(RangeError);
  });

  it('сборка не слушает порт', () => {
    const c = createConsoleHarness();

    expect(c.app.server.listening).toBe(false);
  });

  it('запуск слушает только 127.0.0.1 и порт API; ошибка порта всплывает', async () => {
    const c = createConsoleHarness();
    const listen = vi.fn(() => Promise.resolve(`http://127.0.0.1:${CONSOLE_PORT}`));
    Object.assign(c.app, { listen });

    await startConsoleApi(c.app, CONSOLE_PORT);
    listen.mockRejectedValueOnce(new Error('EADDRINUSE'));

    expect(listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: CONSOLE_PORT });
    await expect(startConsoleApi(c.app, CONSOLE_PORT)).rejects.toThrow('EADDRINUSE');
  });
});
