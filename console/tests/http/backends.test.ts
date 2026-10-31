import { describe, expect, it } from 'vitest';
import { json, LEADS_TOKEN, WA_TOKEN } from '../helpers/fake-backends.js';
import { list } from '../helpers/fixtures.js';
import { harnessPerTest } from '../helpers/harness.js';

const start = harnessPerTest();

describe('ошибки приложений', () => {
  it('401 или 403 приложения: 502 backend_auth (а не 401: fail2ban его не считает)', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    harness.backends.on('GET wa:/chats', () => json({ error: 'unauthorized' }, 401));
    harness.backends.on('GET leads:/letters', () => json({ error: 'forbidden' }, 403));
    for (const url of ['/api/chats', '/api/letters']) {
      const response = await harness.request('GET', url, { session });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ error: 'backend_auth' });
    }
    harness.backends.on('POST wa:/chats/3/reply', () => json({ error: 'unauthorized' }, 401));
    const action = await harness.request('POST', '/api/chats/3/reply', {
      session,
      body: { text: 'Добрый день' },
    });
    expect(action.statusCode).toBe(502);
    expect(action.json()).toMatchObject({ error: 'backend_auth' });
  });

  it('бот не запущен: чтение — 200 {unavailable: true}, действие — 503 backend_unavailable', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    const read = await harness.request('GET', '/api/chats', { session });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({
      unavailable: true,
      reason: 'unavailable',
      source: 'wa',
      message: 'Бот не запущен или недоступен.',
    });
    const action = await harness.request('POST', '/api/chats/3/reply', {
      session,
      body: { text: 'Добрый день' },
    });
    expect(action.statusCode).toBe(503);
    expect(action.json()).toMatchObject({ error: 'backend_unavailable', source: 'wa' });
  });

  it('500 приложения и ответ не по схеме: «недоступно»', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    harness.backends.on('GET wa:/chats', () => json({ error: 'internal' }, 500));
    harness.backends.on('GET leads:/letters', { items: 'не список' });
    expect((await harness.request('GET', '/api/chats', { session })).json()).toMatchObject({
      unavailable: true,
    });
    expect((await harness.request('GET', '/api/letters', { session })).json()).toMatchObject({
      unavailable: true,
      source: 'leads',
    });
  });

  it('отказ по правилу: статус, код и текст приложения (без управляющих символов)', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    harness.backends.on('POST leads:/runs', () =>
      json({ error: 'conflict', message: 'Идёт запуск №7.‮ Новый можно\nначать позже.' }, 409),
    );
    const response = await harness.request('POST', '/api/runs', {
      session,
      body: { query: 'склад', city: 'almaty', count: 5 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'conflict',
      message: 'Идёт запуск №7. Новый можно начать позже.',
    });
  });

  it('404 без текста: свой текст по виду данных', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    harness.backends.on('GET wa:/chats/9', () => new Response(null, { status: 404 }));
    harness.backends.on('GET leads:/letters/9', () => json({ error: 'not_found' }, 404));
    const chat = await harness.request('GET', '/api/chats/9', { session });
    expect(chat.statusCode).toBe(404);
    expect(chat.json()).toEqual({ error: 'not_found', message: 'Чат не найден.' });
    const letter = await harness.request('GET', '/api/letters/9', { session });
    expect(letter.json()).toEqual({ error: 'not_found', message: 'Письмо не найдено.' });
  });

  it('лимиты почты (429 budget_exhausted, test_limit) и 503 not_configured доходят с кодом', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    harness.backends.on('POST leads:/runs', () =>
      json({ error: 'budget_exhausted', message: 'Дневной лимит $1 исчерпан.' }, 429),
    );
    harness.backends.on('POST leads:/drafts/4/send-test', () =>
      json({ error: 'not_configured', message: 'SMTP не настроен.' }, 503),
    );
    const run = await harness.request('POST', '/api/runs', {
      session,
      body: { query: 'склад', city: 'almaty', count: 5 },
    });
    expect(run.statusCode).toBe(429);
    expect(run.json()).toMatchObject({ error: 'budget_exhausted' });
    const test = await harness.request('POST', '/api/letters/4/send-test', { session });
    expect(test.statusCode).toBe(503);
    expect(test.json()).toEqual({ error: 'not_configured', message: 'SMTP не настроен.' });
  });
});

describe('ответ собирается заново', () => {
  it('заголовки, статус и Content-Type приложения не проходят наружу', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    harness.backends.on('GET wa:/chats', () =>
      json(list([{ id: 1, name: 'Айгерим' }]), 203, {
        'set-cookie': 'evil=1; Path=/',
        'x-backend-secret': 'leak',
        'content-type': 'text/plain',
        'access-control-allow-origin': '*',
      }),
    );
    const response = await harness.request('GET', '/api/chats', { session });
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['x-backend-secret']).toBeUndefined();
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.json()).toMatchObject({ items: [{ id: 1, name: 'Айгерим' }] });
  });

  it('text/html от приложения: «недоступно», HTML наружу не уходит', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    harness.backends.on(
      'GET leads:/companies',
      () =>
        new Response('<html><script>alert(1)</script></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const response = await harness.request('GET', '/api/companies', { session });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ unavailable: true, source: 'leads' });
    expect(response.body).not.toContain('<script>');
  });

  it('ключи __proto__ и constructor из ответа отбрасываются', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    harness.backends.on(
      'GET wa:/notifications',
      () =>
        new Response(
          '{"items":[{"id":1,"__proto__":{"admin":true},"constructor":{"x":1}}],"total":1,"page":1,"pages":1,"pageSize":30}',
          { status: 200 },
        ),
    );
    const response = await harness.request('GET', '/api/notifications', { session });
    expect(response.json()).toEqual({
      items: [{ id: 1, seen: false }],
      total: 1,
      page: 1,
      pages: 1,
      pageSize: 30,
    });
  });
});

describe('запросы к приложениям', () => {
  it('свой токен каждому приложению, X-Console-User у действий, redirect: error', async () => {
    const harness = await start();
    const session = await harness.signIn('aigerim', 'manager');
    harness.backends.on('GET wa:/chats', list([]));
    harness.backends.on('GET leads:/letters', list([]));
    harness.backends.on('POST wa:/chats/5/reply', { result: 'sent' });
    await harness.request('GET', '/api/chats', { session });
    await harness.request('GET', '/api/letters', { session });
    await harness.request('POST', '/api/chats/5/reply', { session, body: { text: 'Привет' } });
    const [chats, letters] = harness.backends.calls;
    const reply = harness.backends.calls.find((call) => call.method === 'POST');
    expect(chats?.headers['x-console-token']).toBe(WA_TOKEN);
    expect(chats?.headers['x-console-user']).toBeUndefined();
    expect(letters?.headers['x-console-token']).toBe(LEADS_TOKEN);
    expect(reply?.headers['x-console-token']).toBe(WA_TOKEN);
    expect(reply?.headers['x-console-user']).toBe('aigerim');
    expect(reply?.headers['content-type']).toBe('application/json');
    expect(reply?.body).toEqual({ text: 'Привет' });
    expect(reply?.init.redirect).toBe('error');
  });

  it('параметры фильтров проверяются и кодируются; лишние не передаются', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    harness.backends.on('GET wa:/chats', list([]));
    harness.backends.on('GET leads:/companies', list([]));
    await harness.request(
      'GET',
      `/api/chats?status=manager&q=${encodeURIComponent('Ай & ?=#')}&page=2&evil=1`,
      { session },
    );
    await harness.request('GET', '/api/companies?status=drafted&wa=1&sort=score&run=4', {
      session,
    });
    const [chats, companies] = harness.backends.calls;
    expect(chats?.url.search).toBe('?status=manager&q=%D0%90%D0%B9+%26+%3F%3D%23&page=2');
    expect(chats?.url.searchParams.get('q')).toBe('Ай & ?=#');
    expect(companies?.url.search).toBe('?status=drafted&run=4&wa=1&sort=score');
  });

  it('карточка «Нет почты»: status=no_email доходит до почты', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    harness.backends.on('GET leads:/companies', list([]));
    const response = await harness.request('GET', '/api/companies?status=no_email', { session });
    expect(response.statusCode).toBe(200);
    expect(harness.backends.calls[0]?.url.search).toBe('?status=no_email');
  });

  it('неверный id или фильтр: 400 и приложение не вызывается', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    const bad = [
      '/api/chats/0',
      '/api/chats/01',
      '/api/chats/1.5',
      '/api/chats/-1',
      '/api/chats/99999999999999999',
      '/api/chats?status=admin',
      '/api/companies?wa=2',
      '/api/letters?status=sent',
      '/api/chats/1/messages?before=abc',
      '/api/system/spend?from=2026-02-31',
    ];
    for (const url of bad) {
      const response = await harness.request('GET', url, { session });
      expect({ url, status: response.statusCode }).toEqual({ url, status: 400 });
    }
    expect(harness.backends.calls).toEqual([]);
  });
});
