import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createUnitOfWork } from '../../../src/db/connection.js';
import { createAppStateRepo } from '../../../src/db/repos/app-state.js';
import { createChatCompaniesRepo } from '../../../src/db/repos/chat-companies.js';
import { createChatsRepo } from '../../../src/db/repos/chats.js';
import { createConsoleReads } from '../../../src/db/repos/console-details.js';
import { createHandoffsRepo } from '../../../src/db/repos/handoffs.js';
import { createManagerNotificationsRepo } from '../../../src/db/repos/manager-notifications.js';
import { createMessagesRepo } from '../../../src/db/repos/messages.js';
import { createOutboundIdsRepo } from '../../../src/db/repos/outbound-ids.js';
import { createRejectedDraftsRepo } from '../../../src/db/repos/rejected-drafts.js';
import type { Clock, MessageSender } from '../../../src/domain/ports.js';
import type { Jid, PhoneDigits, WaMessageId } from '../../../src/domain/types.js';
import { createHandoffService } from '../../../src/handoff/handoff.js';
import { createOutbox } from '../../../src/messaging/outbox.js';
import { buildConsoleApi } from '../../../src/panel/console-api.js';
import { createRecentReplies } from '../../../src/panel/recent-replies.js';
import { buildPanel } from '../../../src/panel/server.js';
import { createLogger } from '../../../src/shared/logger.js';
import { PN_A, useMigratedDb } from '../db/fixture.js';
import { CONSOLE_HOST, CONSOLE_PORT, CONSOLE_TOKEN, FACTS, jsonOf } from './console-harness.js';
import { csrfOf, HOST_HEADER, OFF_COMPANY, ORIGIN, PORT, sessionCookieOf, T0 } from './harness.js';

// API консоли на настоящих репозиториях, службе передачи и исходящих (SQLite в памяти); WhatsApp заменён
// отправителем-записью. Старая панель рядом делит с консолью память недавних ответов, как в pipeline/panel-setup.ts.

interface SentMessage {
  readonly jid: Jid;
  readonly text: string;
}

interface Stack {
  readonly app: FastifyInstance;
  readonly panel: FastifyInstance;
  readonly sent: SentMessage[];
  readonly db: ReturnType<typeof useMigratedDb>;
  readonly clock: { now: number };
}

function build(options: { readonly allowlist: ReadonlySet<PhoneDigits> | null }): Stack {
  const db = useMigratedDb();
  const chats = createChatsRepo(db);
  const messages = createMessagesRepo(db);
  const handoffs = createHandoffsRepo(db);
  const notifications = createManagerNotificationsRepo(db);
  const logger = createLogger({ level: 'silent' });
  const time = { now: T0 };
  const clock: Clock = { now: () => time.now, sleep: () => Promise.resolve() };
  const sent: SentMessage[] = [];
  let nextId = 0;
  const sender: MessageSender = {
    newMessageId: () => {
      nextId += 1;
      return `OUT-${String(nextId)}` as WaMessageId;
    },
    sendText: (jid, text) => {
      sent.push({ jid, text });
      return Promise.resolve();
    },
    setTyping: () => Promise.resolve(),
  };
  const company = { summary: () => OFF_COMPANY, stopAwaiting: () => undefined };
  const outbox = createOutbox({
    sender,
    chats,
    messages,
    outboundIds: createOutboundIdsRepo(db),
    clock,
    managerJid: null,
    testAllowlist: options.allowlist,
    random: () => 0,
  });
  const handoff = createHandoffService({
    chats,
    handoffs,
    unitOfWork: createUnitOfWork(db),
    outbox,
    notifier: { notify: () => Promise.resolve('no_manager' as const) },
    company,
    clock,
    logger,
  });
  const chat = chats.upsertByIdentity(
    { replyJid: PN_A, lidJid: null, pnJid: PN_A },
    'Алия',
    T0 - 120_000,
  );
  messages.insertIfNew({
    chatId: chat.id,
    waId: 'IN-1' as WaMessageId,
    author: 'client',
    kind: 'text',
    text: 'Здравствуйте, нужен учёт',
    tsMs: T0 - 600_000,
  });
  const recentReplies = createRecentReplies(clock);
  const rejectedDrafts = createRejectedDraftsRepo(db);
  const panel = buildPanel({
    chats,
    messages,
    handoffs,
    notifications,
    rejectedDrafts,
    outbox,
    handoff,
    company,
    clock,
    logger,
    password: 'admin',
    port: PORT,
    recentReplies,
  });
  const chatCompanies = createChatCompaniesRepo(db, logger);
  const app = buildConsoleApi({
    token: CONSOLE_TOKEN,
    port: CONSOLE_PORT,
    chats,
    messages,
    handoffs,
    notifications,
    rejectedDrafts,
    company,
    reads: createConsoleReads(db),
    appState: createAppStateRepo(db),
    researchStarts: (sinceMs) => chatCompanies.countResearchStarts(sinceMs),
    whatsapp: () => ({ state: 'open', sinceMs: T0 }),
    facts: FACTS,
    tokenLogPath: 'нет-такого-файла.jsonl',
    outbox,
    handoff,
    recentReplies,
    clock,
    logger,
  });
  return { app, panel, sent, db, clock: time };
}

const HEADERS = { host: CONSOLE_HOST, 'x-console-token': CONSOLE_TOKEN };

function get(stack: Stack, url: string) {
  return stack.app.inject({ url, headers: HEADERS });
}

function post(stack: Stack, url: string, body: unknown) {
  return stack.app.inject({
    method: 'POST',
    url,
    headers: { ...HEADERS, 'x-console-user': 'owner', 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

function chatRow(stack: Stack): unknown {
  return stack.db
    .prepare('SELECT status, status_by AS statusBy, bot_note AS note FROM chats WHERE id = 1')
    .get();
}

describe('API консоли на настоящей базе', () => {
  it('чат у бота ждёт ответа дольше 5 минут: виден в «Требует внимания» и в списке с фильтром', async () => {
    const stack = build({ allowlist: null });

    const attention = jsonOf(await get(stack, '/internal/console/attention'));
    const waiting = jsonOf(await get(stack, '/internal/console/chats?waiting=1'));
    const others = jsonOf(await get(stack, '/internal/console/chats?status=manager'));

    expect(attention['waiting']).toEqual([
      expect.objectContaining({ chatId: 1, name: 'Алия', phone: '77000000001', group: 'bot' }),
    ]);
    expect(waiting).toMatchObject({
      total: 1,
      items: [{ id: 1, waitingSince: new Date(T0 - 600_000).toISOString() }],
    });
    expect(others).toMatchObject({ total: 0, items: [] });
  });

  it('ответ из консоли: чат у менеджера (панель), сообщение ушло и записано, карточка это показывает', async () => {
    const stack = build({ allowlist: null });

    const response = await post(stack, '/internal/console/chats/1/reply', {
      text: '  Добрый день  ',
    });

    expect(jsonOf(response)).toEqual({ result: 'sent' });
    expect(stack.sent).toEqual([{ jid: PN_A, text: 'Добрый день' }]);
    expect(chatRow(stack)).toEqual({ status: 'manager', statusBy: 'panel', note: null });
    const card = jsonOf(await get(stack, '/internal/console/chats/1'));
    expect(card['chat']).toMatchObject({
      status: 'manager',
      statusBy: 'panel',
      statusLabel: 'Ведёт менеджер (ответил из панели)',
      handedOff: true,
    });
    expect(card['openHandoff']).toMatchObject({ reason: 'human_took_over' });
    expect((card['messages'] as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ author: 'client', text: 'Здравствуйте, нужен учёт' }),
      expect.objectContaining({
        author: 'human_panel',
        authorLabel: 'Менеджер из панели',
        text: 'Добрый день',
      }),
    ]);
    const list = jsonOf(await get(stack, '/internal/console/chats'));
    expect((list['items'] as Record<string, unknown>[])[0]).toMatchObject({
      waitingSince: null,
      status: 'manager',
    });
  });

  it('тот же ответ из старой панели сразу после консоли: дубль, второго сообщения нет', async () => {
    const stack = build({ allowlist: null });
    await post(stack, '/internal/console/chats/1/reply', { text: 'Добрый день' });
    const form = 'application/x-www-form-urlencoded';
    const login = await stack.panel.inject({
      method: 'POST',
      url: '/login',
      headers: { host: HOST_HEADER, origin: ORIGIN, 'content-type': form },
      payload: 'password=admin',
    });
    const cookie = sessionCookieOf(login) ?? '';
    const csrf = csrfOf(
      (await stack.panel.inject({ url: '/chats', headers: { host: HOST_HEADER, cookie } })).body,
    );

    const html = await stack.panel.inject({
      method: 'POST',
      url: '/chats/1/reply',
      headers: { host: HOST_HEADER, origin: ORIGIN, cookie, 'content-type': form },
      payload: new URLSearchParams({ csrf, text: 'Добрый день' }).toString(),
    });

    expect(html.headers['location']).toBe('/chats/1?notice=duplicate');
    expect(stack.sent).toHaveLength(1);
  });

  it('закрытый режим, чат не из списка: 422, статус не менялся, ничего не ушло', async () => {
    const stack = build({ allowlist: new Set(['77000000002' as PhoneDigits]) });

    const response = await post(stack, '/internal/console/chats/1/reply', { text: 'Добрый день' });

    expect(response.statusCode).toBe(422);
    expect(stack.sent).toEqual([]);
    expect(chatRow(stack)).toEqual({ status: 'bot', statusBy: null, note: null });
  });

  it('возврат боту с заметкой: статус бот (панель), заметка записана, передача закрыта, история в карточке', async () => {
    const stack = build({ allowlist: null });
    await post(stack, '/internal/console/chats/1/reply', { text: 'Добрый день' });
    stack.clock.now += 60_000;

    const returned = await post(stack, '/internal/console/chats/1/return', {
      note: 'Ответ клиенту: ориентир от X\n\nЗадание боту: узнай 1С',
    });
    const again = await post(stack, '/internal/console/chats/1/return', { note: 'Ещё' });

    expect(jsonOf(returned)).toEqual({ result: 'returned', resumed: 0 });
    expect(jsonOf(again)).toMatchObject({ result: 'already_bot' });
    expect(chatRow(stack)).toEqual({
      status: 'bot',
      statusBy: 'panel',
      note: 'Ответ клиенту: ориентир от X\n\nЗадание боту: узнай 1С',
    });
    const card = jsonOf(await get(stack, '/internal/console/chats/1'));
    expect(card['openHandoff']).toBeNull();
    expect(card['note']).toEqual({
      text: 'Ответ клиенту: ориентир от X\n\nЗадание боту: узнай 1С',
      at: new Date(T0 + 60_000).toISOString(),
    });
    expect(card['handoffs']).toEqual([
      expect.objectContaining({
        reason: 'human_took_over',
        resolvedAt: new Date(T0 + 60_000).toISOString(),
      }),
    ]);
  });

  it('состояние на настоящей базе: счётчики с нуля, отметок нет', async () => {
    const stack = build({ allowlist: null });

    const status = jsonOf(await get(stack, '/internal/console/status'));

    expect(status).toMatchObject({
      apiCalls: { today: 0, dailyLimit: 500, perChatLimit: 100 },
      research24h: { count: 0, limit: 10 },
      pairingAttempts24h: 0,
      linkedAt: null,
      workingSince: null,
      historyIncomplete: false,
    });
  });
});
