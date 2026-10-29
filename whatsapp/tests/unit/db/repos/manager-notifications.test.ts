import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createManagerNotificationsRepo } from '../../../../src/db/repos/manager-notifications.js';
import type { ManagerNotificationsRepo } from '../../../../src/domain/ports.js';
import type {
  ChatId,
  ManagerNotification,
  ManagerNotificationStatus,
  WaMessageId,
} from '../../../../src/domain/types.js';
import { errorOf, insertChat, LID_A, PN_A, useMigratedDb } from '../fixture.js';

const T0 = 1_761_400_000_000;
const MINUTE = 60_000;

interface Setup {
  readonly db: Database.Database;
  readonly chatId: ChatId;
  readonly otherChatId: ChatId;
  readonly repo: ManagerNotificationsRepo;
}

function setup(): Setup {
  const db = useMigratedDb();
  return {
    db,
    chatId: insertChat(db, { replyJid: PN_A }),
    otherChatId: insertChat(db, { replyJid: LID_A }),
    repo: createManagerNotificationsRepo(db),
  };
}

/** Добавляет уведомление о передаче; время создания задаётся смещением от T0. */
function addHandoff(
  repo: ManagerNotificationsRepo,
  chatId: ChatId,
  offsetMs = 0,
  text = 'Передача',
): number {
  return repo.add({ kind: 'handoff', chatId, text, nowMs: T0 + offsetMs });
}

function finish(
  repo: ManagerNotificationsRepo,
  id: number,
  status: Exclude<ManagerNotificationStatus, 'pending'>,
  offsetMs = 0,
  waId: WaMessageId | null = null,
): void {
  repo.setResult(id, { status, waId }, T0 + offsetMs);
}

/** Сколько раз уведомление уже пробовали отправить неудачно. */
function failTimes(repo: ManagerNotificationsRepo, id: number, times: number): void {
  for (let attempt = 1; attempt <= times; attempt += 1) finish(repo, id, 'failed', attempt);
}

const RETRY = { maxAttempts: 5, staleBeforeMs: T0 + 10 * MINUTE, limit: 100 };

function ids(list: readonly ManagerNotification[]): number[] {
  return list.map((notification) => notification.id);
}

describe('createManagerNotificationsRepo: add', () => {
  it('пишет уведомление со статусом pending и нулём попыток, текст целиком', () => {
    const { chatId, repo } = setup();

    const id = repo.add({ kind: 'limit', chatId, text: 'Лимит\nвторая строка', nowMs: T0 });

    expect(repo.latestForChat(chatId)).toEqual({
      id,
      kind: 'limit',
      chatId,
      text: 'Лимит\nвторая строка',
      status: 'pending',
      attempts: 0,
      createdAtMs: T0,
      updatedAtMs: T0,
    });
  });

  it('возвращает числовой id, каждое следующее больше', () => {
    const { chatId, repo } = setup();

    const first = addHandoff(repo, chatId);
    const second = addHandoff(repo, chatId, 1);

    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(Number.isSafeInteger(second)).toBe(true);
  });

  it('список чатов простоя пишется без чата', () => {
    const { repo } = setup();

    const id = repo.add({ kind: 'backlog', chatId: null, text: 'Простой: 3 чата', nowMs: T0 });

    expect(repo.listRecent({ limit: 10, offset: 0 })).toEqual([
      expect.objectContaining({ id, kind: 'backlog', chatId: null, status: 'pending' }),
    ]);
  });

  it.each([
    ['передача без чата', 'handoff', null],
    ['лимит без чата', 'limit', null],
    ['список простоя с чатом', 'backlog', 1],
  ] as const)('отклоняет: %s', (_label, kind, chatId) => {
    const { db, repo } = setup();

    const error = errorOf(() =>
      repo.add({ kind, chatId: chatId as ChatId | null, text: 'текст', nowMs: T0 }),
    );

    expect(error).toMatchObject({ code: 'SQLITE_CONSTRAINT_CHECK' });
    expect(db.prepare('SELECT count(*) FROM manager_notifications').pluck().get()).toBe(0);
  });

  it('несуществующий чат: ошибка внешнего ключа', () => {
    const { repo } = setup();

    expect(errorOf(() => addHandoff(repo, 404 as ChatId))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
    });
  });

  it.each([
    ['пустой', ''],
    ['с кавычками и SQL', "'); DROP TABLE manager_notifications; --"],
    ['с эмодзи и казахскими буквами', 'Клиент 🧵 Әйгерім ұсынды: қызық'],
    ['очень длинный', 'я'.repeat(200_000)],
  ])('текст %s сохраняется как есть', (_label, text) => {
    const { chatId, repo } = setup();

    addHandoff(repo, chatId, 0, text);

    expect(repo.latestForChat(chatId)?.text).toBe(text);
  });

  it.each([-1, 1.5, Number.NaN])('неверное время %s: RangeError, ничего не пишется', (nowMs) => {
    const { chatId, repo } = setup();

    expect(() => repo.add({ kind: 'handoff', chatId, text: 'текст', nowMs })).toThrow(RangeError);
    expect(repo.countAll()).toBe(0);
  });
});

describe('createManagerNotificationsRepo: setResult', () => {
  it('sent: статус, ID сообщения, попытка засчитана, время обновления сдвинуто, создания нет', () => {
    const { db, chatId, repo } = setup();
    const id = addHandoff(repo, chatId);

    finish(repo, id, 'sent', 5000, 'OUT-1' as WaMessageId);

    expect(repo.latestForChat(chatId)).toMatchObject({
      status: 'sent',
      attempts: 1,
      createdAtMs: T0,
      updatedAtMs: T0 + 5000,
    });
    expect(db.prepare('SELECT wa_id FROM manager_notifications').pluck().get()).toBe('OUT-1');
  });

  it.each(['no_manager', 'skipped_limit', 'failed'] as const)(
    '%s: статус записан, ID сообщения пуст, попытка засчитана',
    (status) => {
      const { db, chatId, repo } = setup();
      const id = addHandoff(repo, chatId);

      finish(repo, id, status, 1000);

      expect(repo.latestForChat(chatId)).toMatchObject({ status, attempts: 1 });
      expect(db.prepare('SELECT wa_id FROM manager_notifications').pluck().get()).toBeNull();
    },
  );

  it('каждый итог добавляет попытку: сбой, сбой, затем успех', () => {
    const { chatId, repo } = setup();
    const id = addHandoff(repo, chatId);

    finish(repo, id, 'failed', 1000);
    finish(repo, id, 'failed', 2000);
    finish(repo, id, 'sent', 3000, 'OUT-3' as WaMessageId);

    expect(repo.latestForChat(chatId)).toMatchObject({ status: 'sent', attempts: 3 });
  });

  it('меняет только своё уведомление', () => {
    const { chatId, otherChatId, repo } = setup();
    const id = addHandoff(repo, chatId);
    addHandoff(repo, otherChatId);

    finish(repo, id, 'sent', 1, 'OUT-1' as WaMessageId);

    expect(repo.latestForChat(otherChatId)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('статус pending итогом не бывает: RangeError, запись не меняется', () => {
    const { chatId, repo } = setup();
    const id = addHandoff(repo, chatId);

    expect(() => {
      repo.setResult(id, { status: 'pending' as 'sent', waId: null }, T0 + 1);
    }).toThrow(RangeError);
    expect(repo.latestForChat(chatId)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('неизвестное уведомление: явная ошибка', () => {
    const { repo } = setup();

    expect(() => {
      finish(repo, 404, 'sent');
    }).toThrow(/404/);
  });

  it.each([-1, 1.5, Number.NaN])('неверное время %s: RangeError, запись не меняется', (nowMs) => {
    const { chatId, repo } = setup();
    const id = addHandoff(repo, chatId);

    expect(() => {
      repo.setResult(id, { status: 'failed', waId: null }, nowMs);
    }).toThrow(RangeError);
    expect(repo.latestForChat(chatId)).toMatchObject({ status: 'pending', attempts: 0 });
  });
});

describe('createManagerNotificationsRepo: listRetryable', () => {
  it('failed с попытками меньше предела берётся, на пределе нет', () => {
    const { chatId, repo } = setup();
    const oneAttempt = addHandoff(repo, chatId, 0);
    const lastChance = addHandoff(repo, chatId, 1);
    const exhausted = addHandoff(repo, chatId, 2);
    failTimes(repo, oneAttempt, 1);
    failTimes(repo, lastChance, 4);
    failTimes(repo, exhausted, 5);

    expect(ids(repo.listRetryable(RETRY))).toEqual([oneAttempt, lastChance]);
  });

  it('failed берётся независимо от свежести: срок staleBeforeMs относится только к pending', () => {
    const { chatId, repo } = setup();
    const justFailed = addHandoff(repo, chatId, 0);
    finish(repo, justFailed, 'failed', 20 * MINUTE);
    addHandoff(repo, chatId, 20 * MINUTE);

    expect(ids(repo.listRetryable(RETRY))).toEqual([justFailed]);
  });

  it('зависший pending берётся, свежий нет; граница staleBeforeMs включается', () => {
    const { chatId, repo } = setup();
    const stale = addHandoff(repo, chatId, 0);
    const onBoundary = addHandoff(repo, chatId, 10 * MINUTE);
    addHandoff(repo, chatId, 10 * MINUTE + 1);

    expect(ids(repo.listRetryable(RETRY))).toEqual([stale, onBoundary]);
  });

  it.each(['sent', 'no_manager', 'skipped_limit'] as const)(
    '%s повторно не отправляется',
    (status) => {
      const { chatId, repo } = setup();
      const id = addHandoff(repo, chatId);
      finish(repo, id, status, 1, status === 'sent' ? ('OUT-1' as WaMessageId) : null);

      expect(repo.listRetryable(RETRY)).toEqual([]);
    },
  );

  it('зависший pending с исчерпанными попытками не берётся', () => {
    const { db, chatId, repo } = setup();
    addHandoff(repo, chatId);
    db.prepare('UPDATE manager_notifications SET attempts = 5').run();

    expect(repo.listRetryable(RETRY)).toEqual([]);
  });

  it('старые первыми (по созданию, при равенстве по id), не больше limit', () => {
    const { chatId, repo } = setup();
    const newer = addHandoff(repo, chatId, 2000);
    const olderFirst = addHandoff(repo, chatId, 1000);
    const olderSecond = addHandoff(repo, chatId, 1000);
    const oldest = addHandoff(repo, chatId, 0);
    [newer, olderFirst, olderSecond, oldest].forEach((id) => {
      failTimes(repo, id, 1);
    });

    expect(ids(repo.listRetryable(RETRY))).toEqual([oldest, olderFirst, olderSecond, newer]);
    expect(ids(repo.listRetryable({ ...RETRY, limit: 2 }))).toEqual([oldest, olderFirst]);
    expect(repo.listRetryable({ ...RETRY, limit: 0 })).toEqual([]);
  });

  it('отдаёт уведомления целиком: вид, чат, текст, статус, попытки, времена', () => {
    const { chatId, repo } = setup();
    const id = addHandoff(repo, chatId, 0, 'Горячий клиент');
    failTimes(repo, id, 2);

    expect(repo.listRetryable(RETRY)).toEqual([
      {
        id,
        kind: 'handoff',
        chatId,
        text: 'Горячий клиент',
        status: 'failed',
        attempts: 2,
        createdAtMs: T0,
        updatedAtMs: T0 + 2,
      },
    ]);
  });

  it('список простоя без чата тоже повторяется', () => {
    const { repo } = setup();
    const id = repo.add({ kind: 'backlog', chatId: null, text: 'Простой', nowMs: T0 });
    finish(repo, id, 'failed', 1);

    expect(repo.listRetryable(RETRY)).toEqual([expect.objectContaining({ id, chatId: null })]);
  });

  it.each([
    ['maxAttempts', { maxAttempts: -1 }],
    ['maxAttempts', { maxAttempts: 1.5 }],
    ['limit', { limit: -1 }],
    ['limit', { limit: Number.NaN }],
    ['staleBeforeMs', { staleBeforeMs: -1 }],
    ['staleBeforeMs', { staleBeforeMs: Number.NaN }],
  ])('неверный %s: RangeError', (_name, override) => {
    const { repo } = setup();

    expect(() => repo.listRetryable({ ...RETRY, ...override })).toThrow(RangeError);
  });
});

describe('createManagerNotificationsRepo: listRecent и countAll', () => {
  it('новые сверху; при равном времени создания сначала поздняя запись', () => {
    const { chatId, repo } = setup();
    const oldest = addHandoff(repo, chatId, 0);
    const sameFirst = addHandoff(repo, chatId, 1000);
    const sameSecond = addHandoff(repo, chatId, 1000);
    const newest = addHandoff(repo, chatId, 2000);

    expect(ids(repo.listRecent({ limit: 10, offset: 0 }))).toEqual([
      newest,
      sameSecond,
      sameFirst,
      oldest,
    ]);
  });

  it('страницы идут подряд без пропусков и повторов; за концом пусто', () => {
    const { chatId, repo } = setup();
    const created = Array.from({ length: 5 }, (_unused, index) => addHandoff(repo, chatId, index));
    const expected = [...created].reverse();

    expect(ids(repo.listRecent({ limit: 2, offset: 0 }))).toEqual(expected.slice(0, 2));
    expect(ids(repo.listRecent({ limit: 2, offset: 2 }))).toEqual(expected.slice(2, 4));
    expect(ids(repo.listRecent({ limit: 2, offset: 4 }))).toEqual(expected.slice(4));
    expect(repo.listRecent({ limit: 2, offset: 6 })).toEqual([]);
    expect(repo.listRecent({ limit: 0, offset: 0 })).toEqual([]);
  });

  it('показывает все виды и статусы, в том числе без чата', () => {
    const { chatId, repo } = setup();
    const handoff = addHandoff(repo, chatId, 0);
    const limit = repo.add({ kind: 'limit', chatId, text: 'Лимит', nowMs: T0 + 1 });
    repo.add({ kind: 'backlog', chatId: null, text: 'Простой', nowMs: T0 + 2 });
    finish(repo, handoff, 'sent', 10, 'OUT-1' as WaMessageId);
    finish(repo, limit, 'no_manager', 11);

    expect(
      repo.listRecent({ limit: 10, offset: 0 }).map(({ kind, status }) => [kind, status]),
    ).toEqual([
      ['backlog', 'pending'],
      ['limit', 'no_manager'],
      ['handoff', 'sent'],
    ]);
  });

  it('countAll считает все уведомления; пусто: 0', () => {
    const { chatId, repo } = setup();
    expect(repo.countAll()).toBe(0);

    const first = addHandoff(repo, chatId);
    repo.add({ kind: 'backlog', chatId: null, text: 'Простой', nowMs: T0 });
    finish(repo, first, 'sent', 1, 'OUT-1' as WaMessageId);

    expect(repo.countAll()).toBe(2);
  });

  it.each([
    ['limit', { limit: -1, offset: 0 }],
    ['limit', { limit: 1.5, offset: 0 }],
    ['offset', { limit: 10, offset: -1 }],
    ['offset', { limit: 10, offset: Number.NaN }],
  ])('неверный %s: RangeError', (_name, query) => {
    const { repo } = setup();

    expect(() => repo.listRecent(query)).toThrow(RangeError);
  });

  it.each([
    ['вид', "UPDATE manager_notifications SET kind = 'spam'", /вид/],
    ['статус', "UPDATE manager_notifications SET status = 'lost'", /статус/],
  ])('испорченный %s в базе: явная ошибка, а не догадка', (_label, sql, message) => {
    const { db, chatId, repo } = setup();
    addHandoff(repo, chatId);
    db.pragma('ignore_check_constraints = ON');
    db.prepare(sql).run();

    expect(() => repo.listRecent({ limit: 10, offset: 0 })).toThrow(message);
  });

  it('много уведомлений: 5000 штук листаются страницами по 50 без потерь и повторов', () => {
    const { db, chatId, repo } = setup();
    db.transaction(() => {
      for (let index = 0; index < 5000; index += 1) addHandoff(repo, chatId, index);
    })();

    const seen: number[] = [];
    for (let offset = 0; offset < 5000; offset += 50) {
      seen.push(...ids(repo.listRecent({ limit: 50, offset })));
    }

    expect(repo.countAll()).toBe(5000);
    expect(new Set(seen).size).toBe(5000);
    expect(seen).toEqual([...seen].sort((left, right) => right - left));
  });
});

describe('createManagerNotificationsRepo: latestForChat', () => {
  it('нет уведомлений: null', () => {
    const { chatId, repo } = setup();

    expect(repo.latestForChat(chatId)).toBeNull();
  });

  it('последнее по созданию именно этого чата, любого вида и статуса', () => {
    const { chatId, otherChatId, repo } = setup();
    addHandoff(repo, chatId, 0, 'старое');
    const latest = repo.add({ kind: 'limit', chatId, text: 'новое', nowMs: T0 + 1000 });
    addHandoff(repo, otherChatId, 5000, 'чужое');
    repo.add({ kind: 'backlog', chatId: null, text: 'простой', nowMs: T0 + 9000 });
    finish(repo, latest, 'failed', 2000);

    expect(repo.latestForChat(chatId)).toMatchObject({
      id: latest,
      kind: 'limit',
      text: 'новое',
      status: 'failed',
    });
    expect(repo.latestForChat(otherChatId)?.text).toBe('чужое');
  });

  it('при равном времени создания берётся поздняя запись', () => {
    const { chatId, repo } = setup();
    addHandoff(repo, chatId, 1000, 'первая');
    const second = addHandoff(repo, chatId, 1000, 'вторая');

    expect(repo.latestForChat(chatId)?.id).toBe(second);
  });

  it('последнее определяется временем создания, а не обновления: повтор старого его не вытесняет', () => {
    const { chatId, repo } = setup();
    const older = addHandoff(repo, chatId, 0, 'старое');
    const newer = addHandoff(repo, chatId, 1000, 'новое');
    finish(repo, older, 'sent', 9000, 'OUT-1' as WaMessageId);

    expect(repo.latestForChat(chatId)?.id).toBe(newer);
    expect(ids(repo.listRecent({ limit: 10, offset: 0 }))).toEqual([newer, older]);
  });
});
