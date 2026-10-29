import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createKnownChatsRepo } from '../../../../src/db/repos/known-chats.js';
import { createWorkingModeRepo } from '../../../../src/db/repos/working-mode.js';
import type { Jid } from '../../../../src/domain/types.js';
import { insertChat, LID_A, LID_B, PN_A, PN_B, useMigratedDb } from '../fixture.js';

function heldOf(db: Database.Database): unknown[] {
  return db
    .prepare('SELECT jid FROM known_chats WHERE held_for_manager = 1 ORDER BY jid')
    .pluck()
    .all();
}

function addMessage(db: Database.Database, chatId: number, waId: string, tsMs: number): void {
  db.prepare(
    `INSERT INTO messages (chat_id, wa_id, author, kind, text, ts_ms)
     VALUES (?, ?, 'client', 'text', 'Здравствуйте', ?)`,
  ).run(chatId, waId, tsMs);
}

describe('createWorkingModeRepo: известные чаты', () => {
  it('пустая база: известных чатов и чатов нет', () => {
    const repo = createWorkingModeRepo(useMigratedDb());

    expect(repo.listKnownChats()).toEqual([]);
    expect(repo.listChats()).toEqual([]);
  });

  it('listKnownChats отдаёт адрес и последнюю активность каждого чата, по адресу', () => {
    const db = useMigratedDb();
    const known = createKnownChatsRepo(db);
    known.touch(PN_A, 2000, 'message');
    known.touch(LID_A, 1000, 'history');
    known.touch(LID_A, 3000, 'message');

    expect(createWorkingModeRepo(db).listKnownChats()).toEqual([
      { jid: LID_A, lastActivityMs: 3000 },
      { jid: PN_A, lastActivityMs: 2000 },
    ]);
  });
});

describe('createWorkingModeRepo: отметка «у менеджера»', () => {
  it('holdForManager отмечает переданные адреса; isHeldForManager видит любой из них', () => {
    const db = useMigratedDb();
    const known = createKnownChatsRepo(db);
    for (const jid of [PN_A, LID_A, PN_B]) known.touch(jid, 1000, 'history');
    const repo = createWorkingModeRepo(db);

    repo.holdForManager([LID_A, PN_B]);

    expect(heldOf(db)).toEqual([LID_A, PN_B].toSorted());
    expect(repo.isHeldForManager([PN_A])).toBe(false);
    expect(repo.isHeldForManager([PN_A, LID_A])).toBe(true);
    expect(repo.isHeldForManager([])).toBe(false);
  });

  it('повтор считает отметки заново: прежние снимаются, неизвестные адреса не добавляются', () => {
    const db = useMigratedDb();
    const known = createKnownChatsRepo(db);
    for (const jid of [PN_A, LID_A]) known.touch(jid, 1000, 'history');
    const repo = createWorkingModeRepo(db);
    repo.holdForManager([PN_A, LID_A]);

    repo.holdForManager([LID_A, LID_B]);

    expect(heldOf(db)).toEqual([LID_A]);
    expect(repo.isHeldForManager([LID_B])).toBe(false);
    expect(known.count()).toBe(2);
  });

  it('новый адрес после перехода не отмечен, а touch отметку старого не снимает', () => {
    const db = useMigratedDb();
    const known = createKnownChatsRepo(db);
    known.touch(PN_A, 1000, 'history');
    const repo = createWorkingModeRepo(db);
    repo.holdForManager([PN_A]);

    known.touch(PN_A, 5000, 'message');
    known.touch(PN_B, 5000, 'message');

    expect(repo.isHeldForManager([PN_A])).toBe(true);
    expect(repo.isHeldForManager([PN_B])).toBe(false);
  });

  it('addHeldForManager добавляет отметки: прежние остаются, неизвестные адреса не добавляются', () => {
    const db = useMigratedDb();
    const known = createKnownChatsRepo(db);
    for (const jid of [PN_A, LID_A, PN_B]) known.touch(jid, 1000, 'history');
    const repo = createWorkingModeRepo(db);
    repo.holdForManager([PN_A]);

    repo.addHeldForManager([LID_A, LID_B]);
    repo.addHeldForManager([]);

    expect(heldOf(db)).toEqual([LID_A, PN_A].toSorted());
    expect(repo.isHeldForManager([PN_B])).toBe(false);
    expect(known.count()).toBe(3);
  });

  it('много адресов разом: отметка одним запросом без лимита переменных SQLite', () => {
    const db = useMigratedDb();
    const known = createKnownChatsRepo(db);
    const jids = Array.from({ length: 40_000 }, (_, index) => `${100_000 + index}@lid` as Jid);
    db.transaction(() => {
      for (const jid of jids) known.touch(jid, 1000, 'history');
    })();
    const repo = createWorkingModeRepo(db);

    repo.holdForManager(jids);

    expect(
      db.prepare('SELECT count(*) FROM known_chats WHERE held_for_manager = 1').pluck().get(),
    ).toBe(jids.length);
  });
});

describe('createWorkingModeRepo: чаты базы', () => {
  it('listChats: адреса, статус и время последнего сообщения (без сообщений null), по ID', () => {
    const db = useMigratedDb();
    const first = insertChat(db, {
      replyJid: LID_A,
      lidJid: LID_A,
      pnJid: PN_A,
      phone: '77000000001',
    });
    const second = insertChat(db, { replyJid: PN_B, pnJid: PN_B });
    addMessage(db, first, 'WA-1', 1000);
    addMessage(db, first, 'WA-2', 4000);
    db.prepare(
      "UPDATE chats SET status = 'manager', status_by = 'panel', status_changed_at = 5 WHERE id = ?",
    ).run(second);

    expect(createWorkingModeRepo(db).listChats()).toEqual([
      {
        id: first,
        identity: { replyJid: LID_A, lidJid: LID_A, pnJid: PN_A },
        status: 'bot',
        lastMessageAtMs: 4000,
      },
      {
        id: second,
        identity: { replyJid: PN_B, lidJid: null, pnJid: PN_B },
        status: 'manager',
        lastMessageAtMs: null,
      },
    ]);
  });
});
