import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createMessagesRepo } from '../../../../src/db/repos/messages.js';
import type { ChatId, NewMessage, WaMessageId } from '../../../../src/domain/types.js';
import { NotImplementedError } from '../../../../src/shared/todo.js';
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

describe('createMessagesRepo: методы следующих этапов', () => {
  it.each([
    [
      'recent',
      (chatId: ChatId) => (repo: ReturnType<typeof createMessagesRepo>) => repo.recent(chatId, 10),
    ],
    [
      'isUnansweredInbound',
      (chatId: ChatId) => (repo: ReturnType<typeof createMessagesRepo>) =>
        repo.isUnansweredInbound(chatId, 'WA-1' as WaMessageId),
    ],
    [
      'markAnswered',
      (chatId: ChatId) => (repo: ReturnType<typeof createMessagesRepo>) => {
        repo.markAnswered(chatId, 'WA-1' as WaMessageId);
      },
    ],
  ])('%s пока заготовка этапа 3', (name, call) => {
    const { db, chatId } = setup();

    const error = errorOf(() => call(chatId)(createMessagesRepo(db)));

    expect(error).toBeInstanceOf(NotImplementedError);
    expect(error).toMatchObject({ stage: 'этап 3', feature: `db/repos/messages.${name}` });
  });
});
