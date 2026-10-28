import { proto, type BaileysEventMap, type Chat, type WAMessage } from 'baileys';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { createUnitOfWork, openDatabase } from '../../../src/db/connection.js';
import { runMigrations } from '../../../src/db/migrations.js';
import { createKnownChatsRepo } from '../../../src/db/repos/known-chats.js';
import type { Clock, KnownChatSource } from '../../../src/domain/ports.js';
import type { Jid } from '../../../src/domain/types.js';
import {
  createProbeChats,
  type ProbeChats,
  type ProbeChatStore,
} from '../../../src/whatsapp/probe-chats.js';
import { createFakeLogger, type LogEntry } from '../../helpers/fake-logger.js';

// Чаты пробы в known_chats: разбор как у бота, только JID и время. Номера и LID фиктивные, база в памяти или подделка.

const NOW_MS = Date.UTC(2026, 9, 28, 9, 0, 0);
const SECONDS = 1_790_000_000;
const AT_MS = SECONDS * 1000;
const CLIENT_PN = '77000000001@s.whatsapp.net' as Jid;
const CLIENT_LID = '100000000000001@lid' as Jid;
const OTHER_PN = '77000000002@s.whatsapp.net' as Jid;
const OTHER_LID = '100000000000002@lid' as Jid;
const SELF_ID = '77000000009:12@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const PRIVATE = /77000000|10000000000000|@s\.whatsapp|@lid|Здравствуйте/;

interface Touch {
  readonly jid: Jid;
  readonly atMs: number;
  readonly source: KnownChatSource;
}

interface FakeStore {
  readonly store: ProbeChatStore;
  /** Записанные пачки: каждая транзакция отдельным массивом. */
  readonly batches: Touch[][];
  readonly run: Mock<(work: () => unknown) => unknown>;
}

function createFakeStore(): FakeStore {
  const batches: Touch[][] = [];
  let current: Touch[] | null = null;
  const run = vi.fn((work: () => unknown): unknown => {
    const batch: Touch[] = [];
    current = batch;
    try {
      const result = work();
      batches.push(batch);
      return result;
    } finally {
      current = null;
    }
  });
  const store: ProbeChatStore = {
    knownChats: {
      touch: (jid, atMs, source) => {
        if (current === null) throw new Error('touch вне транзакции');
        current.push({ jid, atMs, source });
      },
      count: () => batches.flat().length,
    },
    unitOfWork: { run: <T>(work: () => T): T => run(work) as T },
    close: () => undefined,
  };
  return { store, batches, run };
}

function waMessage(
  key: Readonly<Record<string, unknown>> = {},
  overrides: Readonly<Record<string, unknown>> = {},
): WAMessage {
  const synthetic: unknown = {
    key: { remoteJid: CLIENT_PN, fromMe: false, id: '3EB0A1B2C3D4E5F60718', ...key },
    message: { conversation: 'Здравствуйте' },
    messageTimestamp: SECONDS,
    pushName: 'Айгерим',
    ...overrides,
  };
  return synthetic as WAMessage;
}

function upsert(
  messages: readonly WAMessage[],
  type: 'notify' | 'append' = 'append',
): Partial<BaileysEventMap> {
  return { 'messages.upsert': { messages: [...messages], type } };
}

function history(chats: readonly Partial<Chat>[]): Partial<BaileysEventMap> {
  return {
    'messaging-history.set': {
      chats: chats as Chat[],
      contacts: [],
      messages: [],
      syncType: proto.HistorySync.HistorySyncType.RECENT,
    },
  };
}

interface Harness {
  readonly chats: ProbeChats;
  readonly fake: FakeStore;
  readonly logs: LogEntry[];
  readonly getPNForLID: Mock<(lid: string) => Promise<string | null>>;
}

function setup(options: { readonly store?: ProbeChatStore } = {}): Harness {
  const fake = createFakeStore();
  const logs: LogEntry[] = [];
  const getPNForLID = vi.fn((_lid: string): Promise<string | null> => Promise.resolve(null));
  const clock: Clock = { now: () => NOW_MS, sleep: () => Promise.resolve() };
  const chats = createProbeChats({
    store: options.store ?? fake.store,
    sock: {
      user: { id: SELF_ID },
      signalRepository: {
        lidMapping: { getPNForLID, getLIDForPN: () => Promise.resolve(null) },
      },
    },
    logger: createFakeLogger(logs),
    clock,
  });
  return { chats, fake, logs, getPNForLID };
}

async function receive(h: Harness, events: Partial<BaileysEventMap>): Promise<void> {
  h.chats.receive(events);
  await h.chats.idle();
}

describe('whatsapp/probe-chats: сообщения (messages.upsert)', () => {
  it('сообщение клиента с номером: чат в known_chats временем сообщения, источник message', async () => {
    const h = setup();

    await receive(h, upsert([waMessage()]));

    expect(h.fake.batches).toEqual([[{ jid: CLIENT_PN, atMs: AT_MS, source: 'message' }]]);
    expect(h.chats.summary()).toEqual({ messages: 1, complete: true });
  });

  it('чат @lid с номером в remoteJidAlt: оба адреса, как у бота', async () => {
    const h = setup();

    await receive(h, upsert([waMessage({ remoteJid: CLIENT_LID, remoteJidAlt: CLIENT_PN })]));

    expect(h.fake.batches).toEqual([
      [
        { jid: CLIENT_LID, atMs: AT_MS, source: 'message' },
        { jid: CLIENT_PN, atMs: AT_MS, source: 'message' },
      ],
    ]);
  });

  it('чат @lid без номера в ключе: номер из сопоставления getPNForLID', async () => {
    const h = setup();
    h.getPNForLID.mockResolvedValueOnce(`${CLIENT_PN.replace('@', ':3@')}`);

    await receive(h, upsert([waMessage({ remoteJid: CLIENT_LID })]));

    expect(h.getPNForLID).toHaveBeenCalledWith(CLIENT_LID);
    expect(h.fake.batches.flat().map((touch) => touch.jid)).toEqual([CLIENT_LID, CLIENT_PN]);
  });

  it('сопоставление упало: чат @lid всё равно записан своим адресом, итог полный', async () => {
    const h = setup();
    h.getPNForLID.mockRejectedValueOnce(new RangeError(`нет ключей ${CLIENT_LID}`));

    await receive(h, upsert([waMessage({ remoteJid: CLIENT_LID })]));

    expect(h.fake.batches.flat().map((touch) => touch.jid)).toEqual([CLIENT_LID]);
    expect(h.chats.summary()).toEqual({ messages: 1, complete: true });
  });

  it('адрес с суффиксом устройства сводится к адресу чата (normalizeJid)', async () => {
    const h = setup();

    await receive(h, upsert([waMessage({ remoteJid: '77000000001:7@s.whatsapp.net' })]));

    expect(h.fake.batches.flat().map((touch) => touch.jid)).toEqual([CLIENT_PN]);
  });

  it('своё сообщение (с телефона): адрес чата, без remoteJidAlt', async () => {
    const h = setup();

    await receive(
      h,
      upsert([waMessage({ remoteJid: OTHER_LID, remoteJidAlt: SELF_ID, fromMe: true })]),
    );

    expect(h.fake.batches).toEqual([[{ jid: OTHER_LID, atMs: AT_MS, source: 'message' }]]);
    expect(h.chats.summary().messages).toBe(1);
  });

  it('не расшифровалось (CIPHERTEXT): чат записан и сообщение посчитано', async () => {
    const h = setup();
    const stub = {
      message: undefined,
      messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
    };

    await receive(h, upsert([waMessage({ remoteJid: OTHER_PN }, stub)]));

    expect(h.fake.batches).toEqual([[{ jid: OTHER_PN, atMs: AT_MS, source: 'message' }]]);
    expect(h.chats.summary().messages).toBe(1);
  });

  it('из офлайн-очереди без времени: чат записан моментом записи', async () => {
    const h = setup();

    await receive(h, upsert([waMessage({}, { messageTimestamp: undefined })], 'append'));

    expect(h.fake.batches).toEqual([[{ jid: CLIENT_PN, atMs: NOW_MS, source: 'message' }]]);
  });

  it('старое сообщение (простой бота, до привязки): чат всё равно записан', async () => {
    const h = setup();

    await receive(h, upsert([waMessage({}, { messageTimestamp: 1_000_000 })]));

    expect(h.fake.batches).toEqual([[{ jid: CLIENT_PN, atMs: 1_000_000_000, source: 'message' }]]);
  });

  it('чат с самим собой и любой номер без закрытого режима: лишний чат безопасен', async () => {
    const h = setup();

    await receive(h, upsert([waMessage({ remoteJid: '77000000009@s.whatsapp.net' })]));

    expect(h.fake.batches.flat().map((touch) => touch.jid)).toEqual(['77000000009@s.whatsapp.net']);
  });

  it.each([
    ['группа', waMessage({ remoteJid: GROUP })],
    ['статус', waMessage({ remoteJid: 'status@broadcast' })],
    ['реакция', waMessage({}, { message: { reactionMessage: { text: '+' } } })],
    ['удаление', waMessage({}, { message: { protocolMessage: { type: 0 } } })],
    ['без ID', waMessage({ id: undefined })],
  ])('%s: ни чата, ни счёта', async (_case, message) => {
    const h = setup();

    await receive(h, upsert([message]));

    expect(h.fake.batches).toEqual([]);
    expect(h.fake.run).not.toHaveBeenCalled();
    expect(h.chats.summary()).toEqual({ messages: 0, complete: true });
  });

  it('пачка одной транзакцией; повтор чата не схлопывается, его хранит репозиторий', async () => {
    const h = setup();

    await receive(
      h,
      upsert([waMessage(), waMessage({ remoteJid: GROUP }), waMessage({ id: 'B2' })]),
    );

    expect(h.fake.run).toHaveBeenCalledTimes(1);
    expect(h.fake.batches).toHaveLength(1);
    expect(h.fake.batches[0]).toHaveLength(2);
    expect(h.chats.summary().messages).toBe(2);
  });

  it('сообщение без ключа (разбор упал): посчитано, итог неполный, в логе только имя ошибки', async () => {
    const h = setup();
    const broken = { message: { conversation: 'Здравствуйте' } } as unknown as WAMessage;

    await receive(h, upsert([broken, waMessage()]));

    expect(h.chats.summary()).toEqual({ messages: 2, complete: false });
    expect(h.fake.batches).toEqual([[{ jid: CLIENT_PN, atMs: AT_MS, source: 'message' }]]);
    expect(h.logs).toContainEqual({
      level: 'error',
      context: { errorName: 'TypeError' },
      message: 'Проба не разобрала сообщение: его чат мог не попасть в known_chats',
    });
  });
});

describe('whatsapp/probe-chats: синхронизация (messaging-history.set)', () => {
  it('личные чаты временем последнего сообщения, без времени моментом записи; группы нет', async () => {
    const h = setup();

    await receive(
      h,
      history([
        { id: CLIENT_PN, conversationTimestamp: SECONDS },
        { id: CLIENT_LID, lastMessageRecvTimestamp: SECONDS + 5 },
        { id: OTHER_PN },
        { id: GROUP, conversationTimestamp: SECONDS },
      ]),
    );

    expect(h.fake.batches).toEqual([
      [
        { jid: CLIENT_PN, atMs: AT_MS, source: 'history' },
        { jid: CLIENT_LID, atMs: AT_MS + 5000, source: 'history' },
        { jid: OTHER_PN, atMs: NOW_MS, source: 'history' },
      ],
    ]);
    expect(h.chats.summary()).toEqual({ messages: 0, complete: true });
    expect(h.logs).toEqual([
      {
        level: 'info',
        context: { count: 3 },
        message: 'Проба: чатов синхронизации записано в known_chats: 3',
      },
    ]);
  });

  it('ни одного личного чата: без транзакции и без строки в логе', async () => {
    const h = setup();

    await receive(h, history([{ id: GROUP }]));

    expect(h.fake.run).not.toHaveBeenCalled();
    expect(h.logs).toEqual([]);
  });

  it('в одной пачке история раньше сообщений, как у бота', async () => {
    const h = setup();

    await receive(h, { ...upsert([waMessage()]), ...history([{ id: OTHER_PN }]) });

    expect(h.fake.batches.map((batch) => batch[0]?.source)).toEqual(['history', 'message']);
  });
});

describe('whatsapp/probe-chats: очередь, сбои и остановка', () => {
  it('пачки пишутся строго по порядку, даже если первая ждёт сопоставления', async () => {
    const h = setup();
    let answer: (pn: string | null) => void = () => undefined;
    h.getPNForLID.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );

    h.chats.receive(upsert([waMessage({ remoteJid: CLIENT_LID })]));
    h.chats.receive(upsert([waMessage({ remoteJid: OTHER_PN })]));
    const idle = h.chats.idle();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(h.fake.batches).toEqual([]);
    expect(h.chats.summary().complete).toBe(false);
    answer(null);
    await idle;
    expect(h.fake.batches.map((batch) => batch[0]?.jid)).toEqual([CLIENT_LID, OTHER_PN]);
    expect(h.chats.summary()).toEqual({ messages: 2, complete: true });
  });

  it('idle ждёт и пачки, пришедшие во время ожидания', async () => {
    const h = setup();
    let answer: (pn: string | null) => void = () => undefined;
    h.getPNForLID.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    h.chats.receive(upsert([waMessage({ remoteJid: CLIENT_LID })]));
    const idle = h.chats.idle();

    h.chats.receive(upsert([waMessage({ remoteJid: OTHER_PN })]));
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    answer(null);
    await idle;

    expect(h.fake.batches).toHaveLength(2);
  });

  it('запись упала: итог неполный, в логе имя ошибки, следующие пачки пишутся', async () => {
    const h = setup();
    h.fake.run.mockImplementationOnce(() => {
      throw new Error(`SQLITE_BUSY ${CLIENT_PN}`);
    });

    await receive(h, upsert([waMessage()]));
    await receive(h, history([{ id: OTHER_PN }]));

    expect(h.chats.summary()).toEqual({ messages: 1, complete: false });
    expect(h.fake.batches).toEqual([[{ jid: OTHER_PN, atMs: NOW_MS, source: 'history' }]]);
    expect(h.logs).toContainEqual({
      level: 'error',
      context: { errorName: 'Error' },
      message: 'Проба не записала чаты в known_chats',
    });
  });

  it('сбой записи синхронизации тоже делает итог неполным', async () => {
    const h = setup();
    h.fake.run.mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- проверяем бросок не ошибки
      throw 'disk';
    });

    await receive(h, history([{ id: OTHER_PN }]));

    expect(h.chats.summary()).toEqual({ messages: 0, complete: false });
    expect(h.logs[0]?.context).toEqual({ errorName: 'string' });
  });

  it('после stop пачки не принимаются, уже принятые дописываются', async () => {
    const h = setup();

    h.chats.receive(upsert([waMessage()]));
    h.chats.stop();
    h.chats.receive(upsert([waMessage({ remoteJid: OTHER_PN })]));
    h.chats.receive(history([{ id: OTHER_LID }]));
    await h.chats.idle();

    expect(h.fake.batches).toEqual([[{ jid: CLIENT_PN, atMs: AT_MS, source: 'message' }]]);
    expect(h.chats.summary()).toEqual({ messages: 1, complete: true });
  });

  it('пачки без истории и сообщений ничего не делают', async () => {
    const h = setup();

    await receive(h, { 'connection.update': { connection: 'open' }, 'creds.update': {} });

    expect(h.fake.run).not.toHaveBeenCalled();
    expect(h.chats.summary()).toEqual({ messages: 0, complete: true });
  });

  it('ни в логе, ни в итоге нет номеров, JID и текста', async () => {
    const h = setup();
    h.fake.run.mockImplementationOnce(() => {
      throw new Error(`fail ${CLIENT_PN}`);
    });

    await receive(h, upsert([waMessage({ remoteJid: CLIENT_LID, remoteJidAlt: CLIENT_PN })]));
    await receive(h, history([{ id: OTHER_PN }]));

    expect(JSON.stringify([h.logs, h.chats.summary()])).not.toMatch(PRIVATE);
  });
});

describe('whatsapp/probe-chats: настоящая база в памяти', () => {
  it('known_chats после пробы: адреса и время, повтор хранит самое позднее', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const store: ProbeChatStore = {
      knownChats: createKnownChatsRepo(db),
      unitOfWork: createUnitOfWork(db),
      close: () => {
        db.close();
      },
    };
    const h = setup({ store });

    await receive(h, history([{ id: CLIENT_PN, conversationTimestamp: SECONDS - 10 }]));
    await receive(h, upsert([waMessage({ remoteJid: CLIENT_LID, remoteJidAlt: CLIENT_PN })]));
    const rows = db
      .prepare('SELECT jid, last_activity_ms, source FROM known_chats ORDER BY jid')
      .all();
    store.close();

    expect(rows).toEqual([
      { jid: CLIENT_LID, last_activity_ms: AT_MS, source: 'message' },
      { jid: CLIENT_PN, last_activity_ms: AT_MS, source: 'message' },
    ]);
  });
});
