import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createBacklogRepo } from '../../../../src/db/repos/backlog.js';
import { createChatCompaniesRepo } from '../../../../src/db/repos/chat-companies.js';
import { createChatsRepo } from '../../../../src/db/repos/chats.js';
import { createHandoffsRepo } from '../../../../src/db/repos/handoffs.js';
import { createManagerNotificationsRepo } from '../../../../src/db/repos/manager-notifications.js';
import { createMessagesRepo } from '../../../../src/db/repos/messages.js';
import type { ChatCompaniesRepo } from '../../../../src/domain/company.js';
import type {
  ChatsRepo,
  HandoffsRepo,
  ManagerNotificationsRepo,
} from '../../../../src/domain/ports.js';
import type {
  Chat,
  ChatIdentity,
  ClientProfile,
  Jid,
  WaMessageId,
} from '../../../../src/domain/types.js';
import {
  companyIdOf,
  jobIdOf,
  makeChatCandidate,
  makeConfirmed,
  makeState,
} from '../../company/builders.js';
import { createFakeLogger, type LogEntry } from '../../handoff/fakes.js';
import { EMPTY_PROFILE, insertChat, LID_A, PN_A, profileOf, useMigratedDb } from '../fixture.js';

// Слияние чатов одного человека (адрес @lid и адрес с номером) переносит выжимку, передачи, уведомления менеджеру
// и состояние определения компании.
// Общие правила слияния (история, статус, уровень, отметки простоя) проверяет chats.test.ts.

const T0 = 1_761_400_000_000;
const MERGE_AT = T0 + 100_000;

const LID_ONLY: ChatIdentity = { replyJid: LID_A, lidJid: LID_A, pnJid: null };
const PN_ONLY: ChatIdentity = { replyJid: PN_A, lidJid: null, pnJid: PN_A };
const BOTH: ChatIdentity = { replyJid: LID_A, lidJid: LID_A, pnJid: PN_A };

interface Pair {
  readonly db: Database.Database;
  readonly chats: ChatsRepo;
  readonly handoffs: HandoffsRepo;
  readonly notifications: ManagerNotificationsRepo;
  /** Старший чат: после слияния остаётся он. */
  readonly survivor: Chat;
  /** Младший чат: после слияния исчезает. */
  readonly absorbed: Chat;
}

function pair(): Pair {
  const db = useMigratedDb();
  const chats = createChatsRepo(db);
  const survivor = chats.upsertByIdentity(LID_ONLY, null, T0);
  const absorbed = chats.upsertByIdentity(PN_ONLY, null, T0 + 1);
  return {
    db,
    chats,
    handoffs: createHandoffsRepo(db),
    notifications: createManagerNotificationsRepo(db),
    survivor,
    absorbed,
  };
}

function merge(chats: ChatsRepo): Chat {
  return chats.upsertByIdentity(BOTH, null, MERGE_AT);
}

function save(
  chats: ChatsRepo,
  chat: Chat,
  profile: ClientProfile,
  updatedAtMs: number,
  reason = 'причина',
): void {
  chats.saveAssessment(chat.id, { level: 'warm', profile, reason }, updatedAtMs);
}

function handoffRows(db: Database.Database): unknown[] {
  return db
    .prepare('SELECT chat_id, reason, opened_at_ms, resolved_at_ms FROM handoffs ORDER BY id')
    .all();
}

describe('слияние чатов: ход разговора о цене', () => {
  it('вопросов цены остаётся больше из двух, отказ отвечать сохраняется, если был у любого', () => {
    const { chats, survivor, absorbed } = pair();
    chats.recordTurn(survivor.id, { priceAsked: true, refused: false });
    chats.recordTurn(absorbed.id, { priceAsked: true, refused: true });
    chats.recordTurn(absorbed.id, { priceAsked: true, refused: false });

    const merged = merge(chats);

    expect(chats.getProgress(merged.id)).toEqual({ priceAsks: 2, refused: true });
  });

  it('у слитого чата ничего нет: ход оставшегося не меняется', () => {
    const { chats, survivor } = pair();
    chats.recordTurn(survivor.id, { priceAsked: true, refused: true });

    expect(chats.getProgress(merge(chats).id)).toEqual({ priceAsks: 1, refused: true });
  });
});

describe('слияние чатов: выжимка клиента', () => {
  it('выжимка слитого чата переезжает к оставшемуся, своей строки у слитого не остаётся', () => {
    const { db, chats, survivor, absorbed } = pair();
    save(chats, absorbed, profileOf(), T0 + 10);

    const merged = merge(chats);

    expect(merged).toMatchObject({ id: survivor.id, profile: profileOf() });
    expect(db.prepare('SELECT chat_id FROM client_profiles').pluck().all()).toEqual([survivor.id]);
  });

  it('согласие, что трудность есть, не теряется, даже если свежее оценка без него; какая 1С берётся из любой', () => {
    const { chats, survivor, absorbed } = pair();
    save(chats, survivor, { ...EMPTY_PROFILE, problemAgreed: true }, T0 + 10);
    save(chats, absorbed, { ...EMPTY_PROFILE, has1C: true, oneCName: 'УТ 11' }, T0 + 20);

    expect(merge(chats).profile).toMatchObject({
      problemAgreed: true,
      has1C: true,
      oneCName: 'УТ 11',
    });
  });

  it('выжимка только у оставшегося чата не меняется', () => {
    const { chats, survivor } = pair();
    save(chats, survivor, profileOf({ business: 'Аптека' }), T0 + 10);

    expect(merge(chats).profile).toEqual(profileOf({ business: 'Аптека' }));
  });

  it('у обоих: более свежая оценка важнее по каждому полю, пустые поля берутся из другой', () => {
    const { db, chats, survivor, absorbed } = pair();
    save(
      chats,
      survivor,
      { ...EMPTY_PROFILE, business: 'Склад', area: '100 м²', problem: 'старая задача' },
      T0 + 10,
      'старая причина',
    );
    save(
      chats,
      absorbed,
      { ...EMPTY_PROFILE, area: '200 м²', has1C: true, specifics: 'новое' },
      T0 + 20,
      'новая причина',
    );

    const merged = merge(chats);

    expect(merged.profile).toEqual({
      business: 'Склад',
      area: '200 м²',
      scope: null,
      itemCount: null,
      has1C: true,
      oneCName: null,
      problem: 'старая задача',
      specifics: 'новое',
      problemAgreed: false,
    });
    expect(db.prepare('SELECT reason, updated_at_ms FROM client_profiles').all()).toEqual([
      { reason: 'новая причина', updated_at_ms: T0 + 20 },
    ]);
  });

  it('если свежее оценка оставшегося чата, важнее она', () => {
    const { db, chats, survivor, absorbed } = pair();
    save(chats, survivor, { ...EMPTY_PROFILE, area: '300 м²', has1C: false }, T0 + 50, 'свежая');
    save(
      chats,
      absorbed,
      { ...EMPTY_PROFILE, area: '200 м²', business: 'Склад' },
      T0 + 20,
      'старая',
    );

    expect(merge(chats).profile).toMatchObject({ area: '300 м²', business: 'Склад', has1C: false });
    expect(db.prepare('SELECT reason, updated_at_ms FROM client_profiles').all()).toEqual([
      { reason: 'свежая', updated_at_ms: T0 + 50 },
    ]);
  });

  it('равное время оценок: при расхождении побеждает оставшийся (старший) чат', () => {
    const { chats, survivor, absorbed } = pair();
    save(chats, survivor, { ...EMPTY_PROFILE, area: 'из старшего' }, T0 + 10);
    save(chats, absorbed, { ...EMPTY_PROFILE, area: 'из младшего', business: 'Склад' }, T0 + 10);

    expect(merge(chats).profile).toMatchObject({ area: 'из старшего', business: 'Склад' });
  });

  it('оценка уже слитого чата больше не создаёт строки для исчезнувшего', () => {
    const { db, chats, absorbed } = pair();
    save(chats, absorbed, profileOf(), T0 + 10);
    merge(chats);

    expect(() => {
      save(chats, absorbed, profileOf(), T0 + 20);
    }).toThrow(/не найден/);
    expect(db.prepare('SELECT count(*) FROM client_profiles').pluck().get()).toBe(1);
  });
});

describe('слияние чатов: передачи менеджеру', () => {
  it('открытая передача слитого чата переезжает к оставшемуся и остаётся открытой', () => {
    const { db, chats, handoffs, survivor, absorbed } = pair();
    handoffs.open(absorbed.id, 'hot', 'hot', 'снимок', T0 + 10);

    merge(chats);

    expect(handoffs.findOpen(survivor.id)).toEqual({
      reason: 'hot',
      level: 'hot',
      openedAtMs: T0 + 10,
    });
    expect(handoffRows(db)).toEqual([
      { chat_id: survivor.id, reason: 'hot', opened_at_ms: T0 + 10, resolved_at_ms: null },
    ]);
  });

  it('две открытые: остаётся более ранняя, вторая закрывается временем слияния, обе в истории', () => {
    const { db, chats, handoffs, survivor, absorbed } = pair();
    handoffs.open(survivor.id, 'complaint', 'warm', 'позже', T0 + 50);
    handoffs.open(absorbed.id, 'hot', 'hot', 'раньше', T0 + 10);

    merge(chats);

    expect(handoffs.findOpen(survivor.id)).toEqual({
      reason: 'hot',
      level: 'hot',
      openedAtMs: T0 + 10,
    });
    expect(handoffRows(db)).toEqual([
      {
        chat_id: survivor.id,
        reason: 'complaint',
        opened_at_ms: T0 + 50,
        resolved_at_ms: MERGE_AT,
      },
      { chat_id: survivor.id, reason: 'hot', opened_at_ms: T0 + 10, resolved_at_ms: null },
    ]);
  });

  it('две открытые: если ранняя у оставшегося, остаётся она', () => {
    const { db, chats, handoffs, survivor, absorbed } = pair();
    handoffs.open(survivor.id, 'asked_human', 'cold', 'раньше', T0 + 10);
    handoffs.open(absorbed.id, 'hot', 'hot', 'позже', T0 + 50);

    merge(chats);

    expect(handoffs.findOpen(survivor.id)).toMatchObject({ reason: 'asked_human' });
    expect(
      db.prepare('SELECT count(*) FROM handoffs WHERE resolved_at_ms IS NULL').pluck().get(),
    ).toBe(1);
  });

  it('две открытые с одинаковым временем: остаётся та, что записана раньше', () => {
    const { chats, handoffs, survivor, absorbed } = pair();
    handoffs.open(absorbed.id, 'hot', 'hot', 'первая запись', T0 + 10);
    handoffs.open(survivor.id, 'complaint', 'warm', 'вторая запись', T0 + 10);

    merge(chats);

    expect(handoffs.findOpen(survivor.id)).toMatchObject({ reason: 'hot' });
  });

  it('часы слияния отстают от открытия: закрытие не раньше открытия, слияние не падает', () => {
    const { db, chats, handoffs, survivor, absorbed } = pair();
    handoffs.open(survivor.id, 'hot', 'hot', 'раньше', T0 + 10);
    handoffs.open(absorbed.id, 'complaint', 'warm', 'позже', MERGE_AT + 5000);

    merge(chats);

    expect(handoffRows(db)).toEqual([
      { chat_id: survivor.id, reason: 'hot', opened_at_ms: T0 + 10, resolved_at_ms: null },
      {
        chat_id: survivor.id,
        reason: 'complaint',
        opened_at_ms: MERGE_AT + 5000,
        resolved_at_ms: MERGE_AT + 5000,
      },
    ]);
  });

  it('закрытые передачи слитого чата переезжают в историю оставшегося, открытая оставшегося цела', () => {
    const { db, chats, handoffs, survivor, absorbed } = pair();
    handoffs.open(absorbed.id, 'no_answer', 'cold', 'старая', T0 + 5);
    handoffs.resolve(absorbed.id, T0 + 6);
    handoffs.open(survivor.id, 'hot', 'hot', 'текущая', T0 + 30);

    merge(chats);

    expect(handoffRows(db)).toEqual([
      { chat_id: survivor.id, reason: 'no_answer', opened_at_ms: T0 + 5, resolved_at_ms: T0 + 6 },
      { chat_id: survivor.id, reason: 'hot', opened_at_ms: T0 + 30, resolved_at_ms: null },
    ]);
  });

  it('три чата с тремя открытыми передачами: остаётся самая ранняя', () => {
    const db = useMigratedDb();
    const chats = createChatsRepo(db);
    const handoffs = createHandoffsRepo(db);
    const hosted = '77000000001@hosted' as Jid;
    const oldest = insertChat(db, { replyJid: hosted });
    const middle = insertChat(db, { replyJid: LID_A, lidJid: LID_A });
    const newest = insertChat(db, { replyJid: PN_A, pnJid: PN_A });
    handoffs.open(oldest, 'complaint', 'warm', 'позже всех', T0 + 50);
    handoffs.open(middle, 'asked_human', 'cold', 'раньше всех', T0 + 10);
    handoffs.open(newest, 'hot', 'hot', 'между', T0 + 30);

    chats.upsertByIdentity({ replyJid: hosted, lidJid: LID_A, pnJid: PN_A }, null, MERGE_AT);

    expect(handoffs.findOpen(oldest)).toMatchObject({ reason: 'asked_human', openedAtMs: T0 + 10 });
    expect(handoffRows(db)).toHaveLength(3);
    expect(
      db.prepare('SELECT count(*) FROM handoffs WHERE resolved_at_ms IS NULL').pluck().get(),
    ).toBe(1);
  });

  it('статус менеджера слитого чата и его открытая передача остаются согласованными', () => {
    const { chats, handoffs, survivor, absorbed } = pair();
    chats.setStatus(absorbed.id, { status: 'manager', by: 'bot' }, T0 + 5);
    handoffs.open(absorbed.id, 'hot', 'hot', 'снимок', T0 + 5);

    const merged = merge(chats);

    expect(merged.control).toEqual({ status: 'manager', by: 'bot' });
    expect(handoffs.findOpen(survivor.id)).not.toBeNull();
  });
});

describe('слияние чатов: уведомления менеджеру', () => {
  it('уведомления слитого чата переезжают к оставшемуся, список простоя без чата не трогается', () => {
    const { db, chats, notifications, survivor, absorbed } = pair();
    const own = notifications.add({
      kind: 'handoff',
      chatId: survivor.id,
      text: 'своё',
      nowMs: T0 + 1,
    });
    const moved = notifications.add({
      kind: 'limit',
      chatId: absorbed.id,
      text: 'чужое',
      nowMs: T0 + 2,
    });
    const backlog = notifications.add({
      kind: 'backlog',
      chatId: null,
      text: 'простой',
      nowMs: T0 + 3,
    });

    merge(chats);

    expect(notifications.latestForChat(survivor.id)).toMatchObject({ id: moved, text: 'чужое' });
    expect(db.prepare('SELECT id, chat_id FROM manager_notifications ORDER BY id').all()).toEqual([
      { id: own, chat_id: survivor.id },
      { id: moved, chat_id: survivor.id },
      { id: backlog, chat_id: null },
    ]);
  });
});

describe('слияние чатов: состояние определения компании', () => {
  function companies(db: Database.Database): { repo: ChatCompaniesRepo; logs: LogEntry[] } {
    const logs: LogEntry[] = [];
    return { repo: createChatCompaniesRepo(db, createFakeLogger(logs)), logs };
  }

  const confirmedState = (chatId: Chat['id']) =>
    makeState({ chatId, statedName: 'Платформа-А', confirmed: makeConfirmed() });

  it('у оставшегося чата записи нет: запись слитого переходит к нему', () => {
    const { db, chats, survivor, absorbed } = pair();
    const { repo } = companies(db);
    repo.save(confirmedState(absorbed.id), T0 + 10);

    merge(chats);

    expect(repo.get(survivor.id)).toEqual(confirmedState(survivor.id));
    expect(db.prepare('SELECT chat_id FROM chat_companies').pluck().all()).toEqual([survivor.id]);
  });

  it('запись есть у обоих, у слитого свежее: остаётся она (подтверждённая компания не теряется)', () => {
    const { db, chats, survivor, absorbed } = pair();
    const { repo } = companies(db);
    repo.save(makeState({ chatId: survivor.id, statedName: 'Своя' }), T0 + 10);
    repo.save(confirmedState(absorbed.id), T0 + 20);

    merge(chats);

    expect(repo.get(survivor.id)).toEqual(confirmedState(survivor.id));
    expect(db.prepare('SELECT chat_id, updated_at FROM chat_companies').all()).toEqual([
      { chat_id: survivor.id, updated_at: T0 + 20 },
    ]);
  });

  it('запись есть у обоих, у оставшегося свежее: слова клиента из своей, подтверждённая компания из слитого не теряется', () => {
    const { db, chats, survivor, absorbed } = pair();
    const { repo } = companies(db);
    repo.save(confirmedState(absorbed.id), T0 + 10);
    repo.save(makeState({ chatId: survivor.id, statedName: 'Своя' }), T0 + 20);

    merge(chats);

    expect(repo.get(survivor.id)).toEqual(
      makeState({ chatId: survivor.id, statedName: 'Своя', confirmed: makeConfirmed() }),
    );
    expect(db.prepare('SELECT chat_id, updated_at FROM chat_companies').all()).toEqual([
      { chat_id: survivor.id, updated_at: T0 + 20 },
    ]);
  });

  it('запись есть у обоих с одним временем записи: свежей считается запись оставшегося чата', () => {
    const { db, chats, survivor, absorbed } = pair();
    const { repo } = companies(db);
    repo.save(makeState({ chatId: survivor.id, statedName: 'Своя' }), T0 + 10);
    repo.save(confirmedState(absorbed.id), T0 + 10);

    merge(chats);

    expect(repo.get(survivor.id)).toEqual(
      makeState({ chatId: survivor.id, statedName: 'Своя', confirmed: makeConfirmed() }),
    );
    expect(db.prepare('SELECT count(*) FROM chat_companies').pluck().get()).toBe(1);
  });

  it('слияние по полям: отказы объединяются, проверка и отметка запуска не теряются, счётчики по максимуму', () => {
    const { db, chats, survivor, absorbed } = pair();
    const { repo } = companies(db);
    const research = {
      status: 'running',
      jobId: jobIdOf('job-1'),
      startedAtMs: T0,
      checkedAtMs: T0 + 5,
    } as const;
    repo.save(
      makeState({
        chatId: survivor.id,
        rejectedIds: [companyIdOf(3)],
        research,
        researchStartedAtMs: T0,
        briefFailures: 2,
        logoCheckedAtMs: T0 + 1,
      }),
      T0 + 10,
    );
    repo.save(
      makeState({
        chatId: absorbed.id,
        rejectedIds: [companyIdOf(5)],
        candidate: makeChatCandidate({ id: companyIdOf(3) }),
        adoptFailures: 1,
        statedName: 'Бета',
      }),
      T0 + 20,
    );

    merge(chats);

    expect(repo.get(survivor.id)).toEqual(
      makeState({
        chatId: survivor.id,
        rejectedIds: [companyIdOf(3), companyIdOf(5)],
        research,
        researchStartedAtMs: T0,
        briefFailures: 2,
        adoptFailures: 1,
        logoCheckedAtMs: T0 + 1,
        statedName: 'Бета',
        candidate: null,
      }),
    );
    expect(repo.countResearchStarts(T0 - 1)).toBe(1);
  });

  it('у слитого чата запись испорчена, у оставшегося цела: остаётся целая, без ошибок', () => {
    const { db, chats, survivor, absorbed } = pair();
    const { repo, logs } = companies(db);
    repo.save(confirmedState(survivor.id), T0 + 10);
    db.prepare(
      "INSERT INTO chat_companies (chat_id, state, updated_at) VALUES (?, 'мусор', ?)",
    ).run(absorbed.id, T0 + 20);

    merge(chats);

    expect(repo.get(survivor.id)).toEqual(confirmedState(survivor.id));
    expect(db.prepare('SELECT chat_id, updated_at FROM chat_companies').all()).toEqual([
      { chat_id: survivor.id, updated_at: T0 + 20 },
    ]);
    expect(logs).toEqual([]);
  });

  it('у оставшегося чата запись испорчена, у слитого цела: остаётся целая', () => {
    const { db, chats, survivor, absorbed } = pair();
    const { repo, logs } = companies(db);
    db.prepare(
      "INSERT INTO chat_companies (chat_id, state, updated_at) VALUES (?, 'мусор', ?)",
    ).run(survivor.id, T0 + 20);
    repo.save(confirmedState(absorbed.id), T0 + 10);

    merge(chats);

    expect(repo.get(survivor.id)).toEqual(confirmedState(survivor.id));
    expect(logs).toEqual([]);
  });

  it('испорчены обе записи: остаётся запись оставшегося чата как есть', () => {
    const { db, chats, survivor, absorbed } = pair();
    const insert = db.prepare(
      'INSERT INTO chat_companies (chat_id, state, updated_at) VALUES (?, ?, ?)',
    );
    insert.run(survivor.id, 'своя порча', T0 + 10);
    insert.run(absorbed.id, 'чужая порча', T0 + 20);

    merge(chats);

    expect(db.prepare('SELECT chat_id, state FROM chat_companies').all()).toEqual([
      { chat_id: survivor.id, state: 'своя порча' },
    ]);
  });

  it('запись только у оставшегося чата не меняется', () => {
    const { db, chats, survivor } = pair();
    const { repo } = companies(db);
    repo.save(confirmedState(survivor.id), T0 + 10);

    merge(chats);

    expect(repo.get(survivor.id)).toEqual(confirmedState(survivor.id));
    expect(db.prepare('SELECT count(*) FROM chat_companies').pluck().get()).toBe(1);
  });

  it('записей нет ни у одного чата: после слияния их по-прежнему нет, без предупреждений', () => {
    const { db, chats, survivor } = pair();
    const { repo, logs } = companies(db);

    merge(chats);

    expect(db.prepare('SELECT count(*) FROM chat_companies').pluck().get()).toBe(0);
    expect(repo.get(survivor.id)).toEqual(makeState({ chatId: survivor.id }));
    expect(logs).toEqual([]);
  });

  it('три чата с записями у двух младших: остаётся запись с более поздним временем записи', () => {
    const db = useMigratedDb();
    const chats = createChatsRepo(db);
    const { repo } = companies(db);
    const hosted = '77000000001@hosted' as Jid;
    const oldest = insertChat(db, { replyJid: hosted });
    const middle = insertChat(db, { replyJid: LID_A, lidJid: LID_A });
    const newest = insertChat(db, { replyJid: PN_A, pnJid: PN_A });
    repo.save(makeState({ chatId: middle, statedName: 'Из среднего' }), T0 + 10);
    repo.save(makeState({ chatId: newest, statedName: 'Из младшего' }), T0 + 20);

    chats.upsertByIdentity({ replyJid: hosted, lidJid: LID_A, pnJid: PN_A }, null, MERGE_AT);

    expect(repo.get(oldest).statedName).toBe('Из младшего');
    expect(db.prepare('SELECT count(*) FROM chat_companies').pluck().get()).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('испорченная запись слитого чата тоже переходит как есть: чтение даёт пустое состояние с предупреждением', () => {
    const { db, chats, survivor, absorbed } = pair();
    const { repo, logs } = companies(db);
    db.prepare(
      "INSERT INTO chat_companies (chat_id, state, updated_at) VALUES (?, 'мусор', 1)",
    ).run(absorbed.id);

    merge(chats);

    expect(repo.get(survivor.id)).toEqual(makeState({ chatId: survivor.id }));
    expect(logs).toHaveLength(1);
  });

  it('кандидат в записи не привязан к старому чату: после слияния чтение возвращает ID оставшегося', () => {
    const { db, chats, survivor, absorbed } = pair();
    const { repo } = companies(db);
    repo.save(makeState({ chatId: absorbed.id, candidate: makeChatCandidate() }), T0 + 10);

    merge(chats);

    expect(repo.get(survivor.id).chatId).toBe(survivor.id);
    expect(repo.get(survivor.id).candidate).toEqual(makeChatCandidate());
  });
});

describe('слияние чатов: всё сразу', () => {
  it('у слитого чата есть и история, и выжимка, и передача, и уведомления, и компания: чат удаляется без ошибок', () => {
    const { db, chats, handoffs, notifications, survivor, absorbed } = pair();
    createMessagesRepo(db).insertIfNew({
      chatId: absorbed.id,
      waId: 'W1' as WaMessageId,
      author: 'client',
      kind: 'text',
      text: 'Здравствуйте',
      tsMs: T0,
    });
    createBacklogRepo(db).markStale(absorbed.id, T0);
    save(chats, absorbed, profileOf(), T0 + 10);
    handoffs.open(absorbed.id, 'hot', 'hot', 'снимок', T0 + 11);
    notifications.add({ kind: 'handoff', chatId: absorbed.id, text: 'Передача', nowMs: T0 + 12 });
    createChatCompaniesRepo(db, createFakeLogger([])).save(
      makeState({ chatId: absorbed.id, statedName: 'Платформа-А' }),
      T0 + 13,
    );

    const merged = merge(chats);

    expect(merged.id).toBe(survivor.id);
    expect(chats.getById(absorbed.id)).toBeNull();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
