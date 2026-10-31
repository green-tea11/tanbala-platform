import { describe, expect, it } from 'vitest';
import { json, type RecordedCall } from '../helpers/fake-backends.js';
import { chatCard, companyLinks, leadsSummary, stubHome, waStatus } from '../helpers/fixtures.js';
import type { ClientCardBody, CompanyCardBody, HomeBody } from '../helpers/bodies.js';
import { harnessPerTest } from '../helpers/harness.js';

const start = harnessPerTest();

describe('главная', () => {
  it('собирает разделы обоих приложений, режим и расход за сегодня и месяц по таблице цен почты', async () => {
    const harness = await start();
    stubHome(harness.backends);
    const session = await harness.signIn('owner', 'owner');
    const response = await harness.request('GET', '/api/home', { session });
    expect(response.statusCode).toBe(200);
    const home = response.json<HomeBody>();
    expect(home.mode).toEqual({
      bot: { code: 'test', text: 'Закрытый режим: бот отвечает только номерам из списка (2)' },
      leads: {
        code: 'test_address',
        text: 'Тестовые письма только на owner@example.kz',
        testAddress: 'owner@example.kz',
      },
      lettersNote: 'Компаниям письма не отправляются.',
    });
    expect(home.spend).toEqual({
      day: '2026-10-30',
      monthFrom: '2026-10-01',
      pricesAsOf: '2026-10-06',
      bot: {
        today: { usd: 0.003, tokens: 1200, unpricedTokens: 100, calls: 3, notCountedCalls: 4 },
        month: { usd: 0.003, tokens: 1200, unpricedTokens: 100, calls: 3, notCountedCalls: 4 },
      },
      leads: {
        today: { usd: 0.00055, tokens: 13200, unpricedTokens: 0, calls: 3, notCountedCalls: 0 },
        month: {
          usd: 0.10055,
          tokens: 1_013_200,
          unpricedTokens: 0,
          calls: 4,
          notCountedCalls: 0,
        },
      },
      leadsBudget: { dailyUsd: 1, spentTodayUsd: 0.12, leftUsd: 0.88, over: false },
      botCalls: { today: 12, dailyLimit: 500, left: 488 },
    });
    expect(home.leadsSummary).toMatchObject({ overview: { lettersPending: 5 } });
    expect(home.botStatus).toMatchObject({ whatsapp: { state: 'open' } });
    // Месяц и сегодня — одним запросом за месяц по Алматы.
    const spendCall = harness.backends.calls.find((call) => call.path === '/spend');
    expect(spendCall?.url.search).toBe('?from=2026-10-01&to=2026-10-30');
  });

  it('новые передачи: отметка «видел» своя у каждого пользователя', async () => {
    const harness = await start();
    stubHome(harness.backends);
    const owner = await harness.signIn('owner', 'owner');
    const manager = await harness.signIn('manager', 'manager');
    const seen = await harness.request('POST', '/api/seen', {
      session: owner,
      body: { kind: 'handoff', ids: [7, 7] },
    });
    expect(seen.json()).toEqual({ result: 'seen', kind: 'handoff', count: 1 });
    const ownerHome = (
      await harness.request('GET', '/api/home', { session: owner })
    ).json<HomeBody>();
    expect(ownerHome.attention.newHandoffs).toBe(1);
    expect(ownerHome.attention.handoffs.map((h) => [h.id, h.seen])).toEqual([
      [7, true],
      [8, false],
    ]);
    const managerHome = (
      await harness.request('GET', '/api/home', { session: manager })
    ).json<HomeBody>();
    expect(managerHome.attention.newHandoffs).toBe(2);
  });

  it('«писали после письма»: первое сообщение клиента позже первого письма, с отметкой «видел»', async () => {
    const harness = await start();
    stubHome(harness.backends);
    const session = await harness.signIn('owner', 'owner');
    const before = (await harness.request('GET', '/api/home', { session })).json<HomeBody>();
    expect(before.afterLetter.items).toEqual([
      {
        chatId: 12,
        companyId: 5,
        chatName: 'Айгерим',
        companyName: 'ТОО Склад',
        firstLetterAt: '2026-10-15T10:00:00Z',
        firstClientMessageAt: '2026-10-20T10:00:00Z',
        daysAfter: 5,
        seen: false,
      },
    ]);
    expect(before.afterLetter.newCount).toBe(1);
    expect(before.afterLetter.note).toContain('день импорта');
    const digestCall = harness.backends.calls.find((call) => call.path === '/companies/digest');
    expect(digestCall?.url.searchParams.get('ids')).toBe('5,6');
    await harness.request('POST', '/api/seen', {
      session,
      body: { kind: 'after_letter', ids: [12] },
    });
    const after = (await harness.request('GET', '/api/home', { session })).json<HomeBody>();
    expect(after.afterLetter.newCount).toBe(0);
  });

  it('больше 100 компаний в связях: digest частями по 100 id', async () => {
    const harness = await start();
    stubHome(harness.backends);
    const items = Array.from({ length: 150 }, (_, index) => ({
      ...companyLinks().items[0],
      chatId: index + 1,
      companyId: index + 1,
    }));
    harness.backends.on('GET wa:/company-links', { items });
    const session = await harness.signIn('owner', 'owner');
    await harness.request('GET', '/api/home', { session });
    const digests = harness.backends.calls.filter((call) => call.path === '/companies/digest');
    expect(digests.map((call) => call.url.searchParams.get('ids')?.split(',').length)).toEqual([
      100, 50,
    ]);
  });

  it('бот не запущен: его разделы {unavailable: true}, почта работает, деньги бота не считаются', async () => {
    const harness = await start();
    stubHome(harness.backends);
    for (const path of ['/status', '/attention', '/spend', '/company-links']) {
      harness.backends.on(`GET wa:${path}`, () => {
        throw new TypeError('fetch failed');
      });
    }
    const session = await harness.signIn('owner', 'owner');
    const home = (await harness.request('GET', '/api/home', { session })).json<HomeBody>();
    const down = { unavailable: true, reason: 'unavailable' };
    expect(home.botStatus).toEqual(down);
    expect(home.attention).toEqual(down);
    expect(home.afterLetter).toEqual(down);
    expect(home.spend.bot).toEqual(down);
    expect(home.spend.botCalls).toEqual(down);
    expect(home.mode.bot).toEqual({ code: 'unavailable', text: 'Бот не запущен или недоступен' });
    expect(home.leadsSummary).toMatchObject({ budget: { dailyUsd: 1 } });
    expect(home.spend.leads.today.usd).toBe(0.00055);
  });

  it('почта недоступна: у бота доллары null (цен нет), токены видны; токен не принят — backend_auth', async () => {
    const harness = await start();
    stubHome(harness.backends);
    harness.backends.on('GET leads:/spend', () => json({ error: 'unauthorized' }, 401));
    harness.backends.on('GET leads:/summary', () => json({ error: 'x' }, 500));
    const session = await harness.signIn('owner', 'owner');
    const home = (await harness.request('GET', '/api/home', { session })).json<HomeBody>();
    expect(home.spend.leads).toEqual({ unavailable: true, reason: 'backend_auth' });
    expect(home.spend.pricesAsOf).toBeNull();
    expect(home.spend.bot.today).toEqual({
      usd: null,
      tokens: 1200,
      unpricedTokens: 1200,
      calls: 3,
      notCountedCalls: 4,
    });
    expect(home.mode.leads).toEqual({
      code: 'unavailable',
      text: 'Почта недоступна',
      testAddress: null,
    });
  });

  it('полоса режима: рабочий режим, WhatsApp не подключён, выключен; тестовая отправка выключена', async () => {
    const harness = await start();
    stubHome(harness.backends);
    harness.backends.on('GET leads:/summary', leadsSummary(null));
    const session = await harness.signIn('owner', 'owner');
    const cases: [Record<string, unknown>, string][] = [
      [{ testMode: false }, 'working'],
      [{ whatsapp: { enabled: true, state: 'connecting' } }, 'disconnected'],
      [{ whatsapp: { enabled: false, state: 'disabled' } }, 'disabled'],
    ];
    for (const [overrides, code] of cases) {
      harness.backends.on('GET wa:/status', waStatus(overrides));
      const home = (await harness.request('GET', '/api/home', { session })).json<HomeBody>();
      expect(home.mode.bot.code).toBe(code);
      expect(home.mode.leads).toEqual({
        code: 'test_off',
        text: 'Тестовая отправка выключена',
        testAddress: null,
      });
    }
  });
});

describe('карточка клиента', () => {
  it('подтверждённая компания: карточка чата и данные почты, пометка «подтверждена»', async () => {
    const harness = await start();
    harness.backends.on('GET wa:/chats/12', chatCard({ state: 'confirmed', confirmed: { id: 5 } }));
    harness.backends.on('GET leads:/companies/5', { company: { id: 5, name: 'ТОО Склад' } });
    const session = await harness.signIn('manager', 'manager');
    const card = (
      await harness.request('GET', '/api/clients/12', { session })
    ).json<ClientCardBody>();
    expect(card.chat.chat.name).toBe('Айгерим');
    expect(card.company).toEqual({
      id: 5,
      confirmed: true,
      label: 'подтверждена клиентом',
      leads: { company: { id: 5, name: 'ТОО Склад' } },
    });
  });

  it('причина передачи, «для расчёта» и рассказанное клиенту от бота доходят до интерфейса как есть (31.10.2026)', async () => {
    const harness = await start();
    const bot = chatCard({ state: 'unknown' });
    const calc = {
      known: [{ key: 'items', label: 'что лежит на хранении', inferred: false }],
      missing: [{ key: 'city', label: 'город' }],
    };
    const toldFacts = [{ id: 'F4', label: 'ручной сканер' }];
    const levelReason = 'Третий раз спрашивает цену. Клиент: «Так сколько?»';
    harness.backends.on('GET wa:/chats/12', {
      ...bot,
      chat: { ...bot.chat, toldFacts },
      profile: { ...bot.profile, calc, levelReason },
    });
    const session = await harness.signIn('manager', 'manager');

    const card = (await harness.request('GET', '/api/clients/12', { session })).json<{
      chat: { chat: { toldFacts: unknown }; profile: { calc: unknown; levelReason: unknown } };
    }>();

    expect(card.chat.profile.calc).toEqual(calc);
    expect(card.chat.profile.levelReason).toBe(levelReason);
    expect(card.chat.chat.toldFacts).toEqual(toldFacts);
  });

  it('только кандидат: его карточка с пометкой «не подтверждено»', async () => {
    const harness = await start();
    harness.backends.on(
      'GET wa:/chats/12',
      chatCard({
        state: 'candidate',
        confirmed: null,
        candidate: { id: 6, name: 'ТОО Логистика' },
      }),
    );
    harness.backends.on('GET leads:/companies/6', { company: { id: 6 } });
    const session = await harness.signIn('manager', 'manager');
    const card = (
      await harness.request('GET', '/api/clients/12', { session })
    ).json<ClientCardBody>();
    expect(card.company).toMatchObject({ id: 6, confirmed: false, label: 'не подтверждено' });
  });

  it('компании нет: company null, почта не вызывается', async () => {
    const harness = await start();
    harness.backends.on('GET wa:/chats/12', chatCard({ state: 'unknown' }));
    const session = await harness.signIn('manager', 'manager');
    const card = (
      await harness.request('GET', '/api/clients/12', { session })
    ).json<ClientCardBody>();
    expect(card.company).toBeNull();
    expect(harness.backends.callsTo('leads')).toEqual([]);
  });

  it('компании нет в почте (404) или почта недоступна: свой раздел, карточка чата есть', async () => {
    const harness = await start();
    harness.backends.on('GET wa:/chats/12', chatCard({ confirmed: { id: 5 } }));
    harness.backends.on('GET leads:/companies/5', () => json({ error: 'not_found' }, 404));
    const session = await harness.signIn('manager', 'manager');
    const deleted = (
      await harness.request('GET', '/api/clients/12', { session })
    ).json<ClientCardBody>();
    expect(deleted.company?.leads).toMatchObject({ notFound: true });
    harness.backends.on('GET leads:/companies/5', () => json({}, 500));
    const down = (
      await harness.request('GET', '/api/clients/12', { session })
    ).json<ClientCardBody>();
    expect(down.company?.leads).toEqual({ unavailable: true, reason: 'unavailable' });
  });

  it('чата нет: 404 «Чат не найден»; бот не запущен: {unavailable: true}', async () => {
    const harness = await start();
    harness.backends.on('GET wa:/chats/12', () => json({ error: 'not_found' }, 404));
    const session = await harness.signIn('manager', 'manager');
    const missing = await harness.request('GET', '/api/clients/12', { session });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'not_found', message: 'Чат не найден.' });
    const down = await harness.request('GET', '/api/clients/13', { session });
    expect(down.json()).toMatchObject({ unavailable: true, source: 'wa' });
  });
});

describe('карточка компании', () => {
  it('данные почты и связанные чаты бота по companyId', async () => {
    const harness = await start();
    harness.backends.on('GET leads:/companies/5', { company: { id: 5 }, history: [] });
    harness.backends.on('GET wa:/company-links', (call: RecordedCall) => {
      expect(call.url.searchParams.get('companyId')).toBe('5');
      return json({ items: [companyLinks().items[0]] });
    });
    const session = await harness.signIn('manager', 'manager');
    const card = (
      await harness.request('GET', '/api/companies/5', { session })
    ).json<CompanyCardBody>();
    expect(card.company).toEqual({ company: { id: 5 }, history: [] });
    expect(card.chats.items).toHaveLength(1);
  });

  it('бот недоступен: chats {unavailable: true}; компании нет: 404', async () => {
    const harness = await start();
    harness.backends.on('GET leads:/companies/5', { company: { id: 5 } });
    harness.backends.on('GET leads:/companies/6', () => json({ error: 'not_found' }, 404));
    const session = await harness.signIn('manager', 'manager');
    const card = (
      await harness.request('GET', '/api/companies/5', { session })
    ).json<CompanyCardBody>();
    expect(card.chats).toEqual({ unavailable: true, reason: 'unavailable' });
    const missing = await harness.request('GET', '/api/companies/6', { session });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'not_found', message: 'Компания не найдена.' });
  });
});
