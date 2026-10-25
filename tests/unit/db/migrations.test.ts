import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/db/connection.js';
import { runMigrations } from '../../../src/db/migrations.js';
import {
  errorOf,
  insertChat,
  LID_A,
  PN_A,
  useMemoryDb,
  useMigratedDb,
  useTempDir,
} from './fixture.js';

function userVersion(db: Database.Database): unknown {
  return db.pragma('user_version', { simple: true });
}

function tableNames(db: Database.Database): unknown[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .pluck()
    .all();
}

const STAGE_2_TABLES = [
  'app_state',
  'backlog_chats',
  'chats',
  'known_chats',
  'messages',
  'pairing_attempts',
];

describe('runMigrations', () => {
  it('новая база получает версию 1 и ровно таблицы этапа 2', () => {
    const db = useMemoryDb();

    runMigrations(db);

    expect(userVersion(db)).toBe(1);
    expect(tableNames(db)).toEqual(STAGE_2_TABLES);
  });

  it('повторный запуск ничего не меняет и не трогает данные', () => {
    const db = useMigratedDb();
    insertChat(db, { replyJid: PN_A });

    runMigrations(db);

    expect(userVersion(db)).toBe(1);
    expect(db.prepare('SELECT count(*) FROM chats').pluck().get()).toBe(1);
  });

  it('схема новее кода: явная ошибка, база не меняется', () => {
    const db = useMemoryDb();
    db.pragma('user_version = 99');

    expect(() => {
      runMigrations(db);
    }).toThrow(/99/);
    expect(userVersion(db)).toBe(99);
    expect(tableNames(db)).toEqual([]);
  });

  it('сбой миграции откатывает её целиком, версия не растёт', () => {
    const db = useMemoryDb();
    db.exec('CREATE TABLE known_chats (x INTEGER)');

    expect(() => {
      runMigrations(db);
    }).toThrow(/known_chats/);
    expect(userVersion(db)).toBe(0);
    expect(tableNames(db)).toEqual(['known_chats']);
  });

  it('файл базы после переоткрытия остаётся на версии 1', () => {
    const dir = useTempDir();
    const path = join(dir.path, 'tanbala.db');
    const first = dir.track(openDatabase(path));
    runMigrations(first);
    first.close();

    const second = dir.track(openDatabase(path));
    runMigrations(second);

    expect(userVersion(second)).toBe(1);
    expect(tableNames(second)).toEqual(STAGE_2_TABLES);
  });
});

describe('схема версии 1', () => {
  it('новый чат по умолчанию ведёт бот, статус не менялся, интерес холодный', () => {
    const db = useMigratedDb();
    const id = insertChat(db, { replyJid: PN_A });

    const row = db
      .prepare(
        'SELECT status, status_by, status_changed_at, interest_level FROM chats WHERE id = ?',
      )
      .get(id);

    expect(row).toEqual({
      status: 'bot',
      status_by: null,
      status_changed_at: null,
      interest_level: 'cold',
    });
  });

  it.each([
    ['статус вне списка', "UPDATE chats SET status = 'robot'"],
    ['менеджер без автора смены', "UPDATE chats SET status = 'manager'"],
    [
      'бот, которого включил не панель',
      "UPDATE chats SET status_by = 'phone', status_changed_at = 1",
    ],
    ['автор смены без времени', "UPDATE chats SET status_by = 'panel'"],
    ['время смены без автора', 'UPDATE chats SET status_changed_at = 1'],
    ['уровень интереса вне списка', "UPDATE chats SET interest_level = 'lukewarm'"],
    ['время дробным числом', 'UPDATE chats SET created_at = 1.5'],
    ['время текстом', "UPDATE chats SET last_inbound_at = 'вчера'"],
    [
      'автор сообщения вне списка',
      "INSERT INTO messages (chat_id, wa_id, author, kind, text, ts_ms) VALUES (1, 'W1', 'system', 'text', 'x', 1)",
    ],
    [
      'вид сообщения вне списка',
      "INSERT INTO messages (chat_id, wa_id, author, kind, text, ts_ms) VALUES (1, 'W1', 'client', 'image', NULL, 1)",
    ],
    [
      'источник известного чата вне списка',
      "INSERT INTO known_chats (jid, last_activity_ms, source) VALUES ('x@lid', 1, 'contacts')",
    ],
  ])('отклоняет: %s', (_label, sql) => {
    const db = useMigratedDb();
    insertChat(db, { replyJid: PN_A });

    expect(() => db.prepare(sql).run()).toThrow();
  });

  it('статус менеджера с автором и временем и возврат боту из панели допустимы', () => {
    const db = useMigratedDb();
    const id = insertChat(db, { replyJid: PN_A });

    db.prepare(
      "UPDATE chats SET status = 'manager', status_by = 'phone', status_changed_at = 5 WHERE id = ?",
    ).run(id);
    db.prepare("UPDATE chats SET status = 'bot', status_by = 'panel' WHERE id = ?").run(id);

    expect(db.prepare('SELECT status, status_by FROM chats').get()).toEqual({
      status: 'bot',
      status_by: 'panel',
    });
  });

  it('адреса чата уникальны, а пустые lid_jid и pn_jid не мешают друг другу', () => {
    const db = useMigratedDb();
    insertChat(db, { replyJid: PN_A, pnJid: PN_A, lidJid: LID_A });
    insertChat(db, { replyJid: 'other-1@lid' as typeof LID_A });
    insertChat(db, { replyJid: 'other-2@lid' as typeof LID_A });

    expect(errorOf(() => insertChat(db, { replyJid: PN_A }))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_UNIQUE',
    });
    expect(
      errorOf(() => insertChat(db, { replyJid: 'other-3@lid' as typeof LID_A, lidJid: LID_A })),
    ).toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
    expect(
      errorOf(() => insertChat(db, { replyJid: 'other-4@lid' as typeof LID_A, pnJid: PN_A })),
    ).toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
  });

  it('один waId в чате только раз', () => {
    const db = useMigratedDb();
    const id = insertChat(db, { replyJid: PN_A });
    const insert = db.prepare(
      "INSERT INTO messages (chat_id, wa_id, author, kind, text, ts_ms) VALUES (?, 'W1', 'client', 'text', 'x', 1)",
    );
    insert.run(id);

    expect(errorOf(() => insert.run(id))).toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
  });

  it('сообщение и отметка простоя только для существующего чата', () => {
    const db = useMigratedDb();

    expect(
      errorOf(() =>
        db
          .prepare(
            "INSERT INTO messages (chat_id, wa_id, author, kind, text, ts_ms) VALUES (404, 'W1', 'client', 'text', 'x', 1)",
          )
          .run(),
      ),
    ).toMatchObject({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
    expect(
      errorOf(() =>
        db.prepare('INSERT INTO backlog_chats (chat_id, marked_at_ms) VALUES (404, 1)').run(),
      ),
    ).toMatchObject({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
  });

  it('известный чат не требует строки в chats: чаты вне списка тоже запоминаются', () => {
    const db = useMigratedDb();

    db.prepare(
      "INSERT INTO known_chats (jid, last_activity_ms, source) VALUES ('x@lid', 1, 'history')",
    ).run();

    expect(db.prepare('SELECT count(*) FROM known_chats').pluck().get()).toBe(1);
  });
});
