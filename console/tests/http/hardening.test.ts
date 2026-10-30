import { describe, expect, it } from 'vitest';
import { json } from '../helpers/fake-backends.js';
import type { HomeBody, ItemsBody, SessionsBody } from '../helpers/bodies.js';
import { companyLinks, leadsSummary, stubHome, waStatus } from '../helpers/fixtures.js';
import { harnessPerTest, PASSWORD, type Harness } from '../helpers/harness.js';

const start = harnessPerTest();

function lastAudit(harness: Harness) {
  const [entry] = harness.context.audit.page(1, 1).items;
  return entry === undefined ? null : { action: entry.action, outcome: entry.outcome };
}

describe('закодированный путь /api не обходит проверки', () => {
  it('/%61pi/logout и /%61pi/login без Origin: 403 bad_origin', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    for (const url of ['/%61pi/logout', '/%61pi/login', '/%2561pi/logout']) {
      const response = await harness.request('POST', url, { session, origin: false });
      expect({ url, status: response.statusCode }).toEqual({ url, status: 403 });
    }
    expect((await harness.request('GET', '/api/session', { session })).statusCode).toBe(200);
  });

  it('GET /%61pi/… без сессии: 403 no_session, а не страница', async () => {
    const harness = await start();
    expect((await harness.request('GET', '/%61pi/session')).statusCode).toBe(403);
    expect((await harness.request('GET', '/%61pi/no-such')).json()).toMatchObject({
      error: 'no_session',
    });
  });
});

describe('вход: владельца нельзя запереть неудачами на его имя', () => {
  it('адрес, с которого владелец уже входил, проходит; новый адрес получает 429', async () => {
    const harness = await start();
    await harness.addUser('owner', 'owner');
    await harness.login('owner', PASSWORD, { 'x-forwarded-for': '10.0.0.1' });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await harness.request('POST', '/api/login', {
        body: { name: 'owner', password: 'подбор-пароля' },
        headers: { 'x-forwarded-for': `10.9.${attempt}.1` },
      });
    }
    const stranger = await harness.request('POST', '/api/login', {
      body: { name: 'owner', password: PASSWORD },
      headers: { 'x-forwarded-for': '10.8.0.1' },
    });
    expect(stranger.statusCode).toBe(429);
    const owner = await harness.request('POST', '/api/login', {
      body: { name: 'owner', password: PASSWORD },
      headers: { 'x-forwarded-for': '10.0.0.1' },
    });
    expect(owner.statusCode).toBe(200);
  });

  it('адреса IPv6 одной сети /64 делят окно попыток', async () => {
    const harness = await start();
    await harness.addUser('owner', 'owner');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await harness.request('POST', '/api/login', {
        body: { name: `n${attempt}`, password: 'подбор-пароля' },
        headers: { 'x-forwarded-for': `2001:db8:1:2::${attempt + 1}` },
      });
    }
    const next = await harness.request('POST', '/api/login', {
      body: { name: 'owner', password: PASSWORD },
      headers: { 'x-forwarded-for': '2001:db8:1:2:ffff::9' },
    });
    expect(next.statusCode).toBe(429);
  });
});

describe('итог действия неизвестен', () => {
  it.each([
    ['таймаут', () => new Promise<Response>(() => undefined)],
    ['500', () => json({ error: 'internal' }, 500)],
    ['ответ не по схеме', () => json({ result: 'что-то другое' })],
  ])(
    '%s: 502 unknown_outcome, «могло выполниться», журнал unknown_outcome',
    async (_name, handler) => {
      const harness = await start({ limits: { postTimeoutMs: 20 } });
      harness.backends.on('POST leads:/drafts/4/send-test', handler);
      const session = await harness.signIn('owner', 'owner');
      const response = await harness.request('POST', '/api/letters/4/send-test', { session });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ error: 'unknown_outcome', source: 'leads' });
      expect(String(response.json<{ message: string }>().message)).toContain('могло выполниться');
      expect(lastAudit(harness)).toEqual({
        action: 'letter_send_test',
        outcome: 'unknown_outcome',
      });
    },
  );

  it('приложение не запущено: 503 «не выполнено», журнал backend_unavailable; токен — backend_auth', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    const down = await harness.request('POST', '/api/letters/4/approve', { session });
    expect(down.statusCode).toBe(503);
    expect(lastAudit(harness)).toEqual({
      action: 'letter_approve',
      outcome: 'backend_unavailable',
    });
    harness.backends.on('POST leads:/drafts/4/approve', () => json({}, 401));
    await harness.request('POST', '/api/letters/4/approve', { session });
    expect(lastAudit(harness)).toEqual({ action: 'letter_approve', outcome: 'backend_auth' });
  });
});

describe('пределы приложений', () => {
  it('тело больше 16 КБ не уходит в почту: 413 с понятным текстом', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    const response = await harness.request('POST', '/api/letters/4/edit', {
      session,
      body: { subject: 'Тема', body: 'я'.repeat(9000) },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: 'too_large' });
    expect(harness.backends.calls).toEqual([]);
  });

  it('409 «идёт запуск» передаёт номер запуска activeRunId', async () => {
    const harness = await start();
    harness.backends.on('POST leads:/runs', () =>
      json({ error: 'conflict', message: 'Идёт запуск №7.', activeRunId: 7, other: 'x' }, 409),
    );
    const session = await harness.signIn('owner', 'owner');
    const response = await harness.request('POST', '/api/runs', {
      session,
      body: { query: 'склад', city: 'almaty', count: 5 },
    });
    expect(response.json()).toEqual({
      error: 'conflict',
      message: 'Идёт запуск №7.',
      activeRunId: 7,
    });
  });

  it('503 приложения на чтении (база недоступна): 200 {unavailable} с его текстом', async () => {
    const harness = await start();
    harness.backends.on('GET leads:/companies', () =>
      json({ error: 'db_unavailable', message: 'База данных недоступна.' }, 503),
    );
    const session = await harness.signIn('owner', 'owner');
    const response = await harness.request('GET', '/api/companies', { session });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      unavailable: true,
      reason: 'unavailable',
      source: 'leads',
      message: 'База данных недоступна.',
    });
  });

  it('поиск чатов до 64 символов Unicode', async () => {
    const harness = await start();
    harness.backends.on('GET wa:/chats', { items: [], total: 0, page: 1, pages: 1, pageSize: 30 });
    const session = await harness.signIn('owner', 'owner');
    const ok = await harness.request('GET', `/api/chats?q=${encodeURIComponent('😀'.repeat(64))}`, {
      session,
    });
    expect(ok.statusCode).toBe(200);
    const long = await harness.request('GET', `/api/chats?q=${'a'.repeat(65)}`, { session });
    expect(long.statusCode).toBe(400);
  });
});

describe('ответ клиенту и «Вернуть боту»', () => {
  it('связь WhatsApp не открыта: 422 до вызова бота, чат не уходит менеджеру', async () => {
    const harness = await start();
    harness.backends.on(
      'GET wa:/status',
      waStatus({ whatsapp: { enabled: true, state: 'closed' } }),
    );
    harness.backends.on('POST wa:/chats/12/reply', { result: 'sent' });
    const session = await harness.signIn('owner', 'owner');
    const response = await harness.request('POST', '/api/chats/12/reply', {
      session,
      body: { text: 'Добрый день' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: 'refused',
      message:
        'WhatsApp не подключён (связь потеряна): ответ не отправлен, статус чата не менялся.',
    });
    expect(harness.backends.calls.filter((call) => call.method === 'POST')).toEqual([]);
    expect(lastAudit(harness)).toEqual({ action: 'chat_reply', outcome: 'whatsapp_not_open' });
  });

  it('связь открыта: ответ уходит; отказ по тексту пишется в журнал', async () => {
    const harness = await start();
    harness.backends.on('GET wa:/status', waStatus());
    harness.backends.on('POST wa:/chats/12/reply', { result: 'sent' });
    const session = await harness.signIn('owner', 'owner');
    const sent = await harness.request('POST', '/api/chats/12/reply', {
      session,
      body: { text: 'Добрый день' },
    });
    expect(sent.json()).toMatchObject({ result: 'sent' });
    await harness.request('POST', '/api/chats/12/reply', { session, body: { text: ' ' } });
    expect(lastAudit(harness)).toEqual({ action: 'chat_reply', outcome: 'refused' });
  });

  it('заметка ровно 1000 символов уходит, 1001 — 422 с записью в журнал; resumed передаётся', async () => {
    const harness = await start();
    harness.backends.on('POST wa:/chats/12/return', { result: 'returned_answering', resumed: 2 });
    const session = await harness.signIn('owner', 'owner');
    const label = 'Ответ клиенту: '.length;
    const exact = await harness.request('POST', '/api/chats/12/return', {
      session,
      body: { answer: '😀'.repeat(1000 - label) },
    });
    expect(exact.json()).toMatchObject({ result: 'returned_answering', resumed: 2 });
    const over = await harness.request('POST', '/api/chats/12/return', {
      session,
      body: { answer: '😀'.repeat(1001 - label) },
    });
    expect(over.statusCode).toBe(422);
    expect(over.json()).toMatchObject({ noteLength: 1001 });
    expect(lastAudit(harness)).toEqual({ action: 'chat_return', outcome: 'refused' });
  });
});

describe('главная и уведомления', () => {
  it('граница месяца по Алматы: 1 ноября с 19:00 UTC 31 октября', async () => {
    const harness = await start();
    stubHome(harness.backends);
    harness.clock.advance(Date.parse('2026-10-31T19:30:00Z') - harness.clock.now());
    const session = await harness.signIn('owner', 'owner');
    const home = (await harness.request('GET', '/api/home', { session })).json<HomeBody>();
    const spend = harness.backends.calls.find((call) => call.path === '/spend');
    expect(spend?.url.search).toBe('?from=2026-11-01&to=2026-11-01');
    // Строки октября в «месяц» ноября не попадают.
    expect(home.spend.leads.month.usd).toBe(0);
  });

  it('бюджет почты не настроен: leftUsd null; 1000 связей — пометка «не все»', async () => {
    const harness = await start();
    stubHome(harness.backends);
    const summary = leadsSummary();
    harness.backends.on('GET leads:/summary', {
      ...summary,
      budget: { ...summary.budget, dailyUsd: null },
    });
    const link = companyLinks().items[0];
    harness.backends.on('GET wa:/company-links', {
      items: Array.from({ length: 1000 }, (_, index) => ({ ...link, chatId: index + 1 })),
    });
    const session = await harness.signIn('owner', 'owner');
    const home = (await harness.request('GET', '/api/home', { session })).json<HomeBody>();
    expect(home.spend.leadsBudget).toMatchObject({ dailyUsd: null, leftUsd: null });
    expect(home.afterLetter.linksTruncated).toBe(true);
  });

  it('уведомления с отметкой «видел» своего пользователя', async () => {
    const harness = await start();
    harness.backends.on('GET wa:/notifications', {
      items: [{ id: 55 }, { id: 56 }, { note: 'без id' }],
      total: 3,
      page: 1,
      pages: 1,
      pageSize: 30,
    });
    const session = await harness.signIn('owner', 'owner');
    await harness.request('POST', '/api/seen', {
      session,
      body: { kind: 'notification', ids: [55] },
    });
    const body = (
      await harness.request('GET', '/api/notifications', { session })
    ).json<ItemsBody>();
    expect(body.items).toEqual([
      { id: 55, seen: true },
      { id: 56, seen: false },
      { note: 'без id', seen: false },
    ]);
  });

  it('сессии в «Системе»: истёкшие, которые уборка ещё не удалила, не показываются', async () => {
    const harness = await start();
    const old = await harness.signIn('aigerim', 'manager');
    harness.clock.advance(8 * 24 * 60 * 60 * 1000);
    const owner = await harness.signIn('owner', 'owner');
    const list = (
      await harness.request('GET', '/api/system/sessions', { session: owner })
    ).json<SessionsBody>();
    expect(list.items.map((item) => item.user)).toEqual(['owner']);
    expect((await harness.request('GET', '/api/session', { session: old })).statusCode).toBe(403);
    const users = (
      await harness.request('GET', '/api/system/users', { session: owner })
    ).json<ItemsBody>();
    expect(users.items.map((item) => [item['name'], item['sessions']])).toEqual([
      ['aigerim', 0],
      ['owner', 1],
    ]);
  });
});
