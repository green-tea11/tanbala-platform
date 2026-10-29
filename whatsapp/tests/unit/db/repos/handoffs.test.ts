import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createUnitOfWork } from '../../../../src/db/connection.js';
import { createChatsRepo } from '../../../../src/db/repos/chats.js';
import { createHandoffsRepo } from '../../../../src/db/repos/handoffs.js';
import type { HandoffsRepo } from '../../../../src/domain/ports.js';
import type { ChatId, HandoffReason, InterestLevel } from '../../../../src/domain/types.js';
import { errorOf, insertChat, LID_A, PN_A, useMigratedDb } from '../fixture.js';

const T0 = 1_761_400_000_000;

interface Setup {
  readonly db: Database.Database;
  readonly chatId: ChatId;
  readonly otherChatId: ChatId;
  readonly repo: HandoffsRepo;
}

function setup(): Setup {
  const db = useMigratedDb();
  return {
    db,
    chatId: insertChat(db, { replyJid: PN_A }),
    otherChatId: insertChat(db, { replyJid: LID_A }),
    repo: createHandoffsRepo(db),
  };
}

function rows(db: Database.Database): unknown[] {
  return db
    .prepare(
      'SELECT chat_id, reason, level, snapshot, opened_at_ms, resolved_at_ms FROM handoffs ORDER BY id',
    )
    .all();
}

function open(repo: HandoffsRepo, chatId: ChatId, nowMs = T0, snapshot = 'снимок'): boolean {
  return repo.open(chatId, 'hot', 'hot', snapshot, nowMs);
}

describe('createHandoffsRepo: open', () => {
  it('открывает передачу с причиной, уровнем, снимком и временем; закрытия ещё нет', () => {
    const { db, chatId, repo } = setup();

    const opened = repo.open(chatId, 'no_answer', 'warm', 'Бизнес: склад одежды', T0);

    expect(opened).toBe(true);
    expect(rows(db)).toEqual([
      {
        chat_id: chatId,
        reason: 'no_answer',
        level: 'warm',
        snapshot: 'Бизнес: склад одежды',
        opened_at_ms: T0,
        resolved_at_ms: null,
      },
    ]);
  });

  it('вторая открытая передача того же чата: false, первая остаётся как была, дублей нет', () => {
    const { db, chatId, repo } = setup();
    repo.open(chatId, 'hot', 'hot', 'первый снимок', T0);

    const again = repo.open(chatId, 'complaint', 'cold', 'второй снимок', T0 + 1000);

    expect(again).toBe(false);
    expect(rows(db)).toEqual([
      expect.objectContaining({ reason: 'hot', level: 'hot', snapshot: 'первый снимок' }),
    ]);
    expect(repo.findOpen(chatId)).toEqual({ reason: 'hot', level: 'hot', openedAtMs: T0 });
  });

  it('у каждого чата своя открытая передача', () => {
    const { db, chatId, otherChatId, repo } = setup();

    expect(open(repo, chatId)).toBe(true);
    expect(open(repo, otherChatId)).toBe(true);
    expect(rows(db)).toHaveLength(2);
  });

  it('после закрытия открывается новая, история остаётся', () => {
    const { db, chatId, repo } = setup();
    open(repo, chatId, T0);
    repo.resolve(chatId, T0 + 1000);

    const reopened = repo.open(chatId, 'asked_human', 'warm', 'новый снимок', T0 + 2000);

    expect(reopened).toBe(true);
    expect(rows(db)).toEqual([
      expect.objectContaining({ reason: 'hot', opened_at_ms: T0, resolved_at_ms: T0 + 1000 }),
      expect.objectContaining({
        reason: 'asked_human',
        opened_at_ms: T0 + 2000,
        resolved_at_ms: null,
      }),
    ]);
    expect(repo.findOpen(chatId)).toEqual({
      reason: 'asked_human',
      level: 'warm',
      openedAtMs: T0 + 2000,
    });
  });

  it.each([
    ['пустой', ''],
    ['с кавычками и SQL', "'); DROP TABLE handoffs; --"],
    ['с эмодзи и переводами строк', 'Бизнес 🧵\nПлощадь: 300 м²\r\nҚазақша: сәлем'],
    ['очень длинный', 'я'.repeat(200_000)],
  ])('снимок %s сохраняется как есть', (_label, snapshot) => {
    const { db, chatId, repo } = setup();

    expect(open(repo, chatId, T0, snapshot)).toBe(true);
    expect(db.prepare('SELECT snapshot FROM handoffs').pluck().get()).toBe(snapshot);
  });

  it.each([-1, 1.5, Number.NaN])('неверное время %s: RangeError, ничего не пишется', (nowMs) => {
    const { db, chatId, repo } = setup();

    expect(() => open(repo, chatId, nowMs)).toThrow(RangeError);
    expect(rows(db)).toEqual([]);
  });

  it('несуществующий чат: ошибка внешнего ключа, а не тихий false', () => {
    const { repo } = setup();

    expect(errorOf(() => open(repo, 404 as ChatId))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
    });
  });

  it.each([
    ['причина', 'spam', 'hot'],
    ['уровень', 'hot', 'lukewarm'],
  ])('неверная %s: ошибка базы, а не тихий false', (_label, reason, level) => {
    const { db, chatId, repo } = setup();

    const error = errorOf(() =>
      repo.open(chatId, reason as HandoffReason, level as InterestLevel, 'снимок', T0),
    );

    expect(error).toMatchObject({ code: 'SQLITE_CONSTRAINT_CHECK' });
    expect(rows(db)).toEqual([]);
  });
});

describe('createHandoffsRepo: findOpen', () => {
  it('нет передачи, чужой чат, закрытая передача: null', () => {
    const { chatId, otherChatId, repo } = setup();
    expect(repo.findOpen(chatId)).toBeNull();

    open(repo, chatId);
    expect(repo.findOpen(otherChatId)).toBeNull();

    repo.resolve(chatId, T0 + 1);
    expect(repo.findOpen(chatId)).toBeNull();
  });

  it.each([
    ['причина', "UPDATE handoffs SET reason = 'spam'", /причин/],
    ['уровень', "UPDATE handoffs SET level = 'lukewarm'", /уровень/],
  ])('испорченная %s в базе: явная ошибка, а не догадка', (_label, sql, message) => {
    const { db, chatId, repo } = setup();
    open(repo, chatId);
    db.pragma('ignore_check_constraints = ON');
    db.prepare(sql).run();

    expect(() => repo.findOpen(chatId)).toThrow(message);
  });
});

describe('createHandoffsRepo: resolve', () => {
  it('закрывает открытую передачу временем возврата; строка остаётся в истории', () => {
    const { db, chatId, repo } = setup();
    open(repo, chatId, T0);

    repo.resolve(chatId, T0 + 5000);

    expect(repo.findOpen(chatId)).toBeNull();
    expect(rows(db)).toEqual([expect.objectContaining({ resolved_at_ms: T0 + 5000 })]);
  });

  it('закрывает только свой чат', () => {
    const { chatId, otherChatId, repo } = setup();
    open(repo, chatId);
    open(repo, otherChatId);

    repo.resolve(chatId, T0 + 1);

    expect(repo.findOpen(otherChatId)).not.toBeNull();
  });

  it('нет открытой передачи: ничего не происходит, закрытая не меняется', () => {
    const { db, chatId, repo } = setup();
    repo.resolve(chatId, T0);
    expect(rows(db)).toEqual([]);

    open(repo, chatId, T0);
    repo.resolve(chatId, T0 + 1000);
    repo.resolve(chatId, T0 + 9000);

    expect(rows(db)).toEqual([expect.objectContaining({ resolved_at_ms: T0 + 1000 })]);
  });

  it('часы ушли назад: закрытие не раньше открытия, возврат чата боту не падает', () => {
    const { db, chatId, repo } = setup();
    open(repo, chatId, T0);

    repo.resolve(chatId, T0 - 60_000);

    expect(rows(db)).toEqual([expect.objectContaining({ opened_at_ms: T0, resolved_at_ms: T0 })]);
  });

  it.each([-1, 1.5, Number.NaN])(
    'неверное время %s: RangeError, передача остаётся открытой',
    (nowMs) => {
      const { chatId, repo } = setup();
      open(repo, chatId);

      expect(() => {
        repo.resolve(chatId, nowMs);
      }).toThrow(RangeError);
      expect(repo.findOpen(chatId)).not.toBeNull();
    },
  );
});

describe('createHandoffsRepo: в одной транзакции со сменой статуса чата', () => {
  const manager = { status: 'manager', by: 'bot' } as const;

  it('успех: передача открыта и статус manager записаны вместе', () => {
    const { db, chatId, repo } = setup();
    const chats = createChatsRepo(db);

    createUnitOfWork(db).run(() => {
      expect(repo.open(chatId, 'hot', 'hot', 'снимок', T0)).toBe(true);
      chats.setStatus(chatId, manager, T0);
    });

    expect(repo.findOpen(chatId)).not.toBeNull();
    expect(chats.getById(chatId)?.control).toEqual(manager);
  });

  it('сбой после открытия откатывает и передачу, и статус', () => {
    const { db, chatId, repo } = setup();
    const chats = createChatsRepo(db);

    expect(() =>
      createUnitOfWork(db).run(() => {
        repo.open(chatId, 'hot', 'hot', 'снимок', T0);
        chats.setStatus(404 as ChatId, manager, T0);
      }),
    ).toThrow(/404/);

    expect(repo.findOpen(chatId)).toBeNull();
    expect(chats.getById(chatId)?.control).toEqual({ status: 'bot', by: null });
  });

  it('повторная передача в транзакции возвращает false, статус не нужно менять второй раз', () => {
    const { db, chatId, repo } = setup();
    open(repo, chatId, T0);

    const second = createUnitOfWork(db).run(() =>
      repo.open(chatId, 'hot', 'hot', 'снимок', T0 + 1),
    );

    expect(second).toBe(false);
    expect(rows(db)).toHaveLength(1);
  });
});
