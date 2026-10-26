import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createMessagesRepo } from '../../../../src/db/repos/messages.js';
import type { ChatId, NewMessage, WaMessageId } from '../../../../src/domain/types.js';
import { errorOf, insertChat, LID_A, PN_A, useMigratedDb } from '../fixture.js';

function setup(): { db: Database.Database; chatId: ChatId; otherChatId: ChatId } {
  const db = useMigratedDb();
  return {
    db,
    chatId: insertChat(db, { replyJid: PN_A }),
    otherChatId: insertChat(db, { replyJid: LID_A }),
  };
}

function textMessage(chatId: ChatId, waId = 'WA-1'): NewMessage {
  return {
    chatId,
    waId: waId as WaMessageId,
    author: 'client',
    kind: 'text',
    text: 'Здравствуйте',
    tsMs: 1_761_400_000_000,
  };
}

function storedRows(db: Database.Database): unknown[] {
  return db
    .prepare('SELECT chat_id, wa_id, author, kind, text, ts_ms FROM messages ORDER BY id')
    .all();
}

describe('createMessagesRepo: insertIfNew', () => {
  it('записывает новое сообщение и возвращает true', () => {
    const { db, chatId } = setup();

    expect(createMessagesRepo(db).insertIfNew(textMessage(chatId))).toBe(true);
    expect(storedRows(db)).toEqual([
      {
        chat_id: chatId,
        wa_id: 'WA-1',
        author: 'client',
        kind: 'text',
        text: 'Здравствуйте',
        ts_ms: 1_761_400_000_000,
      },
    ]);
  });

  it('повтор того же waId в том же чате: false и без второй строки', () => {
    const { db, chatId } = setup();
    const repo = createMessagesRepo(db);
    repo.insertIfNew(textMessage(chatId));

    expect(repo.insertIfNew({ ...textMessage(chatId), text: 'другой текст' })).toBe(false);
    expect(storedRows(db)).toHaveLength(1);
  });

  it('тот же waId в другом чате записывается', () => {
    const { db, chatId, otherChatId } = setup();
    const repo = createMessagesRepo(db);
    repo.insertIfNew(textMessage(chatId));

    expect(repo.insertIfNew(textMessage(otherChatId))).toBe(true);
    expect(storedRows(db)).toHaveLength(2);
  });

  it('голосовое без расшифровки хранится с text NULL', () => {
    const { db, chatId } = setup();

    const inserted = createMessagesRepo(db).insertIfNew({
      ...textMessage(chatId),
      kind: 'voice',
      text: null,
    });

    expect(inserted).toBe(true);
    expect(storedRows(db)).toEqual([expect.objectContaining({ kind: 'voice', text: null })]);
  });

  it('несуществующий чат: ошибка внешнего ключа, а не тихий false', () => {
    const { db } = setup();

    expect(
      errorOf(() => createMessagesRepo(db).insertIfNew(textMessage(404 as ChatId))),
    ).toMatchObject({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
  });

  it('недопустимый автор: ошибка базы, а не тихий false', () => {
    const { db, chatId } = setup();
    const broken = { ...textMessage(chatId), author: 'system' } as unknown as NewMessage;

    expect(errorOf(() => createMessagesRepo(db).insertIfNew(broken))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_CHECK',
    });
  });

  it.each([-1, 1.5, Number.NaN])('отклоняет неверное время %s', (tsMs) => {
    const { db, chatId } = setup();

    expect(() => createMessagesRepo(db).insertIfNew({ ...textMessage(chatId), tsMs })).toThrow(
      RangeError,
    );
    expect(storedRows(db)).toEqual([]);
  });
});

const T = 1_761_400_000_000;

/** Сообщение в истории: время задаётся смещением от T, по умолчанию входящее клиента с текстом = waId. */
function message(
  chatId: ChatId,
  waId: string,
  offsetMs: number,
  overrides: Partial<NewMessage> = {},
): NewMessage {
  return { ...textMessage(chatId, waId), tsMs: T + offsetMs, text: waId, ...overrides };
}

describe('createMessagesRepo: recent', () => {
  it('последние limit сообщений чата по времени, старые первыми, с автором и видом', () => {
    const { db, chatId, otherChatId } = setup();
    const repo = createMessagesRepo(db);
    repo.insertIfNew(message(chatId, 'W1', 0));
    repo.insertIfNew(message(chatId, 'W2', 1000, { author: 'bot' }));
    repo.insertIfNew(message(chatId, 'W3', 2000, { kind: 'voice', text: null }));
    repo.insertIfNew(message(otherChatId, 'X1', 3000));

    const idOf = (waId: string): unknown =>
      db.prepare('SELECT id FROM messages WHERE wa_id = ?').pluck().get(waId);

    const recent = repo.recent(chatId, 2);

    expect(recent).toEqual([
      { id: idOf('W2'), chatId, author: 'bot', kind: 'text', text: 'W2', tsMs: T + 1000 },
      { id: idOf('W3'), chatId, author: 'client', kind: 'voice', text: null, tsMs: T + 2000 },
    ]);
  });

  it('порядок по времени сообщения, а не по записи; при равном времени по записи', () => {
    const { db, chatId } = setup();
    const repo = createMessagesRepo(db);
    repo.insertIfNew(message(chatId, 'LATE', 5000));
    repo.insertIfNew(message(chatId, 'EARLY', 0));
    repo.insertIfNew(message(chatId, 'SAME-1', 2000));
    repo.insertIfNew(message(chatId, 'SAME-2', 2000));

    expect(repo.recent(chatId, 10).map((stored) => stored.text)).toEqual([
      'EARLY',
      'SAME-1',
      'SAME-2',
      'LATE',
    ]);
  });

  it('limit 0 и пустой чат: пустой список', () => {
    const { db, chatId } = setup();
    const repo = createMessagesRepo(db);

    expect(repo.recent(chatId, 10)).toEqual([]);
    repo.insertIfNew(message(chatId, 'W1', 0));
    expect(repo.recent(chatId, 0)).toEqual([]);
  });

  it.each([-1, 1.5, Number.NaN])(
    'неверный limit %s: RangeError (в SQLite -1 значит «без лимита»)',
    (limit) => {
      const { db, chatId } = setup();

      expect(() => createMessagesRepo(db).recent(chatId, limit)).toThrow(RangeError);
    },
  );

  it.each([
    ['автор', "UPDATE messages SET author = 'system'", /автор/],
    ['вид', "UPDATE messages SET kind = 'image'", /вид/],
  ])('испорченный %s в базе: явная ошибка', (_label, sql, error) => {
    const { db, chatId } = setup();
    const repo = createMessagesRepo(db);
    repo.insertIfNew(message(chatId, 'W1', 0));
    db.pragma('ignore_check_constraints = ON');
    db.prepare(sql).run();

    expect(() => repo.recent(chatId, 10)).toThrow(error);
  });
});

describe('createMessagesRepo: isUnansweredInbound и markAnswered', () => {
  it('новое входящее клиента не отвечено; сообщения бота и человека входящими не считаются', () => {
    const { db, chatId } = setup();
    const repo = createMessagesRepo(db);
    repo.insertIfNew(message(chatId, 'C1', 0));
    repo.insertIfNew(message(chatId, 'B1', 1000, { author: 'bot' }));
    repo.insertIfNew(message(chatId, 'H1', 2000, { author: 'human_phone' }));

    expect(repo.isUnansweredInbound(chatId, 'C1' as WaMessageId)).toBe(true);
    expect(repo.isUnansweredInbound(chatId, 'B1' as WaMessageId)).toBe(false);
    expect(repo.isUnansweredInbound(chatId, 'H1' as WaMessageId)).toBe(false);
  });

  it('неизвестный waId или сообщение другого чата: false', () => {
    const { db, chatId, otherChatId } = setup();
    const repo = createMessagesRepo(db);
    repo.insertIfNew(message(otherChatId, 'X1', 0));

    expect(repo.isUnansweredInbound(chatId, 'X1' as WaMessageId)).toBe(false);
    expect(repo.isUnansweredInbound(chatId, 'NONE' as WaMessageId)).toBe(false);
  });

  it('markAnswered отмечает входящие чата, записанные до upToWaId включительно; более поздние ждут ответа', () => {
    const { db, chatId, otherChatId } = setup();
    const repo = createMessagesRepo(db);
    repo.insertIfNew(message(chatId, 'C1', 0));
    repo.insertIfNew(message(chatId, 'C2', 1000));
    repo.insertIfNew(message(chatId, 'C3', 2000));
    repo.insertIfNew(message(otherChatId, 'X1', 0));

    repo.markAnswered(chatId, 'C2' as WaMessageId);

    expect(repo.isUnansweredInbound(chatId, 'C1' as WaMessageId)).toBe(false);
    expect(repo.isUnansweredInbound(chatId, 'C2' as WaMessageId)).toBe(false);
    expect(repo.isUnansweredInbound(chatId, 'C3' as WaMessageId)).toBe(true);
    expect(repo.isUnansweredInbound(otherChatId, 'X1' as WaMessageId)).toBe(true);
  });

  it('markAnswered с неизвестным waId ничего не отмечает', () => {
    const { db, chatId } = setup();
    const repo = createMessagesRepo(db);
    repo.insertIfNew(message(chatId, 'C1', 0));

    repo.markAnswered(chatId, 'NONE' as WaMessageId);

    expect(repo.isUnansweredInbound(chatId, 'C1' as WaMessageId)).toBe(true);
  });
});

describe('createMessagesRepo: setTranscript', () => {
  function voice(chatId: ChatId, waId: string): NewMessage {
    return { ...textMessage(chatId, waId), kind: 'voice', text: null };
  }

  it('расшифровка пишется в голосовое без текста: вид остаётся voice, recent отдаёт текст', () => {
    const { db, chatId } = setup();
    const repo = createMessagesRepo(db);
    repo.insertIfNew(voice(chatId, 'V1'));

    expect(repo.setTranscript(chatId, 'V1' as WaMessageId, 'Сколько стоит учёт?')).toBe(true);
    expect(repo.recent(chatId, 10)).toEqual([
      expect.objectContaining({ kind: 'voice', text: 'Сколько стоит учёт?' }),
    ]);
  });

  it('текст уже есть, не голосовое, другой чат или неизвестный waId: false, ничего не меняется', () => {
    const { db, chatId, otherChatId } = setup();
    const repo = createMessagesRepo(db);
    repo.insertIfNew(voice(chatId, 'V1'));
    repo.setTranscript(chatId, 'V1' as WaMessageId, 'первая');
    repo.insertIfNew(textMessage(chatId, 'T1'));

    expect(repo.setTranscript(chatId, 'V1' as WaMessageId, 'вторая')).toBe(false);
    expect(repo.setTranscript(chatId, 'T1' as WaMessageId, 'расшифровка')).toBe(false);
    expect(repo.setTranscript(otherChatId, 'V1' as WaMessageId, 'чужой чат')).toBe(false);
    expect(repo.setTranscript(chatId, 'NONE' as WaMessageId, 'нет такого')).toBe(false);
    expect(storedRows(db)).toEqual([
      expect.objectContaining({ wa_id: 'V1', kind: 'voice', text: 'первая' }),
      expect.objectContaining({ wa_id: 'T1', kind: 'text', text: 'Здравствуйте' }),
    ]);
  });
});
