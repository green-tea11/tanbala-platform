import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { CompanyId, CompanySummary } from '../../../src/domain/company.js';
import { PanelSendError } from '../../../src/messaging/outbox.js';
import {
  CONSOLE_REPLIES_PER_CHAT_PER_HOUR,
  CONSOLE_REPLIES_PER_HOUR,
  REPLY_LIMIT_TEXTS,
} from '../../../src/panel/console-reply-limit.js';
import { SPEND_FILE_MAX_BYTES } from '../../../src/panel/console-spend.js';
import {
  CONSOLE_USER,
  createConsoleHarness,
  jsonOf,
  type ConsoleHarness,
} from './console-harness.js';
import { chatIdOf, makeChat, makeMessage, makeNotification, MINUTE_MS, T0 } from './harness.js';

// API консоли после ревью: предел ответов из консоли за час, дописка «чат уже у менеджера» к отказу после передачи,
// невидимые символы в JSON, число и страница списка одной транзакцией, 503 на слишком большой лог расхода.

const BASE = '/internal/console';
const HOUR_MS = 60 * MINUTE_MS;
/** Невидимые символы, которые консоль убирает сверх cleanText старой панели (кодами: в исходнике их не видно). */
const INVISIBLE = String.fromCodePoint(
  0x00ad,
  0x061c,
  0x200b,
  0x200c,
  0x200d,
  0x200e,
  0x200f,
  0x2028,
  0x2029,
  0xfeff,
);
const INVISIBLE_PATTERN = new RegExp([...INVISIBLE].join('|'), 'u');
/** Шесть чатов: пять по 20 ответов дают общий предел 100, шестой упирается в него. */
const CHAT_COUNT = 6;

function open(): ConsoleHarness {
  const chats = Array.from({ length: CHAT_COUNT }, (_unused, index) => makeChat(index + 1));
  return createConsoleHarness({ data: { chats } });
}

function reply(c: ConsoleHarness, chat: number, text: string) {
  return c.request({ url: `${BASE}/chats/${String(chat)}/reply`, body: { text } });
}

async function replyTimes(c: ConsoleHarness, chat: number, times: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let index = 0; index < times; index += 1) {
    statuses.push((await reply(c, chat, `Ответ ${String(chat)}-${String(index)}`)).statusCode);
  }
  return statuses;
}

describe('API консоли: предел ответов из консоли', () => {
  it('20 в час в один чат, 21-й — 429 rate_limited без передачи и отправки; другой чат отвечает', async () => {
    const c = open();

    const statuses = await replyTimes(c, 1, CONSOLE_REPLIES_PER_CHAT_PER_HOUR);
    const sends = c.h.outbox.sendFromPanel.mock.calls.length;
    const limited = await reply(c, 1, 'Ещё один ответ');
    const other = await reply(c, 2, 'Ответ в другой чат');

    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(limited.statusCode).toBe(429);
    expect(jsonOf(limited)).toEqual({ error: 'rate_limited', message: REPLY_LIMIT_TEXTS.chat });
    expect(c.h.outbox.sendFromPanel).toHaveBeenCalledTimes(sends + 1);
    expect(other.statusCode).toBe(200);
    expect(c.h.logs()).toContainEqual(
      expect.objectContaining({ action: 'reply_rate_limited', user: CONSOLE_USER, chatId: 1 }),
    );
  });

  it('100 в час на все чаты; через час окно сдвигается', async () => {
    const c = open();
    for (let chat = 1; chat <= 5; chat += 1) {
      await replyTimes(c, chat, CONSOLE_REPLIES_PER_CHAT_PER_HOUR);
    }

    const limited = await reply(c, 6, 'Сто первый ответ');
    c.h.advance(HOUR_MS);
    const later = await reply(c, 6, 'Через час');

    expect(CONSOLE_REPLIES_PER_HOUR).toBe(5 * CONSOLE_REPLIES_PER_CHAT_PER_HOUR);
    expect(jsonOf(limited)).toEqual({ error: 'rate_limited', message: REPLY_LIMIT_TEXTS.total });
    expect(later.statusCode).toBe(200);
  });

  it('считаются только ушедшие ответы: отказ, сбой и дубль место не занимают', async () => {
    const c = open();
    c.h.outbox.sendFromPanel.mockRejectedValueOnce(new Error('сбой'));
    c.h.outbox.sendFromPanel.mockRejectedValueOnce(new PanelSendError('Отказ отправки'));

    const failed = await reply(c, 1, 'Не уйдёт');
    const refused = await reply(c, 1, 'Тоже не уйдёт');
    const empty = await reply(c, 1, '   ');
    const sent = await reply(c, 1, 'Дубль');
    const duplicate = await reply(c, 1, 'Дубль');
    const statuses = await replyTimes(c, 1, CONSOLE_REPLIES_PER_CHAT_PER_HOUR - 1);
    const limited = await reply(c, 1, 'Сверх предела');

    expect([failed, refused, empty, sent].map((r) => r.statusCode)).toEqual([502, 422, 422, 200]);
    expect(jsonOf(duplicate)).toEqual({ result: 'duplicate' });
    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(limited.statusCode).toBe(429);
  });

  it('старую панель предел консоли не касается', async () => {
    const c = open();
    await replyTimes(c, 1, CONSOLE_REPLIES_PER_CHAT_PER_HOUR);

    const viaPanel = await c.panelPost('/chats/1/reply', { text: 'Из старой панели' });

    expect(viaPanel.statusCode).toBe(303);
    expect(c.h.outbox.sendFromPanel).toHaveBeenLastCalledWith(chatIdOf(1), 'Из старой панели');
  });

  it('чата нет: 404 раньше предела', async () => {
    const c = open();
    await replyTimes(c, 1, CONSOLE_REPLIES_PER_CHAT_PER_HOUR);

    expect((await reply(c, 99, 'Нет чата')).statusCode).toBe(404);
  });
});

describe('API консоли: отказ после передачи', () => {
  it.each([
    ['без точки', 'Закрытый режим', 'Закрытый режим. Чат уже у менеджера, бот в нём молчит.'],
    [
      'с точкой',
      'WhatsApp не подключён.',
      'WhatsApp не подключён. Чат уже у менеджера, бот в нём молчит.',
    ],
  ])('%s: 422 с дописанным «Чат уже у менеджера»', async (_label, text, expected) => {
    const c = open();
    c.h.outbox.sendFromPanel.mockRejectedValueOnce(new PanelSendError(text));

    const response = await reply(c, 1, 'Добрый день');

    expect(response.statusCode).toBe(422);
    expect(jsonOf(response)).toEqual({ error: 'refused', message: expected });
  });

  it('отказ передачи (SafeError до передачи): текст без дописки', async () => {
    const c = open();
    c.h.handoff.handOff.mockRejectedValueOnce(new PanelSendError('Передача не прошла'));

    const response = await reply(c, 1, 'Добрый день');

    expect(jsonOf(response)).toEqual({ error: 'refused', message: 'Передача не прошла' });
    expect(c.h.outbox.sendFromPanel).not.toHaveBeenCalled();
  });

  it('старая панель показывает отказ отправки как раньше, без дописки', async () => {
    const c = open();
    c.h.outbox.sendFromPanel.mockRejectedValueOnce(new PanelSendError('Отказ отправки'));

    const page = await c.panelPost('/chats/1/reply', { text: 'Добрый день' });

    expect(page.statusCode).toBe(422);
    expect(page.body).toContain('Отказ отправки');
    expect(page.body).not.toContain('бот в нём молчит');
  });
});

const COMPANY: CompanySummary = {
  status: 'confirmed',
  companyId: 42 as CompanyId,
  name: `ТОО${INVISIBLE} Склад`,
  city: `Алматы${INVISIBLE}`,
  rubric: 'Склады',
  candidateSource: null,
  cardUrl: null,
  confirmedPains: [`пересорт${INVISIBLE}`],
  briefPains: [{ pain: `учёт${INVISIBLE}`, evidence: null, source: '2gis' }],
  emailed: false,
  research: null,
  statedName: `Склад${INVISIBLE}`,
};

describe('API консоли: невидимые символы', () => {
  it('карточка: имя, сообщения, выжимка, заметка, черновики, уведомление и компания без них', async () => {
    const chat = makeChat(1, {
      pushName: `Ал${INVISIBLE}ия`,
      profile: { ...makeChat(1).profile, business: `Магазин${INVISIBLE}`, city: INVISIBLE },
    });
    const c = createConsoleHarness({
      data: {
        chats: [chat],
        messages: [makeMessage(1, 1, { text: `При${INVISIBLE}вет` })],
        notifications: [makeNotification(2, { text: `Текст${INVISIBLE}` })],
        companies: new Map([[1, COMPANY]]),
        notes: new Map([[1, { text: `Узнай${INVISIBLE} 1С`, atMs: T0 }]]),
        rejectedDrafts: [
          {
            id: 1,
            chatId: chatIdOf(1),
            attempt: 1,
            source: 'code',
            draft: `Черно${INVISIBLE}вик`,
            remarks: [`Замечание${INVISIBLE}`],
            atMs: T0,
          },
        ],
      },
    });
    c.reads.profileMeta.mockReturnValue({ reason: `Причина${INVISIBLE}`, updatedAtMs: T0 });

    const response = await c.request({ url: `${BASE}/chats/1` });
    const body = jsonOf(response);

    expect(response.statusCode).toBe(200);
    expect(INVISIBLE_PATTERN.test(response.body)).toBe(false);
    expect(body['chat']).toMatchObject({ name: 'Алия' });
    expect(body['note']).toEqual({ text: 'Узнай 1С', at: new Date(T0).toISOString() });
    expect((body['messages'] as { items: { text: string }[] }).items[0]?.text).toBe('Привет');
    expect(body['company']).toMatchObject({
      statedName: 'Склад',
      confirmed: {
        name: 'ТОО Склад',
        city: 'Алматы',
        pains: [expect.objectContaining({ pain: 'учёт' })],
      },
      confirmedPains: ['пересорт'],
    });
    const fields = (body['profile'] as { fields: { key: string; value: unknown }[] }).fields;
    expect(fields.find((field) => field.key === 'business')?.value).toBe('Магазин');
    expect(fields.find((field) => field.key === 'city')?.value).toBeNull();
  });

  it('список чатов, «Требует внимания» и уведомления без них', async () => {
    const c = createConsoleHarness();
    c.reads.listChats.mockReturnValue([
      {
        id: chatIdOf(5),
        pushName: `Алия${INVISIBLE}`,
        pnJid: null,
        control: { status: 'bot', by: null },
        level: 'cold',
        lastMessageAtMs: T0,
        lastMessage: { author: 'client', kind: 'text', text: `Привет${INVISIBLE}` },
        openHandoff: null,
        company: { state: 'candidate', id: 7, name: `ИП${INVISIBLE} Кандидат` },
        waitingSinceMs: null,
      },
    ]);
    c.reads.hotChats.mockReturnValue([
      {
        chatId: chatIdOf(5),
        pushName: `Алия${INVISIBLE}`,
        pnJid: null,
        status: 'bot',
        levelReason: `Цена${INVISIBLE}`,
        levelUpdatedAtMs: T0,
        lastMessageAtMs: T0,
      },
    ]);
    c.reads.listNotifications.mockReturnValue([
      { ...makeNotification(1, { text: `Текст${INVISIBLE}` }), chatName: `Алия${INVISIBLE}` },
    ]);

    const responses = await Promise.all(
      ['chats', 'attention', 'notifications'].map((path) => c.request({ url: `${BASE}/${path}` })),
    );

    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(INVISIBLE_PATTERN.test(response.body)).toBe(false);
    }
    const list = await c.request({ url: `${BASE}/chats` });
    expect(jsonOf(list)['items']).toEqual([
      expect.objectContaining({
        name: 'Алия',
        lastMessage: { author: 'client', kind: 'text', text: 'Привет' },
        company: { state: 'candidate', id: 7, name: 'ИП Кандидат' },
      }),
    ]);
  });
});

describe('API консоли: транзакции чтения и окно «Требует внимания»', () => {
  it('число и страница списка одной транзакцией; «Требует внимания» и связи тоже', async () => {
    const c = createConsoleHarness();

    await c.request({ url: `${BASE}/chats` });
    await c.request({ url: `${BASE}/attention` });
    await c.request({ url: `${BASE}/company-links` });

    expect(c.reads.transactions()).toBe(3);
    expect(c.reads.attentionCounts).toHaveBeenCalledWith(T0);
  });

  it('списки обрезаны пределом 200: truncated и общее число, ждущие старше окна отдельно', async () => {
    const c = createConsoleHarness();
    const waiting = Array.from({ length: 200 }, (_unused, index) => ({
      chatId: chatIdOf(index + 1),
      pushName: null,
      pnJid: null,
      status: 'manager' as const,
      group: 'manager' as const,
      waitingSinceMs: T0 - (200 - index) * MINUTE_MS,
      lastClientAtMs: T0,
      complaint: false,
    }));
    c.reads.waitingChats.mockReturnValue(waiting);
    c.reads.attentionCounts.mockReturnValue({ handoffs: 0, hot: 0, waiting: 250, staleWaiting: 7 });

    const body = jsonOf(await c.request({ url: `${BASE}/attention` }));

    expect(body['waiting']).toHaveLength(200);
    expect(body['counts']).toEqual({
      handoffs: { total: 0, truncated: false },
      hot: { total: 0, truncated: false },
      waiting: { total: 250, truncated: true, staleExcluded: 7 },
    });
  });

  it('связей больше 1000: truncated и общее число', async () => {
    const c = createConsoleHarness();
    c.reads.countCompanyLinks.mockReturnValue(1500);

    const body = jsonOf(await c.request({ url: `${BASE}/company-links?companyId=42` }));

    expect(body).toEqual({ items: [], total: 1500, truncated: true });
  });
});

describe('API консоли: лог расхода больше предела', () => {
  it('503 log_too_large с понятным текстом, а не нули; строка в журнале', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanbala-spend-big-'));
    onTestFinished(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const path = join(dir, 'token-usage.jsonl');
    writeFileSync(path, '');
    // Размер больше предела без записи 32 МБ данных: файл растягивается.
    truncateSync(path, SPEND_FILE_MAX_BYTES + 1);
    const c = createConsoleHarness({ tokenLogPath: path });

    const response = await c.request({ url: `${BASE}/spend?from=2026-10-30&to=2026-10-30` });

    expect(response.statusCode).toBe(503);
    expect(jsonOf(response)).toEqual({
      error: 'log_too_large',
      message: expect.stringContaining('больше 32 МБ: расход не посчитан') as string,
    });
    expect(response.body).not.toContain(dir);
    expect(c.h.logs()).toContainEqual(expect.objectContaining({ action: 'spend_log_too_large' }));
  });
});
