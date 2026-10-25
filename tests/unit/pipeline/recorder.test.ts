import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createUnitOfWork } from '../../../src/db/connection.js';
import { createBacklogRepo } from '../../../src/db/repos/backlog.js';
import { createChatsRepo } from '../../../src/db/repos/chats.js';
import { createKnownChatsRepo } from '../../../src/db/repos/known-chats.js';
import { createMessagesRepo } from '../../../src/db/repos/messages.js';
import type { Clock, KnownChatsRepo, Logger } from '../../../src/domain/ports.js';
import type {
  ChatId,
  ChatIdentity,
  InboundMessage,
  Jid,
  MediaRef,
  MessageContent,
  OwnMessage,
  WaMessageId,
} from '../../../src/domain/types.js';
import { createInboundRecorder, type InboundRecorder } from '../../../src/pipeline/recorder.js';
import type { HistoryChat } from '../../../src/whatsapp/connection.js';
import type { WaEvent } from '../../../src/whatsapp/inbound.js';
import { useMigratedDb } from '../db/fixture.js';

// Настоящие репозитории на SQLite в памяти. Номера и адреса вымышленные: 7700000000N и @lid без людей.

const NOW = Date.UTC(2026, 9, 25, 9, 0, 0);
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const CLIENT_PHONE = '77000000002';
const CLIENT_LID_USER = '100000000000002';
const CLIENT_PN = `${CLIENT_PHONE}@s.whatsapp.net` as Jid;
const CLIENT_LID = `${CLIENT_LID_USER}@lid` as Jid;
const STRANGER_PHONE = '77000000005';
const STRANGER_PN = `${STRANGER_PHONE}@s.whatsapp.net` as Jid;
const STRANGER_LID = '100000000000005@lid' as Jid;
const CLIENT_TEXT = 'Здравствуйте, сколько стоит учёт склада?';
const CLIENT_NAME = 'Анна Клиентова';
const OWN_TEXT = 'Добрый день, это менеджер Tanbala';
const PN_ONLY: ChatIdentity = { replyJid: CLIENT_PN, lidJid: null, pnJid: CLIENT_PN };
const LID_WITH_PN: ChatIdentity = { replyJid: CLIENT_LID, lidJid: CLIENT_LID, pnJid: CLIENT_PN };
const VOICE: MessageContent = {
  kind: 'voice',
  media: 'WA-VOICE' as MediaRef,
  mimeType: 'audio/ogg; codecs=opus',
  seconds: 4,
};

interface LogEntry {
  readonly level: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly message: string | undefined;
}

/** Логгер, который запоминает сырые аргументы: так видно, что в лог ушло до любой маскировки. */
function createFakeLogger(entries: LogEntry[]): Logger {
  const log =
    (level: string) =>
    (context: Readonly<Record<string, unknown>>, message?: string): void => {
      entries.push({ level, context, message });
    };
  const logger: Logger = {
    level: 'debug',
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    fatal: log('fatal'),
    silent: log('silent'),
    child: () => logger,
  };
  return logger;
}

const clock: Clock = { now: () => NOW, sleep: () => Promise.resolve() };

interface Setup {
  readonly db: Database.Database;
  readonly recorder: InboundRecorder;
  readonly entries: LogEntry[];
}

/** Регистратор на свежей базе; knownChats можно подменить, чтобы проверить откат транзакции. */
function setup(knownChatsOf?: (db: Database.Database) => KnownChatsRepo): Setup {
  const db = useMigratedDb();
  const entries: LogEntry[] = [];
  const recorder = createInboundRecorder({
    chats: createChatsRepo(db),
    messages: createMessagesRepo(db),
    backlog: createBacklogRepo(db),
    knownChats: knownChatsOf === undefined ? createKnownChatsRepo(db) : knownChatsOf(db),
    unitOfWork: createUnitOfWork(db),
    logger: createFakeLogger(entries),
    clock,
  });
  return { db, recorder, entries };
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    waId: 'WA-1' as WaMessageId,
    identity: PN_ONLY,
    pushName: CLIENT_NAME,
    content: { kind: 'text', text: CLIENT_TEXT },
    tsMs: NOW - MINUTE_MS,
    ...overrides,
  };
}

function own(overrides: Partial<OwnMessage> = {}): OwnMessage {
  return {
    waId: 'OWN-1' as WaMessageId,
    chatJid: CLIENT_PN,
    content: { kind: 'text', text: OWN_TEXT },
    tsMs: NOW - MINUTE_MS,
    ...overrides,
  };
}

function client(overrides: Partial<InboundMessage> = {}): WaEvent {
  return { type: 'client', message: inbound(overrides) };
}

function stale(overrides: Partial<InboundMessage> = {}): WaEvent {
  return { type: 'stale', message: inbound({ tsMs: NOW - DAY_MS, ...overrides }) };
}

function chatsOf(db: Database.Database): unknown[] {
  return db
    .prepare(
      `SELECT id, reply_jid AS replyJid, lid_jid AS lidJid, pn_jid AS pnJid, push_name AS pushName, status
       FROM chats ORDER BY id`,
    )
    .all();
}

function messagesOf(db: Database.Database): unknown[] {
  return db
    .prepare(
      `SELECT chat_id AS chatId, wa_id AS waId, author, kind, text, ts_ms AS tsMs
       FROM messages ORDER BY id`,
    )
    .all();
}

function knownOf(db: Database.Database): unknown[] {
  return db
    .prepare('SELECT jid, last_activity_ms AS atMs, source FROM known_chats ORDER BY jid')
    .all();
}

function backlogOf(db: Database.Database): unknown[] {
  return db
    .prepare(
      `SELECT chat_id AS chatId, marked_at_ms AS markedAtMs, notified_at_ms AS notifiedAtMs
       FROM backlog_chats ORDER BY chat_id`,
    )
    .all();
}

describe('pipeline/recorder: сообщение клиента (client)', () => {
  it('создаёт чат, сохраняет текст клиента и запоминает чат в known_chats', async () => {
    const { db, recorder, entries } = setup();

    await recorder.onEvent(client());

    expect(chatsOf(db)).toEqual([
      {
        id: 1,
        replyJid: CLIENT_PN,
        lidJid: null,
        pnJid: CLIENT_PN,
        pushName: CLIENT_NAME,
        status: 'bot',
      },
    ]);
    expect(messagesOf(db)).toEqual([
      {
        chatId: 1,
        waId: 'WA-1',
        author: 'client',
        kind: 'text',
        text: CLIENT_TEXT,
        tsMs: NOW - MINUTE_MS,
      },
    ]);
    expect(knownOf(db)).toEqual([{ jid: CLIENT_PN, atMs: NOW - MINUTE_MS, source: 'message' }]);
    expect(backlogOf(db)).toEqual([]);
    expect(entries).toEqual([
      {
        level: 'info',
        context: { chatId: 1, kind: 'text' },
        message: 'Сохранено входящее: чат #1, вид text',
      },
    ]);
  });

  it.each<[string, MessageContent]>([
    ['voice', VOICE],
    ['other', { kind: 'other' }],
  ])('вид %s сохраняется без текста', async (kind, content) => {
    const { db, recorder } = setup();

    await recorder.onEvent(client({ content }));

    expect(messagesOf(db)).toEqual([expect.objectContaining({ kind, text: null })]);
  });

  it('повтор того же waId не дублирует сообщение и пишется в лог только на debug', async () => {
    const { db, recorder, entries } = setup();

    await recorder.onEvent(client());
    await recorder.onEvent(client());

    expect(messagesOf(db)).toHaveLength(1);
    expect(entries.map((entry) => entry.level)).toEqual(['info', 'debug']);
    expect(entries[1]?.message).toBe('Повтор сообщения пропущен: чат #1');
  });

  it('тот же клиент с адреса @lid: тот же чат, в known_chats все его адреса', async () => {
    const { db, recorder } = setup();

    await recorder.onEvent(client({ tsMs: NOW - 2 * MINUTE_MS }));
    await recorder.onEvent(client({ waId: 'WA-2' as WaMessageId, identity: LID_WITH_PN }));

    expect(chatsOf(db)).toEqual([
      expect.objectContaining({
        id: 1,
        replyJid: CLIENT_LID,
        lidJid: CLIENT_LID,
        pnJid: CLIENT_PN,
      }),
    ]);
    expect(messagesOf(db)).toEqual([
      expect.objectContaining({ chatId: 1, waId: 'WA-1' }),
      expect.objectContaining({ chatId: 1, waId: 'WA-2' }),
    ]);
    expect(knownOf(db)).toEqual([
      { jid: CLIENT_LID, atMs: NOW - MINUTE_MS, source: 'message' },
      { jid: CLIENT_PN, atMs: NOW - MINUTE_MS, source: 'message' },
    ]);
  });

  it('сбой записи откатывает всю транзакцию и приходит отказом промиса', async () => {
    const { db, recorder, entries } = setup((database) => ({
      ...createKnownChatsRepo(database),
      touch: (): void => {
        throw new Error('диск переполнен');
      },
    }));

    await expect(recorder.onEvent(client())).rejects.toThrow('диск переполнен');

    expect(chatsOf(db)).toEqual([]);
    expect(messagesOf(db)).toEqual([]);
    expect(entries).toEqual([]);
  });
});

describe('pipeline/recorder: старое сообщение за время простоя (stale)', () => {
  it('сохраняет сообщение клиента и отмечает чат простоя временем сообщения', async () => {
    const { db, recorder, entries } = setup();

    await recorder.onEvent(stale());

    expect(messagesOf(db)).toEqual([
      expect.objectContaining({ chatId: 1, author: 'client', kind: 'text', tsMs: NOW - DAY_MS }),
    ]);
    expect(backlogOf(db)).toEqual([{ chatId: 1, markedAtMs: NOW - DAY_MS, notifiedAtMs: null }]);
    expect(knownOf(db)).toEqual([{ jid: CLIENT_PN, atMs: NOW - DAY_MS, source: 'message' }]);
    expect(entries).toEqual([
      {
        level: 'info',
        context: { chatId: 1, kind: 'text' },
        message: 'Сохранено старое входящее (простой): чат #1 отмечен для менеджера, вид text',
      },
    ]);
  });

  it('повторная доставка уже сохранённого сообщения чат не отмечает', async () => {
    const { db, recorder } = setup();

    await recorder.onEvent(client({ tsMs: NOW - DAY_MS }));
    await recorder.onEvent(stale());

    expect(messagesOf(db)).toHaveLength(1);
    expect(backlogOf(db)).toEqual([]);
  });

  it('уже отправленное менеджеру уведомление повтор не сбрасывает', async () => {
    const { db, recorder } = setup();
    await recorder.onEvent(stale());
    createBacklogRepo(db).markNotified([1 as ChatId], NOW);

    await recorder.onEvent(stale());

    expect(backlogOf(db)).toEqual([{ chatId: 1, markedAtMs: NOW - DAY_MS, notifiedAtMs: NOW }]);
  });
});

describe('pipeline/recorder: своё сообщение с номера бота (own)', () => {
  it.each<[string, Jid, Jid | null, Jid | null]>([
    ['с номером', CLIENT_PN, null, CLIENT_PN],
    ['@lid', CLIENT_LID, CLIENT_LID, null],
  ])(
    'чата нет: создаётся по адресу %s, сообщение человека с телефона',
    async (_label, jid, lidJid, pnJid) => {
      const { db, recorder, entries } = setup();

      await recorder.onEvent({ type: 'own', message: own({ chatJid: jid }) });

      expect(chatsOf(db)).toEqual([
        { id: 1, replyJid: jid, lidJid, pnJid, pushName: null, status: 'bot' },
      ]);
      expect(messagesOf(db)).toEqual([
        {
          chatId: 1,
          waId: 'OWN-1',
          author: 'human_phone',
          kind: 'text',
          text: OWN_TEXT,
          tsMs: NOW - MINUTE_MS,
        },
      ]);
      expect(knownOf(db)).toEqual([{ jid, atMs: NOW - MINUTE_MS, source: 'message' }]);
      expect(entries).toEqual([
        {
          level: 'info',
          context: { chatId: 1, kind: 'text' },
          message: 'Сохранено сообщение с телефона: чат #1, вид text',
        },
      ]);
    },
  );

  it('чат уже есть: найден по любому адресу, сообщение в нём, нового чата нет', async () => {
    const { db, recorder } = setup();
    await recorder.onEvent(client({ identity: LID_WITH_PN, tsMs: NOW - 2 * MINUTE_MS }));

    await recorder.onEvent({ type: 'own', message: own({ chatJid: CLIENT_PN, content: VOICE }) });

    expect(chatsOf(db)).toHaveLength(1);
    expect(messagesOf(db)).toEqual([
      expect.objectContaining({ chatId: 1, author: 'client' }),
      expect.objectContaining({ chatId: 1, author: 'human_phone', kind: 'voice', text: null }),
    ]);
    expect(knownOf(db)).toEqual([
      { jid: CLIENT_LID, atMs: NOW - MINUTE_MS, source: 'message' },
      { jid: CLIENT_PN, atMs: NOW - MINUTE_MS, source: 'message' },
    ]);
  });

  it('повтор своего сообщения не дублируется', async () => {
    const { db, recorder } = setup();

    await recorder.onEvent({ type: 'own', message: own() });
    await recorder.onEvent({ type: 'own', message: own() });

    expect(messagesOf(db)).toHaveLength(1);
    expect(chatsOf(db)).toHaveLength(1);
  });
});

describe('pipeline/recorder: пропуски (ignore)', () => {
  it.each(['not_allowlisted', 'before_link'] as const)(
    '%s: только known_chats, без переписки и без логов; растёт счётчик',
    async (reason) => {
      const { db, recorder, entries } = setup();
      expect(recorder.ignoredCount()).toBe(0);

      await recorder.onEvent({
        type: 'ignore',
        reason,
        chatJid: STRANGER_PN,
        tsMs: NOW - MINUTE_MS,
      });
      await recorder.onEvent({ type: 'ignore', reason, chatJid: STRANGER_LID, tsMs: NOW });

      expect(knownOf(db)).toEqual([
        { jid: STRANGER_LID, atMs: NOW, source: 'message' },
        { jid: STRANGER_PN, atMs: NOW - MINUTE_MS, source: 'message' },
      ]);
      expect(chatsOf(db)).toEqual([]);
      expect(messagesOf(db)).toEqual([]);
      expect(entries).toEqual([]);
      expect(recorder.ignoredCount()).toBe(2);
    },
  );

  it.each(['service', 'protocol', 'self', 'manager'] as const)(
    '%s: ничего не пишется и не считается',
    async (reason) => {
      const { db, recorder, entries } = setup();

      await recorder.onEvent({ type: 'ignore', reason });

      expect(knownOf(db)).toEqual([]);
      expect(chatsOf(db)).toEqual([]);
      expect(entries).toEqual([]);
      expect(recorder.ignoredCount()).toBe(0);
    },
  );
});

describe('pipeline/recorder: чаты первой синхронизации (onHistoryChats)', () => {
  it('пишет чаты в known_chats с источником history; без времени: момент синхронизации', () => {
    const { db, recorder, entries } = setup();
    const chats: HistoryChat[] = [
      { jid: CLIENT_PN, lastMessageAtMs: NOW - DAY_MS },
      { jid: STRANGER_LID, lastMessageAtMs: null },
    ];

    recorder.onHistoryChats(chats);

    expect(knownOf(db)).toEqual([
      { jid: STRANGER_LID, atMs: NOW, source: 'history' },
      { jid: CLIENT_PN, atMs: NOW - DAY_MS, source: 'history' },
    ]);
    expect(chatsOf(db)).toEqual([]);
    expect(entries).toEqual([
      {
        level: 'info',
        context: { count: 2 },
        message: 'Первая синхронизация: чатов записано в known_chats: 2',
      },
    ]);
  });

  it('более поздняя активность из сообщения не затирается историей', async () => {
    const { db, recorder } = setup();
    await recorder.onEvent(client());

    recorder.onHistoryChats([{ jid: CLIENT_PN, lastMessageAtMs: NOW - DAY_MS }]);

    expect(knownOf(db)).toEqual([{ jid: CLIENT_PN, atMs: NOW - MINUTE_MS, source: 'message' }]);
  });

  it('сбой на любом чате откатывает всю пачку', () => {
    let calls = 0;
    const { db, recorder, entries } = setup((database) => {
      const real = createKnownChatsRepo(database);
      return {
        ...real,
        touch: (jid, atMs, source): void => {
          calls += 1;
          if (calls === 2) throw new Error('диск переполнен');
          real.touch(jid, atMs, source);
        },
      };
    });

    expect(() => {
      recorder.onHistoryChats([
        { jid: CLIENT_PN, lastMessageAtMs: NOW - DAY_MS },
        { jid: STRANGER_PN, lastMessageAtMs: NOW - DAY_MS },
      ]);
    }).toThrow('диск переполнен');

    expect(knownOf(db)).toEqual([]);
    expect(entries).toEqual([]);
  });

  it('пустая пачка: ничего не пишется', () => {
    const { db, recorder, entries } = setup();

    recorder.onHistoryChats([]);

    expect(knownOf(db)).toEqual([]);
    expect(entries).toEqual([]);
  });
});

describe('pipeline/recorder: логи', () => {
  it('без текста сообщений, имён, номеров и адресов', async () => {
    const { recorder, entries } = setup();

    await recorder.onEvent(client({ identity: LID_WITH_PN }));
    await recorder.onEvent(stale({ waId: 'WA-2' as WaMessageId }));
    await recorder.onEvent({ type: 'own', message: own() });
    await recorder.onEvent({
      type: 'ignore',
      reason: 'not_allowlisted',
      chatJid: STRANGER_PN,
      tsMs: NOW,
    });
    recorder.onHistoryChats([{ jid: STRANGER_LID, lastMessageAtMs: NOW }]);

    const logged = JSON.stringify(entries);
    expect(entries.length).toBeGreaterThan(0);
    for (const secret of [
      CLIENT_TEXT,
      CLIENT_NAME,
      OWN_TEXT,
      CLIENT_PHONE,
      CLIENT_LID_USER,
      STRANGER_PHONE,
      '100000000000005',
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});
