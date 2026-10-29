import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createBacklogRepo } from '../../../../src/db/repos/backlog.js';
import type { ChatId } from '../../../../src/domain/types.js';
import { errorOf, insertChat, LID_A, LID_B, PN_A, PN_B, useMigratedDb } from '../fixture.js';

const T0 = 1_761_400_000_000;
const HOUR = 3_600_000;

function setup(): { db: Database.Database; first: ChatId; second: ChatId } {
  const db = useMigratedDb();
  return {
    db,
    first: insertChat(db, {
      replyJid: PN_A,
      pnJid: PN_A,
      lidJid: LID_A,
      phone: '77000000001',
      pushName: 'Айгерим',
    }),
    second: insertChat(db, { replyJid: LID_B, lidJid: LID_B }),
  };
}

describe('createBacklogRepo', () => {
  it('markStale отмечает чат; listPending отдаёт его с именем, номером и временем', () => {
    const { db, first } = setup();
    const repo = createBacklogRepo(db);

    repo.markStale(first, T0);

    expect(repo.listPending()).toEqual([
      { chatId: first, name: 'Айгерим', phone: '77000000001', lastMessageAtMs: T0 },
    ]);
  });

  it('чат только с @lid и без имени: номер и имя null', () => {
    const { db, second } = setup();
    const repo = createBacklogRepo(db);

    repo.markStale(second, T0);

    expect(repo.listPending()).toEqual([
      { chatId: second, name: null, phone: null, lastMessageAtMs: T0 },
    ]);
  });

  it('повтор с тем же временем (повторная доставка) ничего не меняет', () => {
    const { db, first } = setup();
    const repo = createBacklogRepo(db);

    repo.markStale(first, T0);
    repo.markStale(first, T0);

    expect(repo.listPending()).toHaveLength(1);
    expect(db.prepare('SELECT count(*) FROM backlog_chats').pluck().get()).toBe(1);
  });

  it('более позднее сообщение сдвигает время, более раннее нет', () => {
    const { db, first } = setup();
    const repo = createBacklogRepo(db);

    repo.markStale(first, T0);
    repo.markStale(first, T0 + HOUR);
    repo.markStale(first, T0 - HOUR);

    expect(repo.listPending()).toEqual([expect.objectContaining({ lastMessageAtMs: T0 + HOUR })]);
  });

  it('listPending идёт по времени последнего сообщения: давние первыми', () => {
    const { db, first, second } = setup();
    const repo = createBacklogRepo(db);

    repo.markStale(first, T0 + HOUR);
    repo.markStale(second, T0);

    expect(repo.listPending().map((chat) => chat.chatId)).toEqual([second, first]);
  });

  it('markNotified убирает из ожидания только переданные чаты', () => {
    const { db, first, second } = setup();
    const repo = createBacklogRepo(db);
    repo.markStale(first, T0);
    repo.markStale(second, T0);

    repo.markNotified([first], T0 + 2 * HOUR);

    expect(repo.listPending().map((chat) => chat.chatId)).toEqual([second]);
    expect(
      db.prepare('SELECT notified_at_ms FROM backlog_chats WHERE chat_id = ?').pluck().get(first),
    ).toBe(T0 + 2 * HOUR);
  });

  it('новое старое сообщение после уведомления возвращает чат в ожидание', () => {
    const { db, first } = setup();
    const repo = createBacklogRepo(db);
    repo.markStale(first, T0);
    repo.markNotified([first], T0 + HOUR);

    repo.markStale(first, T0 + 2 * HOUR);

    expect(repo.listPending()).toEqual([
      expect.objectContaining({ chatId: first, lastMessageAtMs: T0 + 2 * HOUR }),
    ]);
  });

  it('повторная доставка уже известного менеджеру сообщения чат не возвращает', () => {
    const { db, first } = setup();
    const repo = createBacklogRepo(db);
    repo.markStale(first, T0);
    repo.markNotified([first], T0 + HOUR);

    repo.markStale(first, T0);
    repo.markStale(first, T0 - HOUR);

    expect(repo.listPending()).toEqual([]);
  });

  it('markNotified с пустым списком и с неизвестным чатом ничего не ломает', () => {
    const { db, first } = setup();
    const repo = createBacklogRepo(db);
    repo.markStale(first, T0);

    repo.markNotified([], T0 + HOUR);
    repo.markNotified([404 as ChatId], T0 + HOUR);

    expect(repo.listPending()).toHaveLength(1);
  });

  it('несуществующий чат: ошибка внешнего ключа', () => {
    const { db } = setup();

    expect(errorOf(() => createBacklogRepo(db).markStale(404 as ChatId, T0))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
    });
  });

  it('отклоняет неверное время в markStale и markNotified', () => {
    const { db, first } = setup();
    const repo = createBacklogRepo(db);
    repo.markStale(first, T0);

    expect(() => {
      repo.markStale(first, Number.NaN);
    }).toThrow(RangeError);
    expect(() => {
      repo.markNotified([first], 1.5);
    }).toThrow(RangeError);
    expect(repo.listPending()).toEqual([expect.objectContaining({ lastMessageAtMs: T0 })]);
  });

  it('номер и адреса второго чата не попадают в чужую строку', () => {
    const { db, first, second } = setup();
    db.prepare('UPDATE chats SET phone = ?, pn_jid = ? WHERE id = ?').run(
      '77000000002',
      PN_B,
      second,
    );
    const repo = createBacklogRepo(db);
    repo.markStale(first, T0);
    repo.markStale(second, T0 + HOUR);

    expect(repo.listPending().map((chat) => chat.phone)).toEqual(['77000000001', '77000000002']);
  });
});
