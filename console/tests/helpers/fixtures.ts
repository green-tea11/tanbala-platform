import type { FakeBackends } from './fake-backends.js';

// Примеры ответов почты и бота по contract/CONSOLE_API.md.

export const PRICES = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-sonnet-5-5': { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
};

export function waStatus(overrides: Record<string, unknown> = {}) {
  return {
    whatsapp: { enabled: true, state: 'open', since: '2026-10-30T04:00:00Z' },
    testMode: true,
    allowlistSize: 2,
    managerConfigured: true,
    companyFeature: true,
    llmConfigured: true,
    apiCalls: { today: 12, dailyLimit: 500, perChatLimit: 100 },
    research24h: { count: 0, limit: 10 },
    pairingAttempts24h: 0,
    linkedAt: '2026-10-29T10:00:00Z',
    workingSince: null,
    historyIncomplete: false,
    ...overrides,
  };
}

export function waAttention() {
  return {
    handoffs: [
      {
        id: 7,
        chatId: 12,
        name: 'Айгерим',
        phone: '77010000001',
        reason: 'hot',
        reasonLabel: 'горячий клиент',
        level: 'hot',
        openedAt: '2026-10-30T05:00:00Z',
        notification: { status: 'sent', statusLabel: 'отправлено', attempts: 1 },
      },
      {
        id: 8,
        chatId: 13,
        name: 'Ерлан',
        phone: null,
        reason: 'asked_human',
        reasonLabel: 'просит человека',
        level: 'warm',
        openedAt: '2026-10-30T05:30:00Z',
        notification: null,
      },
    ],
    hot: [{ chatId: 12, name: 'Айгерим', phone: '77010000001', status: 'manager' }],
    waiting: [],
    backlog: { pending: 0 },
  };
}

export function leadsSummary(testAddress: string | null = 'owner@example.kz') {
  return {
    testMode: { testAddress },
    budget: { dailyUsd: 1.0, spentTodayUsd: 0.12, over: false },
    spend: { totalUsd: 0.31, totalTokens: 410000, unpricedTokens: 0 },
    overview: {
      companiesFound: 120,
      companiesFit: 40,
      avgScoreFit: 78,
      lettersPending: 5,
      lettersApproved: 3,
      whatsappCompanies: 2,
    },
    activeRun: null,
    research: { today: 1, perDay: 20, active: [] },
    testSends: { today: 0, perDay: 30 },
  };
}

export function leadsSpend() {
  return {
    rows: [
      // Сегодня: 1000·0.1 + 200·0.5 + 10000·0.01 + 2000·0.125 = 550 → $0.00055
      {
        day: '2026-10-30',
        model: 'claude-haiku-5-5',
        task: 'qualify',
        calls: 3,
        input: 1000,
        output: 200,
        cacheRead: 10000,
        cacheWrite: 2000,
      },
      // Раньше в месяце: 1 000 000 входа haiku → $0.10
      {
        day: '2026-10-02',
        model: 'claude-haiku-5-5',
        task: 'draft',
        calls: 1,
        input: 1_000_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    ],
    prices: PRICES,
    pricesAsOf: '2026-10-06',
  };
}

export function waSpend() {
  return {
    rows: [
      // Сегодня sonnet: 1000·2 + 100·10 = 3000 → $0.003
      {
        day: '2026-10-30',
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        purpose: 'reply',
        calls: 2,
        failed: 0,
        input: 1000,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
      },
      // Модель без цены: токены отдельно.
      {
        day: '2026-10-30',
        provider: 'anthropic',
        model: 'claude-unknown-9',
        purpose: 'review',
        calls: 1,
        failed: 0,
        input: 50,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
      },
      // Расшифровка OpenRouter: «не учтено».
      {
        day: '2026-10-30',
        provider: 'openrouter',
        model: 'elevenlabs/scribe-v2',
        purpose: 'transcribe',
        calls: 4,
        failed: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    ],
  };
}

export function companyLinks() {
  return {
    items: [
      {
        chatId: 12,
        companyId: 5,
        name: 'Айгерим',
        phone: '77010000001',
        status: 'manager',
        level: 'hot',
        confirmedAt: '2026-10-25T10:00:00Z',
        firstClientMessageAt: '2026-10-20T10:00:00Z',
        lastMessageAt: '2026-10-30T05:00:00Z',
      },
      {
        chatId: 14,
        companyId: 6,
        name: 'Самат',
        phone: null,
        status: 'bot',
        level: 'cold',
        confirmedAt: '2026-10-25T10:00:00Z',
        firstClientMessageAt: '2026-10-10T10:00:00Z',
        lastMessageAt: '2026-10-29T05:00:00Z',
      },
    ],
  };
}

export function digest() {
  return {
    items: [
      // Письмо 15.10, клиент написал 20.10 — «писали после письма», через 5 дней.
      {
        id: 5,
        name: 'ТОО Склад',
        city: 'almaty',
        rubric: 'Склады',
        fit: 'yes',
        score: 80,
        segment: 'склад',
        status: 'approved',
        requestedVia: null,
        whatsappContactedAt: null,
        blocked: false,
        emailed: true,
        firstLetterAt: '2026-10-15T10:00:00Z',
        lastLetterAt: '2026-10-15T10:00:00Z',
      },
      // Письмо 15.10, клиент написал 10.10 — раньше письма, не считается.
      {
        id: 6,
        name: 'ТОО Логистика',
        city: 'almaty',
        rubric: 'Логистика',
        fit: 'maybe',
        score: 50,
        segment: null,
        status: 'drafted',
        requestedVia: null,
        whatsappContactedAt: null,
        blocked: false,
        emailed: true,
        firstLetterAt: '2026-10-15T10:00:00Z',
        lastLetterAt: '2026-10-15T10:00:00Z',
      },
    ],
  };
}

export function list(items: readonly unknown[], extra: Record<string, unknown> = {}) {
  return { items, total: items.length, page: 1, pages: 1, pageSize: 30, ...extra };
}

export function chatCard(company: Record<string, unknown> | null) {
  return {
    chat: { id: 12, name: 'Айгерим', phone: '77010000001', status: 'manager' },
    profile: { fields: [], problemAgreed: false, levelReason: null, updatedAt: null },
    note: null,
    openHandoff: null,
    handoffs: [],
    lastNotification: null,
    company,
    rejected: { items: [], total: 0 },
    messages: { items: [], earlierBefore: null },
  };
}

/** Всё для главной: оба приложения отвечают. */
export function stubHome(backends: FakeBackends): void {
  backends.on('GET wa:/status', waStatus());
  backends.on('GET wa:/attention', waAttention());
  backends.on('GET wa:/spend', waSpend());
  backends.on('GET wa:/company-links', companyLinks());
  backends.on('GET leads:/summary', leadsSummary());
  backends.on('GET leads:/spend', leadsSpend());
  backends.on('GET leads:/companies/digest', digest());
}
