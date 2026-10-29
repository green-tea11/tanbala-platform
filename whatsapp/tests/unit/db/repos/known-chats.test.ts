import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createKnownChatsRepo } from '../../../../src/db/repos/known-chats.js';
import type { KnownChatSource } from '../../../../src/domain/ports.js';
import type { Jid } from '../../../../src/domain/types.js';
import { LID_A, LID_B, PN_A, useMigratedDb } from '../fixture.js';

function rowOf(db: Database.Database, jid: Jid): unknown {
  return db.prepare('SELECT last_activity_ms, source FROM known_chats WHERE jid = ?').get(jid);
}

describe('createKnownChatsRepo', () => {
  it('пустая база: известных чатов нет', () => {
    expect(createKnownChatsRepo(useMigratedDb()).count()).toBe(0);
  });

  it('touch запоминает чат без строки в chats; count считает разные JID', () => {
    const db = useMigratedDb();
    const repo = createKnownChatsRepo(db);

    repo.touch(LID_A, 1000, 'history');
    repo.touch(PN_A, 2000, 'message');
    repo.touch(LID_A, 3000, 'message');

    expect(repo.count()).toBe(2);
    expect(rowOf(db, PN_A)).toEqual({ last_activity_ms: 2000, source: 'message' });
  });

  it('повтор хранит самое позднее время и источник этой активности', () => {
    const db = useMigratedDb();
    const repo = createKnownChatsRepo(db);

    repo.touch(LID_B, 1000, 'history');
    repo.touch(LID_B, 2000, 'message');
    expect(rowOf(db, LID_B)).toEqual({ last_activity_ms: 2000, source: 'message' });

    repo.touch(LID_B, 1500, 'history');
    repo.touch(LID_B, 2000, 'history');
    expect(rowOf(db, LID_B)).toEqual({ last_activity_ms: 2000, source: 'message' });
  });

  it.each([-1, 1.5, Number.NaN])('отклоняет неверное время %s и ничего не пишет', (value) => {
    const repo = createKnownChatsRepo(useMigratedDb());

    expect(() => {
      repo.touch(LID_A, value, 'message');
    }).toThrow(RangeError);
    expect(repo.count()).toBe(0);
  });

  it('неизвестный источник отклоняет база', () => {
    const repo = createKnownChatsRepo(useMigratedDb());

    expect(() => {
      repo.touch(LID_A, 1, 'contacts' as KnownChatSource);
    }).toThrow(/CHECK/);
  });
});
