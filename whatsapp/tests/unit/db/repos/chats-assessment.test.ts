import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createUnitOfWork } from '../../../../src/db/connection.js';
import { createChatsRepo } from '../../../../src/db/repos/chats.js';
import type { ChatsRepo } from '../../../../src/domain/ports.js';
import type {
  ChatId,
  ChatIdentity,
  ClientProfile,
  InterestAssessment,
  InterestLevel,
} from '../../../../src/domain/types.js';
import {
  EMPTY_PROFILE,
  errorOf,
  insertChat,
  LID_A,
  PN_A,
  PN_B,
  profileOf,
  useMigratedDb,
} from '../fixture.js';

const T0 = 1_761_400_000_000;
const BOTH: ChatIdentity = { replyJid: PN_A, lidJid: LID_A, pnJid: PN_A };

interface Setup {
  readonly db: Database.Database;
  readonly repo: ChatsRepo;
  readonly chatId: ChatId;
  readonly otherChatId: ChatId;
}

function setup(): Setup {
  const db = useMigratedDb();
  return {
    db,
    repo: createChatsRepo(db),
    chatId: insertChat(db, { replyJid: PN_A, pnJid: PN_A, lidJid: LID_A }),
    otherChatId: insertChat(db, { replyJid: PN_B, pnJid: PN_B }),
  };
}

function assessment(
  level: InterestLevel,
  profile: ClientProfile = profileOf(),
  reason = 'клиент спросил цену',
): InterestAssessment {
  return { level, profile, reason };
}

function profileRows(db: Database.Database): unknown[] {
  return db
    .prepare(
      `SELECT chat_id, business, area, scope, item_count, has_1c, one_c_name, problem, specifics,
         monthly_intake, passages, shelf_recount, problem_agreed, reason, updated_at_ms
       FROM client_profiles ORDER BY chat_id`,
    )
    .all();
}

function levelOf(db: Database.Database, id: ChatId): unknown {
  return db.prepare('SELECT interest_level FROM chats WHERE id = ?').pluck().get(id);
}

describe('createChatsRepo: saveAssessment', () => {
  it('сохраняет уровень и всю выжимку: их отдают getById, findByJid и upsertByIdentity', () => {
    const { repo, chatId } = setup();

    repo.saveAssessment(chatId, assessment('hot'), T0);

    for (const chat of [
      repo.getById(chatId),
      repo.findByJid(PN_A),
      repo.findByJid(LID_A),
      repo.upsertByIdentity(BOTH, null, T0 + 1),
    ]) {
      expect(chat).toMatchObject({ id: chatId, level: 'hot', profile: profileOf() });
    }
  });

  it('кладёт в client_profiles и причину оценки, и время', () => {
    const { db, repo, chatId } = setup();

    repo.saveAssessment(chatId, assessment('warm', profileOf(), 'рассказал о задаче'), T0 + 42);

    expect(profileRows(db)).toEqual([
      {
        chat_id: chatId,
        business: 'Магазин одежды',
        area: '300 м²',
        scope: 'где лежит каждая вещь',
        item_count: 'около 5000 вещей',
        has_1c: 1,
        one_c_name: '1С:Управление торговлей',
        problem: 'пересорт при приёмке',
        specifics: 'два склада',
        monthly_intake: 'около 300 в месяц',
        passages: 'два входа',
        shelf_recount: 'раз в квартал',
        problem_agreed: 1,
        reason: 'рассказал о задаче',
        updated_at_ms: T0 + 42,
      },
    ]);
  });

  it.each([
    [true, 1],
    [false, 0],
    [null, null],
  ] as const)('есть ли 1С: %s хранится как %s и читается обратно', (has1C, stored) => {
    const { db, repo, chatId } = setup();

    repo.saveAssessment(chatId, assessment('warm', profileOf({ has1C })), T0);

    expect(db.prepare('SELECT has_1c FROM client_profiles').pluck().get()).toBe(stored);
    expect(repo.getById(chatId)?.profile.has1C).toBe(has1C);
  });

  it.each([true, false])(
    'согласие, что трудность есть: %s хранится числом и читается обратно',
    (agreed) => {
      const { db, repo, chatId } = setup();

      repo.saveAssessment(chatId, assessment('warm', profileOf({ problemAgreed: agreed })), T0);

      expect(db.prepare('SELECT problem_agreed FROM client_profiles').pluck().get()).toBe(
        agreed ? 1 : 0,
      );
      expect(repo.getById(chatId)?.profile.problemAgreed).toBe(agreed);
    },
  );

  it('пустая выжимка сохраняется и читается пустой, уровень записан', () => {
    const { db, repo, chatId } = setup();

    repo.saveAssessment(chatId, assessment('cold', EMPTY_PROFILE, 'ничего не сказал'), T0);

    expect(repo.getById(chatId)).toMatchObject({ level: 'cold', profile: EMPTY_PROFILE });
    expect(profileRows(db)).toHaveLength(1);
  });

  it('повторная оценка заменяет выжимку целиком и уровень; строка у чата одна', () => {
    const { db, repo, chatId } = setup();
    repo.saveAssessment(chatId, assessment('hot', profileOf(), 'первая'), T0);
    const next = profileOf({ business: 'Аптека', area: null, has1C: null, specifics: null });

    repo.saveAssessment(chatId, assessment('warm', next, 'вторая'), T0 + 1000);

    expect(repo.getById(chatId)).toMatchObject({ level: 'warm', profile: next });
    expect(profileRows(db)).toEqual([
      expect.objectContaining({ business: 'Аптека', reason: 'вторая', updated_at_ms: T0 + 1000 }),
    ]);
  });

  it('оценка одного чата не трогает другой', () => {
    const { db, repo, chatId, otherChatId } = setup();

    repo.saveAssessment(chatId, assessment('hot'), T0);

    expect(repo.getById(otherChatId)).toMatchObject({ level: 'cold', profile: EMPTY_PROFILE });
    expect(levelOf(db, otherChatId)).toBe('cold');
    expect(profileRows(db)).toHaveLength(1);
  });

  it('любые символы клиента сохраняются как есть: кавычки, SQL, эмодзи, казахские буквы, длинный текст', () => {
    const { repo, chatId } = setup();
    const exotic = profileOf({
      business: "'); DROP TABLE client_profiles; --",
      area: 'Площадь 🧵\nвторая строка',
      scope: 'Қазақша: сәлем, ұсыныс',
      problem: 'я'.repeat(100_000),
      specifics: '',
    });

    repo.saveAssessment(chatId, assessment('warm', exotic, 'причина "в кавычках"'), T0);

    expect(repo.getById(chatId)?.profile).toEqual(exotic);
  });

  it('неизвестный чат: явная ошибка, выжимка не записана', () => {
    const { db, repo } = setup();

    expect(() => {
      repo.saveAssessment(404 as ChatId, assessment('hot'), T0);
    }).toThrow(/404/);
    expect(profileRows(db)).toEqual([]);
  });

  it('сбой записи выжимки откатывает и уровень: они пишутся одной транзакцией', () => {
    const { db, repo, chatId } = setup();
    const broken = assessment('hot', profileOf(), null as unknown as string);

    expect(errorOf(() => repo.saveAssessment(chatId, broken, T0))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_NOTNULL',
    });

    expect(levelOf(db, chatId)).toBe('cold');
    expect(profileRows(db)).toEqual([]);
  });

  it('неверный уровень: ошибка CHECK, выжимка не записана', () => {
    const { db, repo, chatId } = setup();

    const error = errorOf(() =>
      repo.saveAssessment(chatId, assessment('lukewarm' as InterestLevel), T0),
    );

    expect(error).toMatchObject({ code: 'SQLITE_CONSTRAINT_CHECK' });
    expect(profileRows(db)).toEqual([]);
  });

  it.each([-1, 1.5, Number.NaN])('неверное время %s: RangeError, ничего не записано', (nowMs) => {
    const { db, repo, chatId } = setup();

    expect(() => {
      repo.saveAssessment(chatId, assessment('hot'), nowMs);
    }).toThrow(RangeError);
    expect(levelOf(db, chatId)).toBe('cold');
    expect(profileRows(db)).toEqual([]);
  });

  it('внутри внешней транзакции оценка откатывается вместе с ней', () => {
    const { db, repo, chatId } = setup();

    expect(() =>
      createUnitOfWork(db).run(() => {
        repo.saveAssessment(chatId, assessment('hot'), T0);
        throw new Error('сбой после оценки');
      }),
    ).toThrow(/сбой после оценки/);

    expect(levelOf(db, chatId)).toBe('cold');
    expect(profileRows(db)).toEqual([]);
  });
});

describe('createChatsRepo: выжимка в Chat', () => {
  it('чат без оценки: выжимка пустая, а не отсутствует', () => {
    const { repo, chatId } = setup();

    expect(repo.getById(chatId)?.profile).toEqual(EMPTY_PROFILE);
  });

  it('испорченное has_1c в базе: явная ошибка, а не догадка', () => {
    const { db, repo, chatId } = setup();
    repo.saveAssessment(chatId, assessment('warm'), T0);
    db.pragma('ignore_check_constraints = ON');
    db.prepare('UPDATE client_profiles SET has_1c = 7').run();

    expect(() => repo.getById(chatId)).toThrow(/1С/);
  });
});

describe('createChatsRepo: пометки «вероятно» (схема 12)', () => {
  it('выведенные поля сохраняются и читаются по порядку выжимки', () => {
    const { repo, chatId } = setup();
    const profile = profileOf({ inferred: ['has1C', 'material'] });

    repo.saveAssessment(chatId, assessment('warm', profile), T0);

    expect(repo.getById(chatId)?.profile.inferred).toEqual(['material', 'has1C']);
  });

  it('испорченные пометки в базе: неизвестные поля и не массив отбрасываются, чат читается', () => {
    const { db, repo, chatId } = setup();
    repo.saveAssessment(chatId, assessment('warm'), T0);

    db.prepare(`UPDATE client_profiles SET inferred = '["city","drop table",7]'`).run();
    expect(repo.getById(chatId)?.profile.inferred).toEqual(['city']);
    db.prepare(`UPDATE client_profiles SET inferred = '{"city":1}'`).run();
    expect(repo.getById(chatId)?.profile.inferred).toEqual([]);
    db.prepare(`UPDATE client_profiles SET inferred = 'не json'`).run();
    expect(repo.getById(chatId)?.profile.inferred).toEqual([]);
  });

  it('слияние чатов: пометки обоих объединяются', () => {
    const db = useMigratedDb();
    const repo = createChatsRepo(db);
    const survivor = repo.upsertByIdentity(
      { replyJid: LID_A, lidJid: LID_A, pnJid: null },
      null,
      T0,
    );
    const absorbed = repo.upsertByIdentity(
      { replyJid: PN_A, lidJid: null, pnJid: PN_A },
      null,
      T0 + 1,
    );
    repo.saveAssessment(survivor.id, assessment('warm', profileOf({ inferred: ['city'] })), T0 + 2);
    repo.saveAssessment(
      absorbed.id,
      assessment('warm', profileOf({ inferred: ['has1C'] })),
      T0 + 3,
    );

    const merged = repo.upsertByIdentity(BOTH, null, T0 + 10);

    expect(merged.profile.inferred).toEqual(['city', 'has1C']);
  });
});
