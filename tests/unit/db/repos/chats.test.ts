import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createChatsRepo } from '../../../../src/db/repos/chats.js';
import type { ChatsRepo } from '../../../../src/domain/ports.js';
import type { ChatId, ChatIdentity, Jid } from '../../../../src/domain/types.js';
import { EMPTY_PROFILE, insertChat, LID_A, LID_B, PN_A, PN_B, useMigratedDb } from '../fixture.js';

const T0 = 1_761_400_000_000;

const LID_ONLY: ChatIdentity = { replyJid: LID_A, lidJid: LID_A, pnJid: null };
const PN_ONLY: ChatIdentity = { replyJid: PN_A, lidJid: null, pnJid: PN_A };
const BOTH_VIA_LID: ChatIdentity = { replyJid: LID_A, lidJid: LID_A, pnJid: PN_A };
const BOTH_VIA_PN: ChatIdentity = { replyJid: PN_A, lidJid: LID_A, pnJid: PN_A };

function setup(): { db: Database.Database; repo: ChatsRepo } {
  const db = useMigratedDb();
  return { db, repo: createChatsRepo(db) };
}

function chatCount(db: Database.Database): unknown {
  return db.prepare('SELECT count(*) FROM chats').pluck().get();
}

function column(db: Database.Database, id: ChatId, name: string): unknown {
  return db.prepare(`SELECT ${name} FROM chats WHERE id = ?`).pluck().get(id);
}

function addMessage(db: Database.Database, chatId: ChatId, waId: string): void {
  db.prepare(
    "INSERT INTO messages (chat_id, wa_id, author, kind, text, ts_ms) VALUES (?, ?, 'client', 'text', 'x', 1)",
  ).run(chatId, waId);
}

function messagesOf(db: Database.Database): unknown[] {
  return db.prepare('SELECT chat_id, wa_id FROM messages ORDER BY wa_id').all();
}

function backlogRows(db: Database.Database): unknown[] {
  return db.prepare('SELECT chat_id, marked_at_ms, notified_at_ms FROM backlog_chats').all();
}

function setControl(db: Database.Database, id: ChatId, status: string, by: string | null): void {
  db.prepare('UPDATE chats SET status = ?, status_by = ?, status_changed_at = ? WHERE id = ?').run(
    status,
    by,
    by === null ? null : T0,
    id,
  );
}

describe('createChatsRepo: upsertByIdentity', () => {
  it('новый адрес создаёт чат: ведёт бот, статус не менялся, интерес холодный, выжимка пустая', () => {
    const { db, repo } = setup();

    const chat = repo.upsertByIdentity(LID_ONLY, 'Айгерим', T0);

    expect(chat.id).toBeGreaterThan(0);
    expect(chat).toEqual({
      id: chat.id,
      identity: LID_ONLY,
      pushName: 'Айгерим',
      control: { status: 'bot', by: null },
      level: 'cold',
      profile: EMPTY_PROFILE,
    });
    expect(repo.getById(chat.id)).toEqual(chat);
    expect(column(db, chat.id, 'created_at')).toBe(T0);
    expect(column(db, chat.id, 'last_inbound_at')).toBe(T0);
  });

  it('тот же адрес находит тот же чат и обновляет имя из профиля', () => {
    const { db, repo } = setup();
    const first = repo.upsertByIdentity(PN_ONLY, 'Айгерим', T0);

    const again = repo.upsertByIdentity(PN_ONLY, 'Айгерим Б.', T0 + 1000);

    expect(again.id).toBe(first.id);
    expect(again.pushName).toBe('Айгерим Б.');
    expect(chatCount(db)).toBe(1);
  });

  it('имя null не стирает известное имя', () => {
    const { repo } = setup();
    repo.upsertByIdentity(PN_ONLY, 'Айгерим', T0);

    expect(repo.upsertByIdentity(PN_ONLY, null, T0 + 1).pushName).toBe('Айгерим');
  });

  it('время создания остаётся первым, время последнего входящего только растёт', () => {
    const { db, repo } = setup();
    const chat = repo.upsertByIdentity(PN_ONLY, null, T0);

    repo.upsertByIdentity(PN_ONLY, null, T0 + 1000);
    repo.upsertByIdentity(PN_ONLY, null, T0 + 500);

    expect(column(db, chat.id, 'created_at')).toBe(T0);
    expect(column(db, chat.id, 'last_inbound_at')).toBe(T0 + 1000);
  });

  it('чат с @lid получает номер, когда тот стал известен', () => {
    const { db, repo } = setup();
    const lidChat = repo.upsertByIdentity(LID_ONLY, null, T0);

    const chat = repo.upsertByIdentity(BOTH_VIA_LID, null, T0 + 1);

    expect(chat.id).toBe(lidChat.id);
    expect(chat.identity).toEqual(BOTH_VIA_LID);
    expect(column(db, chat.id, 'phone')).toBe('77000000001');
    expect(chatCount(db)).toBe(1);
  });

  it('чат с номером получает @lid', () => {
    const { db, repo } = setup();
    const pnChat = repo.upsertByIdentity(PN_ONLY, null, T0);

    const chat = repo.upsertByIdentity(BOTH_VIA_PN, null, T0 + 1);

    expect(chat.id).toBe(pnChat.id);
    expect(chat.identity).toEqual(BOTH_VIA_PN);
    expect(chatCount(db)).toBe(1);
  });

  it('replyJid следует за адресом последнего сообщения, известные адреса не теряются', () => {
    const { db, repo } = setup();
    const chat = repo.upsertByIdentity(BOTH_VIA_PN, null, T0);

    expect(repo.upsertByIdentity(BOTH_VIA_LID, null, T0 + 1).identity).toEqual(BOTH_VIA_LID);
    expect(repo.upsertByIdentity(PN_ONLY, null, T0 + 2).identity).toEqual(BOTH_VIA_PN);
    expect(repo.upsertByIdentity(LID_ONLY, null, T0 + 3).identity).toEqual(BOTH_VIA_LID);
    expect(column(db, chat.id, 'phone')).toBe('77000000001');
  });

  it.each([
    ['77000000001@s.whatsapp.net', '77000000001'],
    ['77000000001:12@s.whatsapp.net', '77000000001'],
    ['77000000001@hosted', '77000000001'],
    ['abc@s.whatsapp.net', null],
    ['100000000000001@lid', null],
  ])('номер из адреса %s: %s', (pnJid, phone) => {
    const { db, repo } = setup();

    const chat = repo.upsertByIdentity(
      { replyJid: pnJid as Jid, lidJid: null, pnJid: pnJid as Jid },
      null,
      T0,
    );

    expect(column(db, chat.id, 'phone')).toBe(phone);
  });

  it.each([-1, 1.5, Number.NaN])('отклоняет неверное время %s и ничего не создаёт', (nowMs) => {
    const { db, repo } = setup();

    expect(() => repo.upsertByIdentity(PN_ONLY, null, nowMs)).toThrow(RangeError);
    expect(chatCount(db)).toBe(0);
  });
});

describe('createChatsRepo: слияние чатов одного человека', () => {
  it('остаётся старший чат: история и отметка простоя переезжают, младший удаляется', () => {
    const { db, repo } = setup();
    const lidChat = repo.upsertByIdentity(LID_ONLY, 'Айгерим', T0);
    const pnChat = repo.upsertByIdentity(PN_ONLY, null, T0 + 1);
    addMessage(db, lidChat.id, 'W1');
    addMessage(db, pnChat.id, 'W2');
    db.prepare('INSERT INTO backlog_chats (chat_id, marked_at_ms) VALUES (?, ?)').run(
      pnChat.id,
      T0,
    );

    const merged = repo.upsertByIdentity(BOTH_VIA_LID, null, T0 + 2);

    expect(merged).toMatchObject({ id: lidChat.id, identity: BOTH_VIA_LID, pushName: 'Айгерим' });
    expect(repo.getById(pnChat.id)).toBeNull();
    expect(repo.findByJid(PN_A)?.id).toBe(lidChat.id);
    expect(messagesOf(db)).toEqual([
      { chat_id: lidChat.id, wa_id: 'W1' },
      { chat_id: lidChat.id, wa_id: 'W2' },
    ]);
    expect(backlogRows(db)).toEqual([
      { chat_id: lidChat.id, marked_at_ms: T0, notified_at_ms: null },
    ]);
    expect(column(db, lidChat.id, 'phone')).toBe('77000000001');
    expect(column(db, lidChat.id, 'created_at')).toBe(T0);
    expect(column(db, lidChat.id, 'last_inbound_at')).toBe(T0 + 2);
  });

  it('исходящие слитого чата переезжают в оставшийся', () => {
    const { db, repo } = setup();
    const lidChat = repo.upsertByIdentity(LID_ONLY, null, T0);
    const pnChat = repo.upsertByIdentity(PN_ONLY, null, T0);
    db.prepare(
      `INSERT INTO outbound_ids (wa_id, chat_id, jid, origin, text, created_at)
       VALUES ('OUT-1', ?, ?, 'bot_reply', 'текст', ?)`,
    ).run(pnChat.id, PN_A, T0);

    repo.upsertByIdentity(BOTH_VIA_LID, null, T0 + 1);

    expect(db.prepare('SELECT wa_id, chat_id FROM outbound_ids').all()).toEqual([
      { wa_id: 'OUT-1', chat_id: lidChat.id },
    ]);
  });

  it('счётчики вызовов API слитого чата складываются в оставшийся по каждому дню', () => {
    const { db, repo } = setup();
    const lidChat = repo.upsertByIdentity(LID_ONLY, null, T0);
    const pnChat = repo.upsertByIdentity(PN_ONLY, null, T0);
    const count = db.prepare('INSERT INTO api_usage (day, chat_id, count) VALUES (?, ?, ?)');
    count.run('2026-10-25', pnChat.id, 1);
    count.run('2026-10-26', lidChat.id, 2);
    count.run('2026-10-26', pnChat.id, 3);
    count.run('2026-10-26', 0, 5);

    repo.upsertByIdentity(BOTH_VIA_LID, null, T0 + 1);

    expect(
      db.prepare('SELECT day, chat_id, count FROM api_usage ORDER BY day, chat_id').all(),
    ).toEqual([
      { day: '2026-10-25', chat_id: lidChat.id, count: 1 },
      { day: '2026-10-26', chat_id: 0, count: 5 },
      { day: '2026-10-26', chat_id: lidChat.id, count: 5 },
    ]);
  });

  it('одно и то же сообщение в обоих чатах остаётся одной строкой', () => {
    const { db, repo } = setup();
    const lidChat = repo.upsertByIdentity(LID_ONLY, null, T0);
    const pnChat = repo.upsertByIdentity(PN_ONLY, null, T0);
    addMessage(db, lidChat.id, 'W1');
    addMessage(db, pnChat.id, 'W1');

    repo.upsertByIdentity(BOTH_VIA_PN, null, T0 + 1);

    expect(messagesOf(db)).toEqual([{ chat_id: lidChat.id, wa_id: 'W1' }]);
  });

  it('сливает и три чата, если адрес ответа третий', () => {
    const { db } = setup();
    const repo = createChatsRepo(db);
    const hosted = '77000000001@hosted' as Jid;
    const oldest = insertChat(db, { replyJid: hosted });
    insertChat(db, { replyJid: LID_A, lidJid: LID_A });
    insertChat(db, { replyJid: PN_A, pnJid: PN_A, pushName: 'Айгерим' });

    const merged = repo.upsertByIdentity(
      { replyJid: hosted, lidJid: LID_A, pnJid: PN_A },
      null,
      T0,
    );

    expect(merged).toMatchObject({
      id: oldest,
      identity: { replyJid: hosted, lidJid: LID_A, pnJid: PN_A },
      pushName: 'Айгерим',
    });
    expect(chatCount(db)).toBe(1);
    expect(column(db, oldest, 'last_inbound_at')).toBe(T0);
  });

  it.each([
    [
      'младший ведёт менеджер',
      ['bot', null],
      ['manager', 'phone'],
      { status: 'manager', by: 'phone' },
    ],
    ['старший ведёт менеджер', ['manager', 'bot'], ['bot', null], { status: 'manager', by: 'bot' }],
    [
      'оба у бота, один вернула панель',
      ['bot', 'panel'],
      ['bot', null],
      { status: 'bot', by: 'panel' },
    ],
  ] as const)('статус менеджера не теряется: %s', (_label, older, newer, control) => {
    const { db, repo } = setup();
    const lidChat = repo.upsertByIdentity(LID_ONLY, null, T0);
    const pnChat = repo.upsertByIdentity(PN_ONLY, null, T0);
    setControl(db, lidChat.id, older[0], older[1]);
    setControl(db, pnChat.id, newer[0], newer[1]);

    expect(repo.upsertByIdentity(BOTH_VIA_LID, null, T0 + 1).control).toEqual(control);
  });

  it.each([
    ['hot', 'cold', 'hot'],
    ['cold', 'warm', 'warm'],
    ['warm', 'warm', 'warm'],
  ])('остаётся более горячий интерес: %s и %s => %s', (older, newer, merged) => {
    const { db, repo } = setup();
    const lidChat = repo.upsertByIdentity(LID_ONLY, null, T0);
    const pnChat = repo.upsertByIdentity(PN_ONLY, null, T0);
    db.prepare('UPDATE chats SET interest_level = ? WHERE id = ?').run(older, lidChat.id);
    db.prepare('UPDATE chats SET interest_level = ? WHERE id = ?').run(newer, pnChat.id);

    expect(repo.upsertByIdentity(BOTH_VIA_LID, null, T0 + 1).level).toBe(merged);
  });

  it.each([
    ['одна отметка ждёт уведомления', [T0, T0 + 10], [T0 + 5, null], [T0 + 5, null]],
    ['обе уже в уведомлении', [T0, T0 + 10], [T0 + 5, T0 + 20], [T0 + 5, T0 + 20]],
    ['у старшего ждёт, у младшего уже сообщили', [T0 + 5, null], [T0, T0 + 10], [T0 + 5, null]],
  ] as const)('отметки простоя сливаются: %s', (_label, older, newer, merged) => {
    const { db, repo } = setup();
    const lidChat = repo.upsertByIdentity(LID_ONLY, null, T0);
    const pnChat = repo.upsertByIdentity(PN_ONLY, null, T0);
    const mark = db.prepare(
      'INSERT INTO backlog_chats (chat_id, marked_at_ms, notified_at_ms) VALUES (?, ?, ?)',
    );
    mark.run(lidChat.id, ...older);
    mark.run(pnChat.id, ...newer);

    repo.upsertByIdentity(BOTH_VIA_LID, null, T0 + 1);

    expect(backlogRows(db)).toEqual([
      { chat_id: lidChat.id, marked_at_ms: merged[0], notified_at_ms: merged[1] },
    ]);
  });
});

describe('createChatsRepo: findByJid и getById', () => {
  it('findByJid находит по replyJid, lidJid и pnJid и не создаёт чат', () => {
    const { db, repo } = setup();
    const chat = repo.upsertByIdentity(BOTH_VIA_LID, null, T0);
    const replyOnly = insertChat(db, { replyJid: LID_B });

    expect(repo.findByJid(LID_A)).toEqual(chat);
    expect(repo.findByJid(PN_A)).toEqual(chat);
    expect(repo.findByJid(LID_B)?.id).toBe(replyOnly);
    expect(repo.findByJid(PN_B)).toBeNull();
    expect(chatCount(db)).toBe(2);
  });

  it('getById: неизвестный id => null', () => {
    const { repo } = setup();

    expect(repo.getById(404 as ChatId)).toBeNull();
  });

  it.each([
    ['bot', null, { status: 'bot', by: null }],
    ['bot', 'panel', { status: 'bot', by: 'panel' }],
    ['manager', 'bot', { status: 'manager', by: 'bot' }],
    ['manager', 'phone', { status: 'manager', by: 'phone' }],
    ['manager', 'panel', { status: 'manager', by: 'panel' }],
  ])('статус %s, сменил %s: control собирается из базы', (status, by, control) => {
    const { db, repo } = setup();
    const id = insertChat(db, { replyJid: PN_A });
    setControl(db, id, status, by);

    expect(repo.getById(id)?.control).toEqual(control);
  });

  it.each(['cold', 'warm', 'hot'])('уровень интереса %s читается из базы', (level) => {
    const { db, repo } = setup();
    const id = insertChat(db, { replyJid: PN_A });
    db.prepare('UPDATE chats SET interest_level = ? WHERE id = ?').run(level, id);

    expect(repo.getById(id)?.level).toBe(level);
  });

  it.each([
    ['статус вне списка', "UPDATE chats SET status = 'robot'", /статус/],
    ['менеджер без автора смены', "UPDATE chats SET status = 'manager'", /статус/],
    ['уровень вне списка', "UPDATE chats SET interest_level = 'lukewarm'", /интерес/],
  ])('испорченная строка в базе: явная ошибка (%s)', (_label, sql, message) => {
    const { db, repo } = setup();
    const id = insertChat(db, { replyJid: PN_A });
    db.pragma('ignore_check_constraints = ON');
    db.prepare(sql).run();

    expect(() => repo.getById(id)).toThrow(message);
  });
});

describe('createChatsRepo: setStatus', () => {
  it.each([
    { status: 'manager', by: 'phone' },
    { status: 'manager', by: 'bot' },
    { status: 'manager', by: 'panel' },
    { status: 'bot', by: 'panel' },
  ] as const)('хранит смену $status ($by): статус, кто и когда', (change) => {
    const { db, repo } = setup();
    const id = insertChat(db, { replyJid: PN_A });

    repo.setStatus(id, change, T0 + 5);

    expect(repo.getById(id)?.control).toEqual(change);
    expect(column(db, id, 'status_changed_at')).toBe(T0 + 5);
  });

  it('меняет только свой чат', () => {
    const { db, repo } = setup();
    const id = insertChat(db, { replyJid: PN_A });
    const other = insertChat(db, { replyJid: PN_B });

    repo.setStatus(id, { status: 'manager', by: 'phone' }, T0);

    expect(repo.getById(other)?.control).toEqual({ status: 'bot', by: null });
  });

  it('неизвестный чат: явная ошибка', () => {
    const { repo } = setup();

    expect(() => {
      repo.setStatus(404 as ChatId, { status: 'manager', by: 'bot' }, T0);
    }).toThrow(/404/);
  });

  it.each([-1, 1.5, Number.NaN])('неверное время %s: RangeError, статус не меняется', (nowMs) => {
    const { db, repo } = setup();
    const id = insertChat(db, { replyJid: PN_A });

    expect(() => {
      repo.setStatus(id, { status: 'manager', by: 'bot' }, nowMs);
    }).toThrow(RangeError);
    expect(repo.getById(id)?.control).toEqual({ status: 'bot', by: null });
  });
});
