import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/db/connection.js';
import { runMigrations } from '../../../src/db/migrations.js';
import { HANDOFF_REASONS, LEVELS } from '../../../src/db/values.js';
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

const STAGE_3_TABLES = [...STAGE_2_TABLES, 'api_usage', 'outbound_ids'].sort();

const CURRENT_TABLES = [
  'api_usage',
  'app_state',
  'backlog_chats',
  'chat_companies',
  'chats',
  'client_profiles',
  'handoffs',
  'known_chats',
  'manager_notifications',
  'messages',
  'outbound_ids',
  'pairing_attempts',
  'rejected_drafts',
];

/** Таблицы до определения компании клиента: схема версии 5. */
const VERSION_5_TABLES = CURRENT_TABLES.filter(
  (name) => name !== 'chat_companies' && name !== 'rejected_drafts',
);

/**
 * Последняя версия схемы: этап 2 дал версию 1, этап 3 версию 2, этапы 4, 5 и 6 версии 3, 4 и 5, определение
 * компании клиента версию 6, минимум для передачи по цене версию 7, заметка для бота версию 8, отметка «у менеджера»
 * при переходе в рабочий режим (этап 8) версию 9, отклонённые черновики для панели версию 10, шире квалификация клиента версию 11, пометки «вероятно» версию 12.
 */
const CURRENT_VERSION = 12;

function columnNames(db: Database.Database, table: string): unknown[] {
  return db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').pluck().all(table);
}

describe('runMigrations', () => {
  it('новая база получает последнюю версию и ровно таблицы текущей схемы', () => {
    const db = useMemoryDb();

    runMigrations(db);

    expect(userVersion(db)).toBe(CURRENT_VERSION);
    expect(tableNames(db)).toEqual(CURRENT_TABLES);
  });

  it('повторный запуск ничего не меняет и не трогает данные', () => {
    const db = useMigratedDb();
    insertChat(db, { replyJid: PN_A });

    runMigrations(db);

    expect(userVersion(db)).toBe(CURRENT_VERSION);
    expect(db.prepare('SELECT count(*) FROM chats').pluck().get()).toBe(1);
  });

  it('база этапа 2 (версия 1) переходит на текущую версию, переписка сохраняется неотвеченной', () => {
    const db = useMemoryDb();
    runMigrations(db, 1);
    expect(tableNames(db)).toEqual(STAGE_2_TABLES);
    const chatId = insertChat(db, { replyJid: PN_A });
    db.prepare(
      "INSERT INTO messages (chat_id, wa_id, author, kind, text, ts_ms) VALUES (?, 'W1', 'client', 'text', 'x', 1)",
    ).run(chatId);

    runMigrations(db);

    expect(userVersion(db)).toBe(CURRENT_VERSION);
    expect(tableNames(db)).toEqual(CURRENT_TABLES);
    expect(db.prepare('SELECT chat_id, wa_id, answered FROM messages').all()).toEqual([
      { chat_id: chatId, wa_id: 'W1', answered: 0 },
    ]);
  });

  it('живая база этапа 3 (версия 2) переходит на текущую: данные на месте, новые таблицы пустые', () => {
    const db = useMemoryDb();
    runMigrations(db, 2);
    expect(tableNames(db)).toEqual(STAGE_3_TABLES);
    const chatId = insertChat(db, { replyJid: PN_A, pushName: 'Айгерим' });
    db.prepare(
      "INSERT INTO messages (chat_id, wa_id, author, kind, text, ts_ms) VALUES (?, 'W1', 'client', 'text', 'x', 1)",
    ).run(chatId);

    runMigrations(db);

    expect(userVersion(db)).toBe(CURRENT_VERSION);
    expect(tableNames(db)).toEqual(CURRENT_TABLES);
    expect(db.prepare('SELECT id, push_name, interest_level FROM chats').all()).toEqual([
      { id: chatId, push_name: 'Айгерим', interest_level: 'cold' },
    ]);
    expect(db.prepare('SELECT count(*) FROM messages').pluck().get()).toBe(1);
    for (const table of [
      'client_profiles',
      'handoffs',
      'manager_notifications',
      'chat_companies',
    ]) {
      expect(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
    }
  });

  it('живая база версии 5 переходит на версию 6: чаты и переписка на месте, состояние компании пустое', () => {
    const db = useMemoryDb();
    runMigrations(db, 5);
    expect(userVersion(db)).toBe(5);
    expect(tableNames(db)).toEqual(VERSION_5_TABLES);
    const chatId = insertChat(db, { replyJid: PN_A, pushName: 'Айгерим' });
    db.prepare(
      "INSERT INTO messages (chat_id, wa_id, author, kind, text, ts_ms) VALUES (?, 'W1', 'client', 'text', 'x', 1)",
    ).run(chatId);

    runMigrations(db);

    expect(userVersion(db)).toBe(CURRENT_VERSION);
    expect(tableNames(db)).toEqual(CURRENT_TABLES);
    expect(db.prepare('SELECT id, push_name FROM chats').all()).toEqual([
      { id: chatId, push_name: 'Айгерим' },
    ]);
    expect(db.prepare('SELECT count(*) FROM messages').pluck().get()).toBe(1);
    expect(db.prepare('SELECT count(*) FROM chat_companies').pluck().get()).toBe(0);
  });

  it('сбой версии 6 откатывает только её: база остаётся на версии 5 с данными', () => {
    const db = useMemoryDb();
    runMigrations(db, 5);
    insertChat(db, { replyJid: PN_A });
    db.exec('CREATE TABLE chat_companies (x INTEGER)');

    expect(() => {
      runMigrations(db);
    }).toThrow(/chat_companies/);
    expect(userVersion(db)).toBe(5);
    expect(db.prepare('SELECT count(*) FROM chats').pluck().get()).toBe(1);
  });

  it('сбой версии 2 откатывает только её: база остаётся на версии 1 с данными', () => {
    const db = useMemoryDb();
    runMigrations(db, 1);
    insertChat(db, { replyJid: PN_A });
    db.exec('CREATE TABLE outbound_ids (x INTEGER)');

    expect(() => {
      runMigrations(db);
    }).toThrow(/outbound_ids/);
    expect(userVersion(db)).toBe(1);
    expect(db.prepare('SELECT count(*) FROM chats').pluck().get()).toBe(1);
    expect(
      db.prepare('SELECT name FROM pragma_table_info(?)').pluck().all('messages'),
    ).not.toContain('answered');
  });

  it('сбой версии 4 откатывает и версию 3 из того же запуска: база остаётся на версии 2', () => {
    const db = useMemoryDb();
    runMigrations(db, 2);
    insertChat(db, { replyJid: PN_A });
    db.exec('CREATE TABLE handoffs (x INTEGER)');

    expect(() => {
      runMigrations(db);
    }).toThrow(/handoffs/);
    expect(userVersion(db)).toBe(2);
    expect(db.prepare('SELECT count(*) FROM chats').pluck().get()).toBe(1);
    expect(tableNames(db)).not.toContain('client_profiles');
    expect(tableNames(db)).not.toContain('manager_notifications');
  });

  it.each([-1, 1.5, CURRENT_VERSION + 1])(
    'неверная целевая версия %s: RangeError, база не меняется',
    (target) => {
      const db = useMemoryDb();

      expect(() => {
        runMigrations(db, target);
      }).toThrow(RangeError);
      expect(userVersion(db)).toBe(0);
    },
  );

  it('каждая промежуточная версия поднимается отдельно: 3, затем 4, 5 и 6', () => {
    const db = useMemoryDb();

    runMigrations(db, 3);
    expect(tableNames(db)).toContain('client_profiles');
    expect(tableNames(db)).not.toContain('handoffs');

    runMigrations(db, 4);
    expect(tableNames(db)).toContain('handoffs');
    expect(tableNames(db)).toContain('manager_notifications');
    expect(userVersion(db)).toBe(4);

    runMigrations(db, 5);
    expect(userVersion(db)).toBe(5);
    expect(tableNames(db)).not.toContain('chat_companies');

    runMigrations(db, 6);
    expect(userVersion(db)).toBe(6);
    expect(tableNames(db)).toContain('chat_companies');
    expect(columnNames(db, 'chats')).not.toContain('price_asks');

    runMigrations(db, 7);
    expect(userVersion(db)).toBe(7);
    expect(columnNames(db, 'chats')).toContain('price_asks');
    expect(columnNames(db, 'chats')).not.toContain('bot_note');

    runMigrations(db, 8);
    expect(userVersion(db)).toBe(8);
    expect(columnNames(db, 'chats')).toContain('bot_note');
    expect(columnNames(db, 'known_chats')).not.toContain('held_for_manager');

    runMigrations(db, 9);
    expect(userVersion(db)).toBe(9);
    expect(columnNames(db, 'known_chats')).toContain('held_for_manager');
    expect(tableNames(db)).not.toContain('rejected_drafts');

    runMigrations(db, 10);
    expect(userVersion(db)).toBe(10);
    expect(tableNames(db)).toContain('rejected_drafts');
    expect(columnNames(db, 'client_profiles')).not.toContain('material');

    runMigrations(db, 11);
    expect(userVersion(db)).toBe(11);
    expect(columnNames(db, 'client_profiles')).toEqual(
      expect.arrayContaining([
        'items',
        'packaging',
        'material',
        'city',
        'premises',
        'turnover',
        'current_tracking',
      ]),
    );
    expect(columnNames(db, 'client_profiles')).not.toContain('inferred');

    runMigrations(db, 12);
    expect(userVersion(db)).toBe(CURRENT_VERSION);
    expect(columnNames(db, 'client_profiles')).toContain('inferred');
  });

  it('живая база версии 9 переходит на текущую: выжимка на месте, новые поля пустые, пометок нет', () => {
    const db = useMemoryDb();
    runMigrations(db, 9);
    const chatId = insertChat(db, { replyJid: PN_A });
    db.prepare(
      "INSERT INTO client_profiles (chat_id, business, has_1c, reason, updated_at_ms) VALUES (?, 'склад', 1, 'r', 1)",
    ).run(chatId);

    runMigrations(db);

    expect(
      db
        .prepare(
          'SELECT business, has_1c, items, material, city, premises, inferred FROM client_profiles WHERE chat_id = ?',
        )
        .get(chatId),
    ).toEqual({
      business: 'склад',
      has_1c: 1,
      items: null,
      material: null,
      city: null,
      premises: null,
      inferred: '[]',
    });
  });

  it.each([8, 9])(
    'живая база версии %i переходит на 10: чаты на месте, отклонённых черновиков нет',
    (from) => {
      const db = useMemoryDb();
      runMigrations(db, from);
      const chatId = insertChat(db, { replyJid: PN_A });

      runMigrations(db);

      expect(userVersion(db)).toBe(CURRENT_VERSION);
      expect(db.prepare('SELECT id FROM chats').pluck().all()).toEqual([chatId]);
      expect(db.prepare('SELECT count(*) FROM rejected_drafts').pluck().get()).toBe(0);
    },
  );

  it('живая база версии 8 переходит на версию 9: известные чаты на месте, ни один не отмечен', () => {
    const db = useMemoryDb();
    runMigrations(db, 8);
    db.prepare(
      `INSERT INTO known_chats (jid, last_activity_ms, source)
       VALUES ('x@lid', 1000, 'history'), ('77000000001@s.whatsapp.net', 2000, 'message')`,
    ).run();

    runMigrations(db);

    expect(userVersion(db)).toBe(CURRENT_VERSION);
    expect(
      db
        .prepare(
          'SELECT jid, last_activity_ms, source, held_for_manager FROM known_chats ORDER BY jid',
        )
        .all(),
    ).toEqual([
      {
        jid: '77000000001@s.whatsapp.net',
        last_activity_ms: 2000,
        source: 'message',
        held_for_manager: 0,
      },
      { jid: 'x@lid', last_activity_ms: 1000, source: 'history', held_for_manager: 0 },
    ]);
  });

  it('живая база версии 6 переходит сразу на 8: заметки нет', () => {
    const db = useMemoryDb();
    runMigrations(db, 6);
    const chatId = insertChat(db, { replyJid: PN_A });

    runMigrations(db);

    expect(userVersion(db)).toBe(CURRENT_VERSION);
    expect(
      db.prepare('SELECT bot_note, bot_note_at_ms FROM chats WHERE id = ?').get(chatId),
    ).toEqual({ bot_note: null, bot_note_at_ms: null });
  });

  it('живая база версии 6 переходит на версию 7: чат и выжимка на месте, счётчик цены и отказ по нулям', () => {
    const db = useMemoryDb();
    runMigrations(db, 6);
    const chatId = insertChat(db, { replyJid: PN_A, pushName: 'Айгерим' });
    db.prepare(
      `INSERT INTO client_profiles (chat_id, business, has_1c, reason, updated_at_ms)
       VALUES (?, 'склад', 1, 'причина', 5)`,
    ).run(chatId);

    runMigrations(db);

    expect(userVersion(db)).toBe(CURRENT_VERSION);
    expect(tableNames(db)).toEqual(CURRENT_TABLES);
    expect(
      db.prepare('SELECT id, push_name, price_asks, refused_answers FROM chats').all(),
    ).toEqual([{ id: chatId, push_name: 'Айгерим', price_asks: 0, refused_answers: 0 }]);
    expect(
      db.prepare('SELECT business, has_1c, one_c_name, problem_agreed FROM client_profiles').all(),
    ).toEqual([{ business: 'склад', has_1c: 1, one_c_name: null, problem_agreed: 0 }]);
  });

  it('сбой версии 7 откатывает только её: база остаётся на версии 6 с данными', () => {
    const db = useMemoryDb();
    runMigrations(db, 6);
    insertChat(db, { replyJid: PN_A });
    db.exec('ALTER TABLE chats ADD COLUMN refused_answers INTEGER');

    expect(() => {
      runMigrations(db);
    }).toThrow(/refused_answers/);
    expect(userVersion(db)).toBe(6);
    expect(columnNames(db, 'client_profiles')).not.toContain('one_c_name');
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

  it('файл базы после переоткрытия остаётся на текущей версии', () => {
    const dir = useTempDir();
    const path = join(dir.path, 'tanbala.db');
    const first = dir.track(openDatabase(path));
    runMigrations(first);
    first.close();

    const second = dir.track(openDatabase(path));
    runMigrations(second);

    expect(userVersion(second)).toBe(CURRENT_VERSION);
    expect(tableNames(second)).toEqual(CURRENT_TABLES);
  });
});

describe('индексы этапов 5 и 6', () => {
  it('все созданы: передачи, уведомления (чат, время, повторы) и сообщения для панели', () => {
    const db = useMigratedDb();

    const names = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .pluck()
      .all();

    expect(names).toEqual(
      expect.arrayContaining([
        'handoffs_chat',
        'handoffs_one_open_per_chat',
        'manager_notifications_chat',
        'manager_notifications_created',
        'manager_notifications_retry',
        'messages_chat_ts',
      ]),
    );
  });
});

describe('схема версии 10: отклонённые черновики', () => {
  const INSERT = `INSERT INTO rejected_drafts (chat_id, attempt, source, draft, remarks, at_ms)
    VALUES (?, ?, ?, 'черновик', '["цена"]', 1000)`;

  it.each<[number, string, string | undefined]>([
    [1, 'code', undefined],
    [2, 'review', undefined],
    [3, 'code', 'SQLITE_CONSTRAINT_CHECK'],
    [0, 'review', 'SQLITE_CONSTRAINT_CHECK'],
    [1, 'price', 'SQLITE_CONSTRAINT_CHECK'],
  ])('попытка %i и источник %s: ошибка %s', (attempt, source, code) => {
    const db = useMigratedDb();
    const chatId = insertChat(db, { replyJid: PN_A });

    const error = errorOf(() => db.prepare(INSERT).run(chatId, attempt, source));

    expect(code === undefined ? error : (error as { code?: string } | undefined)?.code).toBe(code);
  });

  it('черновик только для существующего чата', () => {
    const db = useMigratedDb();

    const error = errorOf(() => db.prepare(INSERT).run(999, 1, 'code'));

    expect((error as { code?: string } | undefined)?.code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
  });

  it('индексы по чату и по времени (чистка старше 30 дней) созданы', () => {
    const db = useMigratedDb();

    const names = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'rejected_drafts'",
      )
      .pluck()
      .all();

    expect(names).toEqual(expect.arrayContaining(['rejected_drafts_chat', 'rejected_drafts_at']));
  });
});

describe('схема версии 9: отметка «у менеджера» при переходе в рабочий режим', () => {
  it.each<[number, string | undefined]>([
    [0, undefined],
    [1, undefined],
    [2, 'SQLITE_CONSTRAINT_CHECK'],
  ])('значение %j: ошибка %s', (held, code) => {
    const db = useMigratedDb();

    const error = errorOf(() =>
      db
        .prepare(
          "INSERT INTO known_chats (jid, last_activity_ms, source, held_for_manager) VALUES ('x@lid', 1, 'history', ?)",
        )
        .run(held),
    );

    expect(code === undefined ? error : (error as { code?: string } | undefined)?.code).toBe(code);
  });
});

describe('схема версии 8: заметка для бота', () => {
  it.each<[string | null, number | null, string | undefined]>([
    ['узнай число вещей', 1, undefined],
    [null, null, undefined],
    ['без времени', null, 'SQLITE_CONSTRAINT_CHECK'],
    [null, 1, 'SQLITE_CONSTRAINT_CHECK'],
  ])('текст %j и время %j: ошибка %s', (note, atMs, code) => {
    const db = useMigratedDb();
    const chatId = insertChat(db, { replyJid: PN_A });

    const error = errorOf(() =>
      db
        .prepare('UPDATE chats SET bot_note = ?, bot_note_at_ms = ? WHERE id = ?')
        .run(note, atMs, chatId),
    );

    expect(code === undefined ? error : (error as { code?: string } | undefined)?.code).toBe(code);
  });
});

describe('схема версии 7: минимум для передачи по цене', () => {
  it.each([
    ['chats', 'price_asks', -1],
    ['chats', 'refused_answers', 2],
  ])('%s.%s = %s отклоняется', (table, column, value) => {
    const db = useMigratedDb();
    const chatId = insertChat(db, { replyJid: PN_A });

    expect(
      errorOf(() =>
        db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(value, chatId),
      ),
    ).toMatchObject({ code: 'SQLITE_CONSTRAINT_CHECK' });
  });

  it.each<[unknown, string | undefined]>([
    [0, undefined],
    [1, undefined],
    [2, 'SQLITE_CONSTRAINT_CHECK'],
    [null, 'SQLITE_CONSTRAINT_NOTNULL'],
  ])('client_profiles.problem_agreed = %s: ошибка %s', (value, code) => {
    const db = useMigratedDb();
    const chatId = insertChat(db, { replyJid: PN_A });

    const error = errorOf(() =>
      db
        .prepare(
          `INSERT INTO client_profiles (chat_id, reason, updated_at_ms, problem_agreed)
           VALUES (?, 'причина', 1, ?)`,
        )
        .run(chatId, value),
    );

    expect(code === undefined ? error : (error as { code?: string } | undefined)?.code).toBe(code);
  });
});

describe('схема версии 6: chat_companies', () => {
  const insertState = (
    db: Database.Database,
    chatId: number,
    overrides: Readonly<Record<string, unknown>> = {},
  ): void => {
    db.prepare(
      'INSERT INTO chat_companies (chat_id, state, updated_at) VALUES (@chatId, @state, @updatedAt)',
    ).run({ chatId, state: '{}', updatedAt: 1, ...overrides });
  };

  it('состояние одно на чат: вторая строка того же чата отклоняется, у другого чата своя', () => {
    const db = useMigratedDb();
    const first = insertChat(db, { replyJid: PN_A });
    const second = insertChat(db, { replyJid: LID_A });
    insertState(db, first);

    expect(errorOf(() => insertState(db, first))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_PRIMARYKEY',
    });
    expect(errorOf(() => insertState(db, second))).toBeUndefined();
  });

  it('состояние только для существующего чата', () => {
    const db = useMigratedDb();

    expect(errorOf(() => insertState(db, 404))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
    });
  });

  it.each([
    ['состояние', { state: null }],
    ['время записи', { updatedAt: null }],
  ])('%s обязательно', (_label, overrides) => {
    const db = useMigratedDb();
    const chatId = insertChat(db, { replyJid: PN_A });

    expect(errorOf(() => insertState(db, chatId, overrides))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_NOTNULL',
    });
  });

  it('время записи строго число: текст отклоняется', () => {
    const db = useMigratedDb();
    const chatId = insertChat(db, { replyJid: PN_A });

    expect(errorOf(() => insertState(db, chatId, { updatedAt: 'вчера' }))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_DATATYPE',
    });
  });

  it('удаление чата удаляет его состояние, состояние других чатов остаётся', () => {
    const db = useMigratedDb();
    const removed = insertChat(db, { replyJid: PN_A });
    const kept = insertChat(db, { replyJid: LID_A });
    insertState(db, removed);
    insertState(db, kept);

    db.prepare('DELETE FROM chats WHERE id = ?').run(removed);

    expect(db.prepare('SELECT chat_id FROM chat_companies').pluck().all()).toEqual([kept]);
  });
});

describe('схема версии 5 (этап 6)', () => {
  it('индекс сообщений по чату и времени создан: последнее сообщение и страницы переписки для панели', () => {
    const db = useMigratedDb();

    expect(
      db
        .prepare("SELECT name FROM pragma_index_info('messages_chat_ts') ORDER BY seqno")
        .pluck()
        .all(),
    ).toEqual(['chat_id', 'ts_ms']);
  });
});

describe('схема версии 4 (этап 5): handoffs', () => {
  const insertHandoff = (
    db: Database.Database,
    values: {
      chatId: number;
      reason?: string;
      level?: string;
      openedAt?: number;
      resolvedAt?: number | null;
    },
  ): void => {
    db.prepare(
      `INSERT INTO handoffs (chat_id, reason, level, snapshot, opened_at_ms, resolved_at_ms)
       VALUES (@chatId, @reason, @level, 'снимок', @openedAt, @resolvedAt)`,
    ).run({
      chatId: values.chatId,
      reason: values.reason ?? 'hot',
      level: values.level ?? 'hot',
      openedAt: values.openedAt ?? 10,
      resolvedAt: values.resolvedAt ?? null,
    });
  };

  it('открытая передача одна на чат: вторая открытая отклоняется, у другого чата своя', () => {
    const db = useMigratedDb();
    const first = insertChat(db, { replyJid: PN_A });
    const second = insertChat(db, { replyJid: LID_A });
    insertHandoff(db, { chatId: first });

    expect(errorOf(() => insertHandoff(db, { chatId: first, reason: 'complaint' }))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_UNIQUE',
    });
    expect(errorOf(() => insertHandoff(db, { chatId: second }))).toBeUndefined();
  });

  it('закрытых передач у чата может быть сколько угодно, и после них открывается новая', () => {
    const db = useMigratedDb();
    const chatId = insertChat(db, { replyJid: PN_A });

    insertHandoff(db, { chatId, openedAt: 10, resolvedAt: 20 });
    insertHandoff(db, { chatId, openedAt: 30, resolvedAt: 40 });
    insertHandoff(db, { chatId, openedAt: 50 });

    expect(db.prepare('SELECT count(*) FROM handoffs').pluck().get()).toBe(3);
  });

  it.each([
    ['причина вне списка', { reason: 'spam' }],
    ['уровень вне списка', { level: 'lukewarm' }],
    ['закрытие раньше открытия', { openedAt: 20, resolvedAt: 10 }],
  ])('отклоняет: %s', (_label, values) => {
    const db = useMigratedDb();
    const chatId = insertChat(db, { replyJid: PN_A });

    expect(errorOf(() => insertHandoff(db, { chatId, ...values }))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_CHECK',
    });
  });

  it.each([...HANDOFF_REASONS])(
    'причина %s допустима (список в коде и CHECK совпадают)',
    (reason) => {
      const db = useMigratedDb();
      const chatId = insertChat(db, { replyJid: PN_A });

      expect(errorOf(() => insertHandoff(db, { chatId, reason }))).toBeUndefined();
    },
  );

  it.each([...LEVELS])('уровень %s допустим (список в коде и CHECK совпадают)', (level) => {
    const db = useMigratedDb();
    const chatId = insertChat(db, { replyJid: PN_A });

    expect(errorOf(() => insertHandoff(db, { chatId, level }))).toBeUndefined();
  });

  it('передача только для существующего чата', () => {
    const db = useMigratedDb();

    expect(errorOf(() => insertHandoff(db, { chatId: 404 }))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
    });
  });

  it('снимок обязателен', () => {
    const db = useMigratedDb();
    const chatId = insertChat(db, { replyJid: PN_A });

    expect(
      errorOf(() =>
        db
          .prepare(
            `INSERT INTO handoffs (chat_id, reason, level, snapshot, opened_at_ms)
             VALUES (?, 'hot', 'hot', NULL, 1)`,
          )
          .run(chatId),
      ),
    ).toMatchObject({ code: 'SQLITE_CONSTRAINT_NOTNULL' });
  });
});

describe('схема версии 4 (этап 5): manager_notifications', () => {
  const insertNotification = (
    db: Database.Database,
    values: { kind?: string; chatId?: number | null; status?: string; attempts?: number },
  ): void => {
    const chatId = values.chatId === undefined ? 1 : values.chatId;
    db.prepare(
      `INSERT INTO manager_notifications (kind, chat_id, text, status, attempts, created_at_ms, updated_at_ms)
       VALUES (@kind, @chatId, 'текст', @status, @attempts, 1, 1)`,
    ).run({
      kind: values.kind ?? 'handoff',
      chatId,
      status: values.status ?? 'pending',
      attempts: values.attempts ?? 0,
    });
  };

  it('по умолчанию pending, ноль попыток, без ID сообщения', () => {
    const db = useMigratedDb();
    insertChat(db, { replyJid: PN_A });

    db.prepare(
      `INSERT INTO manager_notifications (kind, chat_id, text, created_at_ms, updated_at_ms)
       VALUES ('handoff', 1, 'текст', 1, 1)`,
    ).run();

    expect(db.prepare('SELECT status, attempts, wa_id FROM manager_notifications').get()).toEqual({
      status: 'pending',
      attempts: 0,
      wa_id: null,
    });
  });

  it.each([
    ['вид вне списка', { kind: 'spam' }],
    ['статус вне списка', { status: 'lost' }],
    ['отрицательное число попыток', { attempts: -1 }],
    ['передача без чата', { kind: 'handoff', chatId: null }],
    ['лимит без чата', { kind: 'limit', chatId: null }],
    ['список простоя с чатом', { kind: 'backlog', chatId: 1 }],
  ])('отклоняет: %s', (_label, values) => {
    const db = useMigratedDb();
    insertChat(db, { replyJid: PN_A });

    expect(errorOf(() => insertNotification(db, values))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_CHECK',
    });
  });

  it.each(['pending', 'sent', 'no_manager', 'skipped_limit', 'failed'])(
    'статус %s допустим',
    (status) => {
      const db = useMigratedDb();
      insertChat(db, { replyJid: PN_A });

      expect(errorOf(() => insertNotification(db, { status }))).toBeUndefined();
    },
  );

  it('список чатов простоя записывается без чата', () => {
    const db = useMigratedDb();

    expect(
      errorOf(() => insertNotification(db, { kind: 'backlog', chatId: null })),
    ).toBeUndefined();
  });

  it('уведомление только для существующего чата', () => {
    const db = useMigratedDb();

    expect(errorOf(() => insertNotification(db, { chatId: 404 }))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
    });
  });
});

describe('схема версии 3 (этап 4): client_profiles', () => {
  const insertProfile = (
    db: Database.Database,
    chatId: number,
    overrides: Readonly<Record<string, unknown>> = {},
  ): void => {
    db.prepare(
      `INSERT INTO client_profiles
         (chat_id, business, area, scope, item_count, has_1c, problem, specifics, reason, updated_at_ms)
       VALUES (@chatId, @business, @area, @scope, @itemCount, @has1c, @problem, @specifics, @reason, @updatedAtMs)`,
    ).run({
      chatId,
      business: null,
      area: null,
      scope: null,
      itemCount: null,
      has1c: null,
      problem: null,
      specifics: null,
      reason: 'причина',
      updatedAtMs: 1,
      ...overrides,
    });
  };

  it('выжимка 1:1 с чатом: вторая строка того же чата отклоняется', () => {
    const db = useMigratedDb();
    const chatId = insertChat(db, { replyJid: PN_A });
    insertProfile(db, chatId);

    expect(errorOf(() => insertProfile(db, chatId))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_PRIMARYKEY',
    });
  });

  it.each([0, 1, null])('has_1c = %s допустим', (has1c) => {
    const db = useMigratedDb();
    const chatId = insertChat(db, { replyJid: PN_A });

    expect(errorOf(() => insertProfile(db, chatId, { has1c }))).toBeUndefined();
  });

  it('has_1c вне 0 и 1 отклоняется', () => {
    const db = useMigratedDb();
    const chatId = insertChat(db, { replyJid: PN_A });

    expect(errorOf(() => insertProfile(db, chatId, { has1c: 2 }))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_CHECK',
    });
  });

  it('выжимка только для существующего чата', () => {
    const db = useMigratedDb();

    expect(errorOf(() => insertProfile(db, 404))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
    });
  });

  it('причина оценки обязательна, остальные поля выжимки могут быть пустыми', () => {
    const db = useMigratedDb();
    const chatId = insertChat(db, { replyJid: PN_A });

    expect(errorOf(() => insertProfile(db, chatId, { reason: null }))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_NOTNULL',
    });
    expect(errorOf(() => insertProfile(db, chatId))).toBeUndefined();
  });
});

describe('схема версии 2', () => {
  const insertOutbound = (
    db: Database.Database,
    values: { chatId: number | null; origin: string; status?: string },
  ): void => {
    db.prepare(
      `INSERT INTO outbound_ids (wa_id, chat_id, jid, origin, text, status, created_at)
       VALUES ('OUT-1', @chatId, 'x@lid', @origin, 'текст', @status, 1)`,
    ).run({ chatId: values.chatId, origin: values.origin, status: values.status ?? 'pending' });
  };

  it('новое сообщение не отвечено, исходящее по умолчанию pending', () => {
    const db = useMigratedDb();
    const chatId = insertChat(db, { replyJid: PN_A });
    db.prepare(
      "INSERT INTO messages (chat_id, wa_id, author, kind, text, ts_ms) VALUES (?, 'W1', 'client', 'text', 'x', 1)",
    ).run(chatId);
    db.prepare(
      `INSERT INTO outbound_ids (wa_id, chat_id, jid, origin, text, created_at)
       VALUES ('OUT-1', ?, 'x@lid', 'bot_reply', 'текст', 1)`,
    ).run(chatId);

    expect(db.prepare('SELECT answered FROM messages').pluck().get()).toBe(0);
    expect(db.prepare('SELECT status FROM outbound_ids').pluck().get()).toBe('pending');
  });

  it.each([
    ['отметка ответа вне 0 и 1', "UPDATE messages SET answered = 2 WHERE wa_id = 'W1'"],
    [
      'источник исходящего вне списка',
      "INSERT INTO outbound_ids (wa_id, chat_id, jid, origin, text, created_at) VALUES ('O2', 1, 'x@lid', 'spam', 't', 1)",
    ],
    [
      'статус исходящего вне списка',
      "INSERT INTO outbound_ids (wa_id, chat_id, jid, origin, text, status, created_at) VALUES ('O2', 1, 'x@lid', 'bot_reply', 't', 'lost', 1)",
    ],
    [
      'ответ клиенту без чата',
      "INSERT INTO outbound_ids (wa_id, chat_id, jid, origin, text, created_at) VALUES ('O2', NULL, 'x@lid', 'bot_reply', 't', 1)",
    ],
    [
      'уведомление менеджеру с чатом клиента',
      "INSERT INTO outbound_ids (wa_id, chat_id, jid, origin, text, created_at) VALUES ('O2', 1, 'x@lid', 'manager_notify', 't', 1)",
    ],
    [
      'отрицательный счётчик вызовов',
      "INSERT INTO api_usage (day, chat_id, count) VALUES ('2026-10-26', 0, -1)",
    ],
    [
      'отрицательный чат в счётчике',
      "INSERT INTO api_usage (day, chat_id, count) VALUES ('2026-10-26', -1, 1)",
    ],
    [
      'день не в формате ГГГГ-ММ-ДД',
      "INSERT INTO api_usage (day, chat_id, count) VALUES ('26.10.2026', 0, 1)",
    ],
  ])('отклоняет: %s', (_label, sql) => {
    const db = useMigratedDb();
    const chatId = insertChat(db, { replyJid: PN_A });
    db.prepare(
      "INSERT INTO messages (chat_id, wa_id, author, kind, text, ts_ms) VALUES (?, 'W1', 'client', 'text', 'x', 1)",
    ).run(chatId);

    expect(errorOf(() => db.prepare(sql).run())).toMatchObject({ code: 'SQLITE_CONSTRAINT_CHECK' });
  });

  it('исходящее с несуществующим чатом: ошибка внешнего ключа', () => {
    const db = useMigratedDb();

    expect(errorOf(() => insertOutbound(db, { chatId: 404, origin: 'bot_reply' }))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
    });
  });

  it('уведомление менеджеру без чата допустимо; ID исходящего уникален', () => {
    const db = useMigratedDb();
    insertOutbound(db, { chatId: null, origin: 'manager_notify', status: 'sent' });

    expect(
      errorOf(() => insertOutbound(db, { chatId: null, origin: 'manager_notify' })),
    ).toMatchObject({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
  });

  it('счётчик вызовов один на день и чат', () => {
    const db = useMigratedDb();
    const insert = db.prepare(
      "INSERT INTO api_usage (day, chat_id, count) VALUES ('2026-10-26', 0, 1)",
    );
    insert.run();

    expect(errorOf(() => insert.run())).toMatchObject({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
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
