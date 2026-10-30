import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { CompanyId, CompanySummary, ResearchJobId } from '../../../src/domain/company.js';
import type { ConsoleChatRow } from '../../../src/domain/console.js';
import type { Jid } from '../../../src/domain/types.js';
import { createConsoleHarness, jsonOf } from './console-harness.js';
import {
  chatIdOf,
  makeChat,
  makeMessage,
  makeNotification,
  MINUTE_MS,
  OFF_COMPANY,
  T0,
} from './harness.js';

// Чтение API консоли: состояние, «Требует внимания», чаты, карточка, переписка, уведомления, связи, расход.

const BASE = '/internal/console';
/** Управляющий символ и смена направления: cleanText старой панели их убирает. */
const HIDDEN = '\u0007\u202e';
const PN = '77000000005@s.whatsapp.net' as Jid;

function row(overrides: Partial<ConsoleChatRow> = {}): ConsoleChatRow {
  return {
    id: chatIdOf(5),
    pushName: `Алия${HIDDEN}`,
    pnJid: PN,
    control: { status: 'manager', by: 'bot' },
    level: 'hot',
    lastMessageAtMs: T0,
    lastMessage: { author: 'client', kind: 'text', text: `Привет${HIDDEN}` },
    openHandoff: { reason: 'hot', level: 'warm', openedAtMs: T0 - MINUTE_MS },
    company: { state: 'confirmed', id: 42, name: 'ТОО Склад' },
    waitingSinceMs: T0 - 2 * MINUTE_MS,
    ...overrides,
  };
}

describe('API консоли: состояние', () => {
  it('WhatsApp по событиям сокета, режим, флаги, лимиты и отметки', async () => {
    const c = createConsoleHarness({ whatsapp: { state: 'connecting', sinceMs: T0 - MINUTE_MS } });
    c.reads.apiCallsOn.mockReturnValue(12);
    c.researchStarts.mockReturnValue(3);
    c.reads.pairingAttemptsSince.mockReturnValue(1);
    c.appState.getLinkedAtMs.mockReturnValue(T0 - 60 * MINUTE_MS);
    c.appState.getHistoryIncomplete.mockReturnValue(T0);

    const response = await c.request({ url: `${BASE}/status` });

    expect(response.statusCode).toBe(200);
    expect(jsonOf(response)).toEqual({
      whatsapp: {
        enabled: true,
        state: 'connecting',
        since: new Date(T0 - MINUTE_MS).toISOString(),
      },
      testMode: true,
      allowlistSize: 2,
      managerConfigured: true,
      companyFeature: true,
      llmConfigured: true,
      apiCalls: { today: 12, dailyLimit: 500, perChatLimit: 100 },
      research24h: { count: 3, limit: 10 },
      pairingAttempts24h: 1,
      linkedAt: new Date(T0 - 60 * MINUTE_MS).toISOString(),
      workingSince: null,
      historyIncomplete: true,
    });
    // Сутки по Алматы: T0 = 26.10.2026 10:00 UTC = 15:00 в Алматы.
    expect(c.reads.apiCallsOn).toHaveBeenCalledWith('2026-10-26');
    expect(c.researchStarts).toHaveBeenCalledWith(T0 - 24 * 60 * MINUTE_MS);
    expect(c.reads.pairingAttemptsSince).toHaveBeenCalledWith(T0 - 24 * 60 * MINUTE_MS);
  });

  it('WhatsApp выключен: state disabled, since null', async () => {
    const c = createConsoleHarness({
      facts: { waEnabled: false },
      whatsapp: { state: 'disabled', sinceMs: null },
    });

    const body = jsonOf(await c.request({ url: `${BASE}/status` }));

    expect(body['whatsapp']).toEqual({ enabled: false, state: 'disabled', since: null });
  });

  it('сутки Алматы начинаются в 19:00 UTC', async () => {
    const c = createConsoleHarness();
    c.h.advance(9 * 60 * MINUTE_MS);

    await c.request({ url: `${BASE}/status` });

    expect(c.reads.apiCallsOn).toHaveBeenCalledWith('2026-10-27');
  });
});

describe('API консоли: «Требует внимания»', () => {
  it('передачи с уведомлением, горячие, ждут ответа и простой; тексты без скрытых символов', async () => {
    const c = createConsoleHarness();
    c.reads.openHandoffs.mockReturnValue([
      {
        id: 7,
        chatId: chatIdOf(5),
        pushName: `Алия${HIDDEN}`,
        pnJid: null,
        reason: 'asked_human',
        level: 'warm',
        openedAtMs: T0,
        notification: { status: 'no_manager', attempts: 1 },
      },
      {
        id: 8,
        chatId: chatIdOf(6),
        pushName: null,
        pnJid: PN,
        reason: 'hot',
        level: 'hot',
        openedAtMs: T0,
        notification: null,
      },
    ]);
    c.reads.hotChats.mockReturnValue([
      {
        chatId: chatIdOf(6),
        pushName: 'Бауыржан',
        pnJid: PN,
        status: 'bot',
        levelReason: `Спросил цену${HIDDEN}`,
        levelUpdatedAtMs: T0,
        lastMessageAtMs: null,
      },
    ]);
    c.reads.waitingChats.mockReturnValue([
      {
        chatId: chatIdOf(5),
        pushName: 'Алия',
        pnJid: PN,
        status: 'manager',
        group: 'manager',
        waitingSinceMs: T0 - MINUTE_MS,
        lastClientAtMs: T0,
        complaint: true,
      },
    ]);
    c.reads.pendingBacklogCount.mockReturnValue(4);
    c.reads.attentionCounts.mockReturnValue({ handoffs: 2, hot: 1, waiting: 1, staleWaiting: 0 });

    const body = jsonOf(await c.request({ url: `${BASE}/attention` }));

    expect(body).toEqual({
      handoffs: [
        {
          id: 7,
          chatId: 5,
          name: 'Алия',
          phone: null,
          reason: 'asked_human',
          reasonLabel: 'клиент просит живого человека',
          level: 'warm',
          levelLabel: 'тёплый',
          openedAt: new Date(T0).toISOString(),
          notification: {
            status: 'no_manager',
            statusLabel: 'номер менеджера не задан, только в панели',
            attempts: 1,
          },
        },
        expect.objectContaining({ id: 8, name: null, phone: '77000000005', notification: null }),
      ],
      hot: [
        {
          chatId: 6,
          name: 'Бауыржан',
          phone: '77000000005',
          status: 'bot',
          levelReason: 'Спросил цену',
          levelUpdatedAt: new Date(T0).toISOString(),
          lastMessageAt: null,
        },
      ],
      waiting: [
        {
          chatId: 5,
          name: 'Алия',
          phone: '77000000005',
          status: 'manager',
          group: 'manager',
          waitingSince: new Date(T0 - MINUTE_MS).toISOString(),
          lastClientAt: new Date(T0).toISOString(),
          complaint: true,
        },
      ],
      backlog: { pending: 4 },
      counts: {
        handoffs: { total: 2, truncated: false },
        hot: { total: 1, truncated: false },
        waiting: { total: 1, truncated: false, staleExcluded: 0 },
      },
    });
    expect(c.reads.waitingChats).toHaveBeenCalledWith(T0, 200);
  });
});

describe('API консоли: список чатов', () => {
  it('строка чата по контракту, 30 на странице, общее число и страницы', async () => {
    const c = createConsoleHarness();
    c.reads.listChats.mockReturnValue([row()]);
    c.reads.countChats.mockReturnValue(61);

    const response = await c.request({ url: `${BASE}/chats?page=2` });

    expect(response.statusCode).toBe(200);
    expect(jsonOf(response)).toEqual({
      items: [
        {
          id: 5,
          name: 'Алия',
          phone: '77000000005',
          phoneHidden: false,
          status: 'manager',
          statusBy: 'bot',
          statusLabel: 'Ведёт менеджер (передал бот)',
          level: 'hot',
          levelLabel: 'горячий',
          lastMessageAt: new Date(T0).toISOString(),
          lastMessage: { author: 'client', kind: 'text', text: 'Привет' },
          openHandoff: {
            reason: 'hot',
            reasonLabel: 'горячий клиент',
            level: 'warm',
            levelLabel: 'тёплый',
            openedAt: new Date(T0 - MINUTE_MS).toISOString(),
          },
          company: { state: 'confirmed', id: 42, name: 'ТОО Склад' },
          waitingSince: new Date(T0 - 2 * MINUTE_MS).toISOString(),
        },
      ],
      total: 61,
      page: 2,
      pages: 3,
      pageSize: 30,
    });
    expect(c.reads.listChats).toHaveBeenCalledWith(
      { nowMs: T0, waitingOnly: false },
      { limit: 30, offset: 30 },
    );
  });

  it('только @lid: phone null, phoneHidden true; длинное сообщение режется до 140 символов', async () => {
    const c = createConsoleHarness();
    c.reads.listChats.mockReturnValue([
      row({
        pnJid: null,
        company: null,
        openHandoff: null,
        waitingSinceMs: null,
        lastMessage: { author: 'bot', kind: 'text', text: 'я'.repeat(500) },
      }),
      row({ lastMessage: { author: 'client', kind: 'voice', text: null }, lastMessageAtMs: null }),
      row({ lastMessage: null }),
    ]);

    const items = jsonOf(await c.request({ url: `${BASE}/chats` }))['items'] as Record<
      string,
      unknown
    >[];

    expect(items[0]).toMatchObject({
      phone: null,
      phoneHidden: true,
      company: null,
      openHandoff: null,
      waitingSince: null,
    });
    const text = (items[0]?.['lastMessage'] as { text: string }).text;
    expect([...text]).toHaveLength(140);
    expect(text.endsWith('…')).toBe(true);
    expect(items[1]?.['lastMessage']).toEqual({ author: 'client', kind: 'voice', text: null });
    expect(items[1]?.['lastMessageAt']).toBeNull();
    expect(items[2]?.['lastMessage']).toBeNull();
  });

  it('фильтры передаются в выборку: статус, уровень, компания, ждут ответа, поиск', async () => {
    const c = createConsoleHarness();

    await c.request({
      url: `${BASE}/chats?status=bot&level=warm&company=none&waiting=1&q=${encodeURIComponent(' алия ')}`,
    });
    await c.request({ url: `${BASE}/chats?q=${encodeURIComponent('+7 (700) 000-00')}&status=` });

    expect(c.reads.countChats).toHaveBeenNthCalledWith(1, {
      nowMs: T0,
      status: 'bot',
      level: 'warm',
      company: 'none',
      waitingOnly: true,
      search: { nameVariants: ['алия', 'алия', 'АЛИЯ', 'Алия'], digits: null },
    });
    expect(c.reads.countChats).toHaveBeenNthCalledWith(2, {
      nowMs: T0,
      waitingOnly: false,
      search: {
        nameVariants: ['+7 (700) 000-00', '+7 (700) 000-00', '+7 (700) 000-00', '+7 (700) 000-00'],
        digits: '770000000',
      },
    });
  });

  it.each([
    'status=closed',
    'level=very',
    'company=yes',
    'waiting=yes',
    'page=0',
    'page=abc',
    'status=bot&status=manager',
    `q=${'a'.repeat(65)}`,
  ])('неверный параметр %s: 400 bad_request до выборки', async (query) => {
    const c = createConsoleHarness();

    const response = await c.request({ url: `${BASE}/chats?${query}` });

    expect(response.statusCode).toBe(400);
    expect(jsonOf(response)['error']).toBe('bad_request');
    expect(c.reads.listChats).not.toHaveBeenCalled();
  });

  it('страница за последней: пустой items с верными total и pages', async () => {
    const c = createConsoleHarness();
    c.reads.countChats.mockReturnValue(3);

    const body = jsonOf(await c.request({ url: `${BASE}/chats?page=9` }));

    expect(body).toEqual({ items: [], total: 3, page: 9, pages: 1, pageSize: 30 });
  });
});

const CHAT = makeChat(1, {
  pushName: `Алия${HIDDEN}`,
  control: { status: 'manager', by: 'panel' },
  level: 'warm',
  profile: {
    business: 'Магазин одежды',
    items: 'одежда',
    packaging: null,
    material: null,
    city: `Алматы${HIDDEN}`,
    premises: null,
    area: null,
    scope: null,
    itemCount: '5000',
    turnover: null,
    currentTracking: null,
    monthlyIntake: '500 в месяц',
    passages: `два входа${HIDDEN}`,
    shelfRecount: null,
    has1C: true,
    oneCName: null,
    problem: null,
    specifics: null,
    problemAgreed: true,
    inferred: ['has1C', 'itemCount', 'passages'],
  },
});

const CONFIRMED: CompanySummary = {
  status: 'confirmed',
  companyId: 42 as CompanyId,
  name: `ТОО Склад${HIDDEN}`,
  city: 'Алматы',
  rubric: 'Склады',
  candidateSource: null,
  cardUrl: 'https://leads.tanbala.kz/companies/42',
  confirmedPains: ['пересорт', '  '],
  briefPains: [{ pain: 'учёт вручную', evidence: 'цитата', source: '2gis' }],
  emailed: true,
  research: null,
  statedName: 'Склад',
};

describe('API консоли: карточка чата', () => {
  it('всё, что показывает старая карточка, и больше; тексты без скрытых символов', async () => {
    const c = createConsoleHarness({
      data: {
        chats: [CHAT],
        messages: [
          makeMessage(1, 1, { text: `Здравствуйте${HIDDEN}` }),
          makeMessage(2, 1, { author: 'bot', kind: 'voice', text: null }),
        ],
        handoffs: new Map([[1, { reason: 'human_took_over', level: 'warm', openedAtMs: T0 }]]),
        notifications: [
          makeNotification(3, { status: 'failed', attempts: 2, text: `Текст${HIDDEN}` }),
        ],
        companies: new Map([[1, CONFIRMED]]),
        notes: new Map([[1, { text: `Узнай 1С${HIDDEN}`, atMs: T0 }]]),
        rejectedDrafts: [
          {
            id: 1,
            chatId: chatIdOf(1),
            attempt: 2,
            source: 'review',
            draft: `Черновик${HIDDEN}`,
            remarks: [],
            atMs: T0,
          },
        ],
      },
    });
    c.reads.chatMeta.mockReturnValue({ statusChangedAtMs: T0, createdAtMs: T0 - MINUTE_MS });
    c.reads.profileMeta.mockReturnValue({ reason: `Спросил про объём${HIDDEN}`, updatedAtMs: T0 });
    c.reads.countRejected.mockReturnValue(25);
    c.reads.handoffHistory.mockReturnValue([
      {
        id: 9,
        reason: 'hot',
        level: 'hot',
        openedAtMs: T0 - 2 * MINUTE_MS,
        resolvedAtMs: T0 - MINUTE_MS,
      },
    ]);
    c.getProgress.mockReturnValue({ priceAsks: 2, refused: true, handedOff: true });

    const response = await c.request({ url: `${BASE}/chats/1` });

    expect(response.statusCode).toBe(200);
    const body = jsonOf(response);
    expect(body['chat']).toEqual({
      id: 1,
      name: 'Алия',
      phone: '77000000001',
      phoneHidden: false,
      status: 'manager',
      statusBy: 'panel',
      statusLabel: 'Ведёт менеджер (ответил из панели)',
      statusChangedAt: new Date(T0).toISOString(),
      level: 'warm',
      levelLabel: 'тёплый',
      createdAt: new Date(T0 - MINUTE_MS).toISOString(),
      priceAsks: 2,
      refusedAnswers: true,
      handedOff: true,
    });
    const profile = body['profile'] as { fields: Record<string, unknown>[] } & Record<
      string,
      unknown
    >;
    expect(profile.fields).toHaveLength(17);
    expect(profile.fields.map((field) => field['key'])).toEqual([
      'business',
      'items',
      'packaging',
      'material',
      'city',
      'premises',
      'area',
      'itemCount',
      'monthlyIntake',
      'turnover',
      'scope',
      'passages',
      'shelfRecount',
      'currentTracking',
      'problem',
      'oneC',
      'specifics',
    ]);
    // Поля для расчёта (30.10.2026): новые ключи с подписями старой панели, старые ключи на месте.
    expect(profile.fields[8]).toEqual({
      key: 'monthlyIntake',
      label: 'Нового в месяц',
      value: '500 в месяц',
      inferred: false,
    });
    expect(profile.fields[11]).toEqual({
      key: 'passages',
      label: 'Проходы',
      value: 'два входа',
      inferred: true,
    });
    expect(profile.fields[12]).toEqual({
      key: 'shelfRecount',
      label: 'Пересчёт полок',
      value: null,
      inferred: false,
    });
    expect(profile.fields[4]).toEqual({
      key: 'city',
      label: 'Город',
      value: 'Алматы',
      inferred: false,
    });
    expect(profile.fields[7]).toEqual({
      key: 'itemCount',
      label: 'Число вещей',
      value: '5000',
      inferred: true,
    });
    expect(profile.fields[15]).toEqual({
      key: 'oneC',
      label: '1С',
      value: 'есть, конфигурация не выяснена',
      inferred: true,
    });
    expect(profile.fields[2]).toEqual({
      key: 'packaging',
      label: 'В чём лежат',
      value: null,
      inferred: false,
    });
    expect(profile['problemAgreed']).toBe(true);
    expect(profile['levelReason']).toBe('Спросил про объём');
    expect(profile['updatedAt']).toBe(new Date(T0).toISOString());
    expect(body['note']).toEqual({ text: 'Узнай 1С', at: new Date(T0).toISOString() });
    expect(body['openHandoff']).toEqual({
      reason: 'human_took_over',
      reasonLabel: 'подключился человек',
      level: 'warm',
      levelLabel: 'тёплый',
      openedAt: new Date(T0).toISOString(),
    });
    expect(body['handoffs']).toEqual([
      {
        id: 9,
        reason: 'hot',
        reasonLabel: 'горячий клиент',
        level: 'hot',
        levelLabel: 'горячий',
        openedAt: new Date(T0 - 2 * MINUTE_MS).toISOString(),
        resolvedAt: new Date(T0 - MINUTE_MS).toISOString(),
      },
    ]);
    expect(body['lastNotification']).toMatchObject({
      kind: 'handoff',
      kindLabel: 'передача чата',
      status: 'failed',
      statusLabel: 'сбой отправки',
      attempts: 2,
      at: new Date(T0 + 3 * MINUTE_MS).toISOString(),
      text: 'Текст',
    });
    expect(body['company']).toEqual({
      state: 'confirmed',
      stateLabel: 'подтверждена клиентом',
      candidate: null,
      confirmed: {
        id: 42,
        name: 'ТОО Склад',
        city: 'Алматы',
        rubric: 'Склады',
        emailed: true,
        pains: [{ pain: 'учёт вручную', evidence: 'цитата', source: '2gis', sourceLabel: '2ГИС' }],
      },
      research: null,
      confirmedPains: ['пересорт'],
      statedName: 'Склад',
      cardUrl: 'https://leads.tanbala.kz/companies/42',
    });
    expect(body['rejected']).toEqual({
      items: [
        {
          at: new Date(T0).toISOString(),
          attempt: 2,
          source: 'review',
          sourceLabel: 'проверка вторым вызовом',
          draft: 'Черновик',
          remarks: ['причина не названа'],
        },
      ],
      total: 25,
    });
    expect(body['messages']).toEqual({
      items: [
        {
          id: 1,
          author: 'client',
          authorLabel: 'Клиент',
          kind: 'text',
          text: 'Здравствуйте',
          at: new Date(T0 + MINUTE_MS).toISOString(),
        },
        {
          id: 2,
          author: 'bot',
          authorLabel: 'Бот',
          kind: 'voice',
          text: null,
          at: new Date(T0 + 2 * MINUTE_MS).toISOString(),
        },
      ],
      earlierBefore: null,
    });
    expect(response.body).not.toContain('\u202e');
    expect(response.body).not.toContain('\u0007');
  });

  it('карточка ничего не меняет: только чтение', async () => {
    const c = createConsoleHarness({ data: { chats: [CHAT] } });

    await c.request({ url: `${BASE}/chats/1` });

    expect(c.h.actions()).toEqual([]);
    expect(c.h.outbox.canSendFromPanel).not.toHaveBeenCalled();
  });

  it.each([
    [
      'кандидат',
      {
        ...OFF_COMPANY,
        status: 'candidate',
        companyId: 7 as CompanyId,
        name: 'ИП Кандидат',
        candidateSource: 'phone',
        cardUrl: 'javascript:alert(1)',
      } satisfies CompanySummary,
    ],
    [
      'проверка идёт',
      {
        ...OFF_COMPANY,
        status: 'unknown',
        research: {
          status: 'running',
          jobId: 'job' as ResearchJobId,
          startedAtMs: T0,
          checkedAtMs: T0,
        },
      } satisfies CompanySummary,
    ],
    [
      'проверка не удалась',
      {
        ...OFF_COMPANY,
        status: 'unknown',
        research: { status: 'failed', reason: null, finishedAtMs: T0 },
      } satisfies CompanySummary,
    ],
    [
      'проверка завершена',
      {
        ...OFF_COMPANY,
        status: 'unknown',
        research: { status: 'done', companyId: 9 as CompanyId, finishedAtMs: T0 },
      } satisfies CompanySummary,
    ],
  ])('компания: %s', async (label, summary) => {
    const c = createConsoleHarness({ data: { chats: [CHAT], companies: new Map([[1, summary]]) } });

    const company = jsonOf(await c.request({ url: `${BASE}/chats/1` }))['company'] as Record<
      string,
      unknown
    >;

    if (label === 'кандидат') {
      expect(company).toMatchObject({
        state: 'candidate',
        stateLabel: 'кандидат, клиент не подтвердил',
        candidate: {
          id: 7,
          name: 'ИП Кандидат',
          city: null,
          source: 'phone',
          sourceLabel: 'по номеру',
        },
        confirmed: null,
        cardUrl: null,
      });
    } else if (label === 'проверка идёт') {
      expect(company['research']).toEqual({
        status: 'running',
        label: 'идёт',
        startedAt: new Date(T0).toISOString(),
        finishedAt: null,
      });
    } else if (label === 'проверка не удалась') {
      expect(company['research']).toMatchObject({
        status: 'failed',
        reason: null,
        label: 'ошибка',
      });
    } else {
      expect(company['research']).toMatchObject({
        status: 'done',
        label: 'завершена, компания найдена',
      });
    }
  });

  it('сводка о компании не прочитана: state not_read, карточка открывается, в журнале имя ошибки', async () => {
    const c = createConsoleHarness({
      data: { chats: [CHAT], companies: new Map([[1, new TypeError('секрет 77001234567')]]) },
    });

    const response = await c.request({ url: `${BASE}/chats/1` });

    expect(response.statusCode).toBe(200);
    expect(jsonOf(response)['company']).toMatchObject({
      state: 'not_read',
      stateLabel: 'данные не прочитаны',
    });
    expect(c.h.logs()).toContainEqual(
      expect.objectContaining({
        action: 'company_summary_failed',
        errorName: 'TypeError',
        chatId: 1,
      }),
    );
    expect(c.h.rawLog()).not.toContain('секрет');
  });

  it.each(['99', 'abc', '0', '01', '1.5'])('чат «%s» не найден: 404 not_found', async (id) => {
    const c = createConsoleHarness({ data: { chats: [CHAT] } });

    const response = await c.request({ url: `${BASE}/chats/${id}` });

    expect(response.statusCode).toBe(404);
    expect(jsonOf(response)['error']).toBe('not_found');
  });

  it('неверный ID не доходит до базы', async () => {
    const c = createConsoleHarness();

    await c.request({ url: `${BASE}/chats/abc` });

    expect(c.h.chats.getById).not.toHaveBeenCalled();
  });
});

describe('API консоли: переписка', () => {
  const MESSAGES = Array.from({ length: 120 }, (_, index) => makeMessage(index + 1, 1));

  it('последние 50, старые сверху, earlierBefore для «раньше»', async () => {
    const c = createConsoleHarness({ data: { chats: [CHAT], messages: MESSAGES } });

    const body = jsonOf(await c.request({ url: `${BASE}/chats/1/messages` }));
    const items = body['items'] as { id: number }[];

    expect(items.map((item) => item.id)).toEqual(Array.from({ length: 50 }, (_, i) => i + 71));
    expect(body['earlierBefore']).toBe(71);
  });

  it('before листает раньше; в начале переписки earlierBefore null', async () => {
    const c = createConsoleHarness({ data: { chats: [CHAT], messages: MESSAGES } });

    const middle = jsonOf(await c.request({ url: `${BASE}/chats/1/messages?before=71` }));
    const first = jsonOf(await c.request({ url: `${BASE}/chats/1/messages?before=21` }));

    expect((middle['items'] as { id: number }[])[0]?.id).toBe(21);
    expect(middle['earlierBefore']).toBe(21);
    expect((first['items'] as unknown[]).length).toBe(20);
    expect(first['earlierBefore']).toBeNull();
    expect(c.h.messages.history).toHaveBeenCalledWith(chatIdOf(1), { limit: 51, beforeId: 71 });
  });

  it.each(['abc', '0', '-1'])('before=%s: 400', async (before) => {
    const c = createConsoleHarness({ data: { chats: [CHAT] } });

    expect((await c.request({ url: `${BASE}/chats/1/messages?before=${before}` })).statusCode).toBe(
      400,
    );
  });

  it('чата нет: 404', async () => {
    const c = createConsoleHarness();

    expect((await c.request({ url: `${BASE}/chats/5/messages` })).statusCode).toBe(404);
  });
});

describe('API консоли: уведомления и связи с компаниями', () => {
  it('уведомления с именем клиента, фильтр по статусу, страницы', async () => {
    const c = createConsoleHarness();
    c.reads.listNotifications.mockReturnValue([
      {
        ...makeNotification(4, { status: 'failed', attempts: 5, text: `Список${HIDDEN}` }),
        chatName: `Алия${HIDDEN}`,
      },
      { ...makeNotification(5, { kind: 'backlog', chatId: null }), chatName: null },
    ]);
    c.reads.countNotifications.mockReturnValue(31);

    const body = jsonOf(await c.request({ url: `${BASE}/notifications?status=failed&page=2` }));

    expect(c.reads.listNotifications).toHaveBeenCalledWith({
      status: 'failed',
      limit: 30,
      offset: 30,
    });
    expect(c.reads.countNotifications).toHaveBeenCalledWith({ status: 'failed' });
    expect(body).toMatchObject({ total: 31, page: 2, pages: 2, pageSize: 30 });
    expect((body['items'] as unknown[])[0]).toEqual({
      id: 4,
      at: new Date(T0 + 4 * MINUTE_MS).toISOString(),
      updatedAt: new Date(T0 + 4 * MINUTE_MS).toISOString(),
      kind: 'handoff',
      kindLabel: 'передача чата',
      status: 'failed',
      statusLabel: 'сбой отправки',
      attempts: 5,
      chatId: 1,
      chatName: 'Алия',
      text: 'Список',
    });
    expect((body['items'] as unknown[])[1]).toMatchObject({
      kind: 'backlog',
      chatId: null,
      chatName: null,
    });
  });

  it('без фильтра все; неверный статус 400', async () => {
    const c = createConsoleHarness();

    await c.request({ url: `${BASE}/notifications` });
    const bad = await c.request({ url: `${BASE}/notifications?status=lost` });

    expect(c.reads.countNotifications).toHaveBeenCalledWith({});
    expect(bad.statusCode).toBe(400);
  });

  it('связи чат → компания: все до 1000 или по companyId', async () => {
    const c = createConsoleHarness();
    c.reads.companyLinks.mockReturnValue([
      {
        chatId: chatIdOf(5),
        companyId: 42,
        pushName: 'Алия',
        pnJid: PN,
        status: 'bot',
        level: 'cold',
        confirmedAtMs: T0,
        firstClientMessageAtMs: T0 - MINUTE_MS,
        lastMessageAtMs: null,
      },
    ]);
    c.reads.countCompanyLinks.mockReturnValue(1);

    const all = jsonOf(await c.request({ url: `${BASE}/company-links` }));
    await c.request({ url: `${BASE}/company-links?companyId=42` });
    const bad = await c.request({ url: `${BASE}/company-links?companyId=x` });

    expect(all).toEqual({
      items: [
        {
          chatId: 5,
          companyId: 42,
          name: 'Алия',
          phone: '77000000005',
          status: 'bot',
          level: 'cold',
          confirmedAt: new Date(T0).toISOString(),
          firstClientMessageAt: new Date(T0 - MINUTE_MS).toISOString(),
          lastMessageAt: null,
        },
      ],
      total: 1,
      truncated: false,
    });
    expect(c.reads.countCompanyLinks).toHaveBeenNthCalledWith(1, {});
    expect(c.reads.countCompanyLinks).toHaveBeenNthCalledWith(2, { companyId: 42 });
    expect(c.reads.companyLinks).toHaveBeenNthCalledWith(1, { limit: 1000 });
    expect(c.reads.companyLinks).toHaveBeenNthCalledWith(2, { companyId: 42, limit: 1000 });
    expect(bad.statusCode).toBe(400);
  });
});

describe('API консоли: расход', () => {
  function useLog(current: readonly string[], rotated: readonly string[] | null): string {
    const dir = mkdtempSync(join(tmpdir(), 'tanbala-spend-'));
    onTestFinished(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const path = join(dir, 'token-usage.jsonl');
    writeFileSync(path, current.join('\n'));
    if (rotated !== null) writeFileSync(`${path}.1`, `${rotated.join('\r\n')}\r\n`);
    return path;
  }

  function line(ts: string, overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      ts,
      provider: 'anthropic',
      purpose: 'reply',
      model: 'claude-sonnet-5-5',
      input: 100,
      output: 20,
      cacheRead: 5,
      cacheWrite: 1,
      chatId: 1,
      ok: true,
      ...overrides,
    });
  }

  it('сумма по дням Алматы, провайдеру, модели и виду вызова из текущего и прошлого файла', async () => {
    const path = useLog(
      [
        line('2026-10-30T10:00:00.000Z'),
        line('2026-10-30T11:00:00.000Z', {
          ok: false,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        }),
        // 19:00 UTC — уже 31 октября по Алматы.
        line('2026-10-30T19:00:00.000Z', { purpose: 'review' }),
        line('2026-10-30T12:00:00.000Z', {
          provider: 'openrouter',
          purpose: 'transcribe',
          model: 'elevenlabs/scribe-v2',
        }),
        '{"обрыв записи',
        '',
        line('2026-10-30T12:00:00.000Z', { input: -1 }),
        line('2026-10-30T12:00:00.000Z', { purpose: 'other' }),
      ],
      [line('2026-10-29T08:00:00.000Z'), line('2026-09-01T08:00:00.000Z')],
    );
    const c = createConsoleHarness({ tokenLogPath: path });

    const response = await c.request({ url: `${BASE}/spend?from=2026-10-29&to=2026-10-31` });

    expect(response.statusCode).toBe(200);
    const sonnet = { provider: 'anthropic', model: 'claude-sonnet-5-5' };
    expect(jsonOf(response)).toEqual({
      from: '2026-10-29',
      to: '2026-10-31',
      rows: [
        {
          day: '2026-10-29',
          ...sonnet,
          purpose: 'reply',
          calls: 1,
          failed: 0,
          input: 100,
          output: 20,
          cacheRead: 5,
          cacheWrite: 1,
        },
        {
          day: '2026-10-30',
          ...sonnet,
          purpose: 'reply',
          calls: 2,
          failed: 1,
          input: 100,
          output: 20,
          cacheRead: 5,
          cacheWrite: 1,
        },
        {
          day: '2026-10-30',
          provider: 'openrouter',
          model: 'elevenlabs/scribe-v2',
          purpose: 'transcribe',
          calls: 1,
          failed: 0,
          input: 100,
          output: 20,
          cacheRead: 5,
          cacheWrite: 1,
        },
        {
          day: '2026-10-31',
          ...sonnet,
          purpose: 'review',
          calls: 1,
          failed: 0,
          input: 100,
          output: 20,
          cacheRead: 5,
          cacheWrite: 1,
        },
      ],
      skippedLines: 3,
    });
  });

  it('файлов нет: пустой ответ', async () => {
    const c = createConsoleHarness();

    const body = jsonOf(await c.request({ url: `${BASE}/spend?from=2026-10-01&to=2026-10-31` }));

    expect(body).toEqual({ from: '2026-10-01', to: '2026-10-31', rows: [], skippedLines: 0 });
  });

  it.each([
    ['без from', 'to=2026-10-30'],
    ['без to', 'from=2026-10-30'],
    ['не день', 'from=2026-10-30&to=завтра'],
    ['нет такого дня', 'from=2026-02-30&to=2026-03-01'],
    ['from позже to', 'from=2026-10-31&to=2026-10-30'],
    ['больше 62 дней', 'from=2026-08-29&to=2026-10-30'],
  ])('%s: 400', async (_label, query) => {
    const c = createConsoleHarness();

    const response = await c.request({ url: `${BASE}/spend?${query}` });

    expect(response.statusCode).toBe(400);
    expect(jsonOf(response)['error']).toBe('bad_request');
  });

  it('ровно 62 дня можно', async () => {
    const c = createConsoleHarness();

    expect(
      (await c.request({ url: `${BASE}/spend?from=2026-08-30&to=2026-10-30` })).statusCode,
    ).toBe(200);
  });
});
