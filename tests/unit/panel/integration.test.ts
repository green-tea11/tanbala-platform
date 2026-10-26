import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createUnitOfWork } from '../../../src/db/connection.js';
import { createChatsRepo } from '../../../src/db/repos/chats.js';
import { createHandoffsRepo } from '../../../src/db/repos/handoffs.js';
import { createManagerNotificationsRepo } from '../../../src/db/repos/manager-notifications.js';
import { createMessagesRepo } from '../../../src/db/repos/messages.js';
import { createOutboundIdsRepo } from '../../../src/db/repos/outbound-ids.js';
import type { Clock, MessageSender } from '../../../src/domain/ports.js';
import type { Chat, Jid, PhoneDigits, WaMessageId } from '../../../src/domain/types.js';
import { createHandoffService } from '../../../src/handoff/handoff.js';
import { createOutbox } from '../../../src/messaging/outbox.js';
import { buildPanel } from '../../../src/panel/server.js';
import { createLogger } from '../../../src/shared/logger.js';
import { PN_A, PN_B, useMigratedDb } from '../db/fixture.js';
import { csrfOf, HOST_HEADER, ORIGIN, PORT, sessionCookieOf, T0 } from './harness.js';

// Панель на настоящих репозиториях, службе передачи и исходящих (SQLite в памяти); WhatsApp заменён отправителем-записью.
const PHONE_A = '77000000001' as PhoneDigits;

interface SentMessage {
  readonly jid: Jid;
  readonly text: string;
  readonly waId: WaMessageId;
}

interface Stack {
  readonly app: FastifyInstance;
  readonly sent: SentMessage[];
  readonly chats: ReturnType<typeof createChatsRepo>;
  readonly messages: ReturnType<typeof createMessagesRepo>;
  readonly handoffs: ReturnType<typeof createHandoffsRepo>;
  readonly notifications: ReturnType<typeof createManagerNotificationsRepo>;
  readonly chat: Chat;
}

function build(options: { readonly allowlist: ReadonlySet<PhoneDigits> | null }): Stack {
  const db = useMigratedDb();
  const chats = createChatsRepo(db);
  const messages = createMessagesRepo(db);
  const handoffs = createHandoffsRepo(db);
  const notifications = createManagerNotificationsRepo(db);
  const sent: SentMessage[] = [];
  let nextId = 0;
  const sender: MessageSender = {
    newMessageId: () => {
      nextId += 1;
      return `PANEL-${String(nextId)}` as WaMessageId;
    },
    sendText: (jid, text, waId) => {
      sent.push({ jid, text, waId });
      return Promise.resolve();
    },
    setTyping: () => Promise.resolve(),
  };
  const clock: Clock = { now: () => T0, sleep: () => Promise.resolve() };
  const logger = createLogger({ level: 'silent' });
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
    clock,
    logger,
  });
  const chat = chats.upsertByIdentity(
    { replyJid: PN_A, lidJid: null, pnJid: PN_A },
    'Алия <Клиент>',
    T0 - 60_000,
  );
  messages.insertIfNew({
    chatId: chat.id,
    waId: 'IN-1' as WaMessageId,
    author: 'client',
    kind: 'text',
    text: 'Здравствуйте, нужен учёт',
    tsMs: T0 - 30_000,
  });
  const app = buildPanel({
    chats,
    messages,
    handoffs,
    notifications,
    outbox,
    handoff,
    clock,
    logger,
    password: 'admin',
    port: PORT,
  });
  return { app, sent, chats, messages, handoffs, notifications, chat };
}

async function openPanel(app: FastifyInstance): Promise<{ cookie: string; csrf: string }> {
  const login = await app.inject({
    method: 'POST',
    url: '/login',
    headers: {
      host: HOST_HEADER,
      origin: ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: 'password=admin',
  });
  const cookie = sessionCookieOf(login) ?? '';
  const page = await app.inject({ url: '/chats', headers: { host: HOST_HEADER, cookie } });
  return { cookie, csrf: csrfOf(page.body) };
}

function post(app: FastifyInstance, url: string, auth: { cookie: string }, payload: string) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      host: HOST_HEADER,
      origin: ORIGIN,
      cookie: auth.cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload,
  });
}

describe('панель на настоящих репозиториях', () => {
  it('список чатов и страница чата читают базу: имя экранируется, переписка и время на месте', async () => {
    const { app, chat } = build({ allowlist: new Set([PHONE_A]) });
    const auth = await openPanel(app);

    const list = await app.inject({
      url: '/chats',
      headers: { host: HOST_HEADER, cookie: auth.cookie },
    });
    const page = await app.inject({
      url: `/chats/${String(chat.id)}`,
      headers: { host: HOST_HEADER, cookie: auth.cookie },
    });

    expect(list.statusCode).toBe(200);
    expect(list.body).toContain('Алия &lt;Клиент&gt;');
    expect(list.body).toContain('+77000000001');
    expect(list.body).toContain('26.10.2026 14:59');
    expect(page.body).toContain('Здравствуйте, нужен учёт');
    expect(page.body).not.toContain('<Клиент>');
  });

  it('ответ из панели: чат у менеджера, сообщение ушло клиенту и записано в историю, страница это показывает', async () => {
    const { app, sent, chats, messages, handoffs, chat } = build({
      allowlist: new Set([PHONE_A]),
    });
    const auth = await openPanel(app);

    const response = await post(
      app,
      `/chats/${String(chat.id)}/reply`,
      auth,
      new URLSearchParams({ csrf: auth.csrf, text: 'Добрый день, это менеджер' }).toString(),
    );

    expect(response.statusCode).toBe(303);
    expect(response.headers['location']).toBe(`/chats/${String(chat.id)}?notice=sent`);
    expect(sent).toEqual([{ jid: PN_A, text: 'Добрый день, это менеджер', waId: 'PANEL-1' }]);
    expect(chats.getById(chat.id)?.control).toEqual({ status: 'manager', by: 'panel' });
    expect(handoffs.findOpen(chat.id)).toMatchObject({ reason: 'human_took_over' });
    expect(messages.history(chat.id, { limit: 10 }).map((message) => message.author)).toEqual([
      'client',
      'human_panel',
    ]);
    const page = await app.inject({
      url: `/chats/${String(chat.id)}?notice=sent`,
      headers: { host: HOST_HEADER, cookie: auth.cookie },
    });
    expect(page.body).toContain('Менеджер из панели');
    expect(page.body).toContain('Ведёт менеджер (ответил из панели)');
    expect(page.body).toContain('подключился человек');
  });

  it('возврат боту: открытая передача закрыта, статус bot, страница больше не показывает кнопку', async () => {
    const { app, chats, handoffs, chat } = build({ allowlist: new Set([PHONE_A]) });
    const auth = await openPanel(app);
    await post(
      app,
      `/chats/${String(chat.id)}/reply`,
      auth,
      new URLSearchParams({ csrf: auth.csrf, text: 'Подключился менеджер' }).toString(),
    );

    const response = await post(
      app,
      `/chats/${String(chat.id)}/return`,
      auth,
      new URLSearchParams({ csrf: auth.csrf }).toString(),
    );

    expect(response.statusCode).toBe(303);
    expect(response.headers['location']).toBe(`/chats/${String(chat.id)}?notice=returned`);
    expect(chats.getById(chat.id)?.control).toEqual({ status: 'bot', by: 'panel' });
    expect(handoffs.findOpen(chat.id)).toBeNull();
    const page = await app.inject({
      url: `/chats/${String(chat.id)}`,
      headers: { host: HOST_HEADER, cookie: auth.cookie },
    });
    expect(page.body).not.toContain('action="/chats/' + String(chat.id) + '/return"');
  });

  it('закрытый режим действует и в панели: чат не из TEST_ALLOWLIST ответа не получает, об этом написано на странице', async () => {
    const { app, sent, messages, chats } = build({ allowlist: new Set([PHONE_A]) });
    const stranger = chats.upsertByIdentity(
      { replyJid: PN_B, lidJid: null, pnJid: PN_B },
      null,
      T0,
    );
    const auth = await openPanel(app);

    const response = await post(
      app,
      `/chats/${String(stranger.id)}/reply`,
      auth,
      new URLSearchParams({ csrf: auth.csrf, text: 'Привет' }).toString(),
    );

    expect(response.statusCode).toBe(422);
    expect(response.body).toContain('Закрытый режим');
    expect(sent).toEqual([]);
    expect(messages.history(stranger.id, { limit: 10 })).toEqual([]);
  });

  it('уведомления менеджеру читаются из базы со статусами по-русски', async () => {
    const { app, notifications, chat } = build({ allowlist: null });
    const id = notifications.add({
      kind: 'handoff',
      chatId: chat.id,
      text: 'Передан <клиент>',
      nowMs: T0,
    });
    notifications.setResult(id, { status: 'no_manager', waId: null }, T0);
    const auth = await openPanel(app);

    const list = await app.inject({
      url: '/notifications',
      headers: { host: HOST_HEADER, cookie: auth.cookie },
    });
    const page = await app.inject({
      url: `/chats/${String(chat.id)}`,
      headers: { host: HOST_HEADER, cookie: auth.cookie },
    });

    expect(list.body).toContain('номер менеджера не задан, только в панели');
    expect(list.body).toContain('Передан &lt;клиент&gt;');
    expect(page.body).toContain('передача чата, номер менеджера не задан, только в панели');
  });
});
