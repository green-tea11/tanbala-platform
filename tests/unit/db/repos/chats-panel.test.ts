import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createChatsRepo } from '../../../../src/db/repos/chats.js';
import { createHandoffsRepo } from '../../../../src/db/repos/handoffs.js';
import { createMessagesRepo } from '../../../../src/db/repos/messages.js';
import type { ChatsRepo, HandoffsRepo, MessagesRepo } from '../../../../src/domain/ports.js';
import type {
  Author,
  Chat,
  ChatId,
  ChatStatus,
  Jid,
  PanelChatRow,
  WaMessageId,
} from '../../../../src/domain/types.js';
import { EMPTY_PROFILE, insertChat, profileOf, useMigratedDb } from '../fixture.js';

const T0 = 1_761_400_000_000;
const ALL = { limit: 100, offset: 0 };

interface Setup {
  readonly db: Database.Database;
  readonly chats: ChatsRepo;
  readonly messages: MessagesRepo;
  readonly handoffs: HandoffsRepo;
}

function setup(): Setup {
  const db = useMigratedDb();
  return {
    db,
    chats: createChatsRepo(db),
    messages: createMessagesRepo(db),
    handoffs: createHandoffsRepo(db),
  };
}

/** Вымышленный номер: 7700000NNNN. */
function pnJid(n: number): Jid {
  return `770000${String(n).padStart(5, '0')}@s.whatsapp.net` as Jid;
}

function addChat(chats: ChatsRepo, n: number, pushName: string | null = null): Chat {
  const jid = pnJid(n);
  return chats.upsertByIdentity({ replyJid: jid, lidJid: null, pnJid: jid }, pushName, T0);
}

function say(
  messages: MessagesRepo,
  chatId: ChatId,
  waId: string,
  offsetMs: number,
  author: Author = 'client',
): void {
  messages.insertIfNew({
    chatId,
    waId: waId as WaMessageId,
    author,
    kind: 'text',
    text: waId,
    tsMs: T0 + offsetMs,
  });
}

function order(rows: readonly PanelChatRow[]): ChatId[] {
  return rows.map((row) => row.chat.id);
}

describe('createChatsRepo: listForPanel, порядок и время', () => {
  it('сверху чат с самым свежим сообщением, сообщение любого автора считается', () => {
    const { chats, messages } = setup();
    const client = addChat(chats, 1);
    const bot = addChat(chats, 2);
    const panel = addChat(chats, 3);
    say(messages, client.id, 'C1', 1000, 'client');
    say(messages, bot.id, 'B1', 5000, 'bot');
    say(messages, panel.id, 'P1', 3000, 'human_panel');

    const rows = chats.listForPanel(ALL);

    expect(order(rows)).toEqual([bot.id, panel.id, client.id]);
    expect(rows.map((row) => row.lastMessageAtMs)).toEqual([T0 + 5000, T0 + 3000, T0 + 1000]);
  });

  it('время последнего сообщения берётся по времени сообщения, а не по порядку записи', () => {
    const { chats, messages } = setup();
    const first = addChat(chats, 1);
    const second = addChat(chats, 2);
    say(messages, first.id, 'F-LATE', 9000);
    say(messages, first.id, 'F-EARLY', 1000);
    say(messages, second.id, 'S1', 5000);

    const rows = chats.listForPanel(ALL);

    expect(order(rows)).toEqual([first.id, second.id]);
    expect(rows[0]?.lastMessageAtMs).toBe(T0 + 9000);
  });

  it('чат без сообщений в конце, время null', () => {
    const { chats, messages } = setup();
    const empty = addChat(chats, 1);
    const talked = addChat(chats, 2);
    say(messages, talked.id, 'T1', 100);

    const rows = chats.listForPanel(ALL);

    expect(order(rows)).toEqual([talked.id, empty.id]);
    expect(rows[1]?.lastMessageAtMs).toBeNull();
  });

  it('при равном времени сверху чат с большим id: порядок страниц не гуляет', () => {
    const { chats, messages } = setup();
    const ids = [1, 2, 3].map((n) => addChat(chats, n).id);
    ids.forEach((id) => {
      say(messages, id, `W${id}`, 7000);
    });

    expect(order(chats.listForPanel(ALL))).toEqual([...ids].reverse());
  });

  it('в строке полный чат: имя, адреса, кто ведёт, уровень, выжимка', () => {
    const { chats, messages } = setup();
    const chat = addChat(chats, 1, 'Айгерим');
    say(messages, chat.id, 'W1', 0);
    chats.saveAssessment(chat.id, { level: 'warm', profile: profileOf(), reason: 'x' }, T0);
    chats.setStatus(chat.id, { status: 'manager', by: 'phone' }, T0 + 1);

    const row = chats.listForPanel(ALL)[0];

    expect(row?.chat).toEqual({
      id: chat.id,
      identity: { replyJid: pnJid(1), lidJid: null, pnJid: pnJid(1) },
      pushName: 'Айгерим',
      control: { status: 'manager', by: 'phone' },
      level: 'warm',
      profile: profileOf(),
    });
    expect(row?.chat).toEqual(chats.getById(chat.id));
  });
});

describe('createChatsRepo: listForPanel, открытая передача', () => {
  it('открытая передача в строке: причина, уровень и время; у остальных null', () => {
    const { chats, messages, handoffs } = setup();
    const handed = addChat(chats, 1);
    const plain = addChat(chats, 2);
    say(messages, handed.id, 'H1', 2000);
    say(messages, plain.id, 'P1', 1000);
    handoffs.open(handed.id, 'asked_human', 'warm', 'снимок', T0 + 1500);

    const rows = chats.listForPanel(ALL);

    expect(rows.map((row) => row.openHandoff)).toEqual([
      { reason: 'asked_human', level: 'warm', openedAtMs: T0 + 1500 },
      null,
    ]);
  });

  it('закрытые передачи не размножают строку и в ней не показываются', () => {
    const { chats, messages, handoffs } = setup();
    const chat = addChat(chats, 1);
    say(messages, chat.id, 'W1', 0);
    for (const offset of [10, 20, 30]) {
      handoffs.open(chat.id, 'hot', 'hot', 'снимок', T0 + offset);
      handoffs.resolve(chat.id, T0 + offset + 5);
    }

    expect(chats.listForPanel(ALL).map((row) => row.openHandoff)).toEqual([null]);

    handoffs.open(chat.id, 'complaint', 'cold', 'снимок', T0 + 40);

    expect(chats.listForPanel(ALL).map((row) => row.openHandoff)).toEqual([
      { reason: 'complaint', level: 'cold', openedAtMs: T0 + 40 },
    ]);
  });

  it('чат с очень длинной перепиской не размножает строку', () => {
    const { db, chats, messages } = setup();
    const chat = addChat(chats, 1);
    db.transaction(() => {
      for (let index = 0; index < 600; index += 1) say(messages, chat.id, `W${index}`, index);
    })();

    const rows = chats.listForPanel(ALL);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastMessageAtMs).toBe(T0 + 599);
  });
});

describe('createChatsRepo: listForPanel и countForPanel, фильтр и страницы', () => {
  function mixed(): Setup & { readonly byBot: ChatId[]; readonly byManager: ChatId[] } {
    const base = setup();
    const created = [1, 2, 3, 4, 5].map((n) => addChat(base.chats, n).id);
    created.forEach((id, index) => {
      say(base.messages, id, `W${id}`, index * 1000);
    });
    const [first, second, third, fourth, fifth] = created;
    base.chats.setStatus(second as ChatId, { status: 'manager', by: 'bot' }, T0);
    base.chats.setStatus(fourth as ChatId, { status: 'manager', by: 'phone' }, T0);
    return {
      ...base,
      byBot: [fifth as ChatId, third as ChatId, first as ChatId],
      byManager: [fourth as ChatId, second as ChatId],
    };
  }

  it('фильтр по статусу: только чаты бота или только менеджера, свежие сверху', () => {
    const { chats, byBot, byManager } = mixed();

    expect(order(chats.listForPanel({ ...ALL, status: 'bot' }))).toEqual(byBot);
    expect(order(chats.listForPanel({ ...ALL, status: 'manager' }))).toEqual(byManager);
    expect(chats.listForPanel(ALL)).toHaveLength(5);
  });

  it('countForPanel считает с тем же фильтром', () => {
    const { chats } = mixed();

    expect(chats.countForPanel({})).toBe(5);
    expect(chats.countForPanel({ status: 'bot' })).toBe(3);
    expect(chats.countForPanel({ status: 'manager' })).toBe(2);
  });

  it('пустая база: список пуст, счёт 0', () => {
    const { chats } = setup();

    expect(chats.listForPanel(ALL)).toEqual([]);
    expect(chats.countForPanel({})).toBe(0);
    expect(chats.countForPanel({ status: 'manager' })).toBe(0);
  });

  it('страницы идут подряд без пропусков и повторов, за концом пусто', () => {
    const { chats } = mixed();
    const whole = order(chats.listForPanel(ALL));

    expect(order(chats.listForPanel({ limit: 2, offset: 0 }))).toEqual(whole.slice(0, 2));
    expect(order(chats.listForPanel({ limit: 2, offset: 2 }))).toEqual(whole.slice(2, 4));
    expect(order(chats.listForPanel({ limit: 2, offset: 4 }))).toEqual(whole.slice(4));
    expect(chats.listForPanel({ limit: 2, offset: 5 })).toEqual([]);
    expect(chats.listForPanel({ limit: 0, offset: 0 })).toEqual([]);
  });

  it('страницы с фильтром считаются внутри фильтра', () => {
    const { chats, byBot } = mixed();

    expect(order(chats.listForPanel({ status: 'bot', limit: 2, offset: 2 }))).toEqual(
      byBot.slice(2),
    );
  });

  it.each([
    ['limit', { limit: -1, offset: 0 }],
    ['limit', { limit: 1.5, offset: 0 }],
    ['limit', { limit: Number.NaN, offset: 0 }],
    ['offset', { limit: 10, offset: -1 }],
    ['offset', { limit: 10, offset: 0.5 }],
    ['offset', { limit: 10, offset: Number.NaN }],
  ])('неверный %s: RangeError, а не «без лимита»', (_name, query) => {
    const { chats } = mixed();

    expect(() => chats.listForPanel(query)).toThrow(RangeError);
  });

  it.each(['robot', '', "bot' OR '1'='1"])('статус %j вне белого списка: RangeError', (status) => {
    const { chats } = setup();

    expect(() => chats.listForPanel({ ...ALL, status: status as ChatStatus })).toThrow(RangeError);
    expect(() => chats.countForPanel({ status: status as ChatStatus })).toThrow(RangeError);
  });

  it('статус undefined (параметр не задан) равен «все чаты»', () => {
    const { chats } = mixed();

    expect(chats.listForPanel({ ...ALL, status: undefined })).toHaveLength(5);
    expect(chats.countForPanel({ status: undefined })).toBe(5);
  });
});

describe('createChatsRepo: listForPanel, большой список', () => {
  it('3000 чатов листаются по 100: порядок по времени и id, без потерь и повторов', () => {
    const { db, chats } = setup();
    const expected: { id: number; ts: number }[] = [];
    const insertMessage = db.prepare(
      `INSERT INTO messages (chat_id, wa_id, author, kind, text, ts_ms)
       VALUES (?, 'W1', 'client', 'text', 'x', ?)`,
    );
    db.transaction(() => {
      for (let n = 1; n <= 3000; n += 1) {
        const id = insertChat(db, { replyJid: pnJid(n) });
        const ts = T0 + Math.floor(n / 3) * 1000;
        insertMessage.run(id, ts);
        expected.push({ id, ts });
      }
    })();
    const expectedOrder = expected
      .sort((left, right) => right.ts - left.ts || right.id - left.id)
      .map((entry) => entry.id);

    const seen: ChatId[] = [];
    for (let offset = 0; offset < 3000; offset += 100) {
      seen.push(...order(chats.listForPanel({ limit: 100, offset })));
    }

    expect(chats.countForPanel({})).toBe(3000);
    expect(seen).toEqual(expectedOrder);
    expect(chats.listForPanel({ limit: 100, offset: 3000 })).toEqual([]);
  });

  it('у чатов без выжимки в строке пустая выжимка', () => {
    const { chats, messages } = setup();
    const chat = addChat(chats, 1);
    say(messages, chat.id, 'W1', 0);

    expect(chats.listForPanel(ALL)[0]?.chat.profile).toEqual(EMPTY_PROFILE);
  });
});
