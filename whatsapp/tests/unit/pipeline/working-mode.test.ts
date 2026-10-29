import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { TestMode } from '../../../src/config/env.js';
import { createUnitOfWork } from '../../../src/db/connection.js';
import { createAppStateRepo } from '../../../src/db/repos/app-state.js';
import { createChatsRepo } from '../../../src/db/repos/chats.js';
import { createKnownChatsRepo } from '../../../src/db/repos/known-chats.js';
import { createWorkingModeRepo } from '../../../src/db/repos/working-mode.js';
import type { ChatsRepo } from '../../../src/domain/ports.js';
import type {
  ChatId,
  ChatIdentity,
  Jid,
  PhoneDigits,
  WorkingMode,
} from '../../../src/domain/types.js';
import {
  createHeldForManagerCheck,
  createUnseenHold,
  resumeFloorMs,
  settleWorkingMode,
  startsWithManager,
  WorkingModeRefusedError,
  type WorkingModeDeps,
} from '../../../src/pipeline/working-mode.js';
import { SafeError } from '../../../src/shared/safe-error.js';
import { createFakeLogger, type LogEntry } from '../../helpers/fake-logger.js';
import { insertChat, LID_A, LID_B, PN_A, PN_B, useMigratedDb } from '../db/fixture.js';

// Правило перехода в рабочий режим (этап 8) на настоящей базе в памяти. Адреса только фиктивные.

const HOUR_MS = 3_600_000;
const LINKED_AT = Date.UTC(2026, 9, 20, 9, 0, 0);
const NOW = Date.UTC(2026, 9, 29, 9, 0, 0);
/** Номер тестировщика из TEST_ALLOWLIST: PN_A (77000000001). */
const TESTER_PHONE = '77000000001' as PhoneDigits;
const ALLOWLIST: ReadonlySet<PhoneDigits> = new Set([TESTER_PHONE]);
const CLOSED: TestMode = { enabled: true, allowlist: ALLOWLIST };
const WORKING: TestMode = { enabled: false, allowlist: ALLOWLIST };
const STRANGER_PN = '77000000003@s.whatsapp.net' as Jid;
/** Чат, который впервые появился в known_chats после перехода. */
const LATER_LID = '100000000000007@lid' as Jid;

interface Rig {
  readonly db: Database.Database;
  readonly deps: WorkingModeDeps;
  readonly logs: LogEntry[];
  setNow(ms: number): void;
}

function rigOf(overrides: Partial<WorkingModeDeps> = {}): Rig {
  const db = useMigratedDb();
  const logs: LogEntry[] = [];
  let nowMs = NOW;
  const deps: WorkingModeDeps = {
    appState: createAppStateRepo(db),
    repo: createWorkingModeRepo(db),
    chats: createChatsRepo(db),
    unitOfWork: createUnitOfWork(db),
    clock: { now: () => nowMs },
    logger: createFakeLogger(logs),
    ...overrides,
  };
  return {
    db,
    deps,
    logs,
    setNow: (ms) => {
      nowMs = ms;
    },
  };
}

/** Номер привязан, известны чаты первой синхронизации, в базе чат тестировщика и бывший чат не из списка. */
function linkedRig(overrides: Partial<WorkingModeDeps> = {}): Rig & {
  readonly tester: ChatId;
  readonly former: ChatId;
} {
  const rig = rigOf(overrides);
  createAppStateRepo(rig.db).setLinkedAtMs(LINKED_AT);
  const known = createKnownChatsRepo(rig.db);
  known.touch(PN_A, LINKED_AT + HOUR_MS, 'message');
  known.touch(LID_A, LINKED_AT + HOUR_MS, 'message');
  known.touch(PN_B, LINKED_AT - 90 * 24 * HOUR_MS, 'history');
  known.touch(LID_B, LINKED_AT + 2 * HOUR_MS, 'message');
  const tester = insertChat(rig.db, {
    replyJid: PN_A,
    lidJid: LID_A,
    pnJid: PN_A,
    phone: TESTER_PHONE,
  });
  const former = insertChat(rig.db, { replyJid: STRANGER_PN, pnJid: STRANGER_PN });
  known.touch(STRANGER_PN, LINKED_AT + 3 * HOUR_MS, 'message');
  return { ...rig, tester, former };
}

function heldOf(db: Database.Database): unknown[] {
  return db
    .prepare('SELECT jid FROM known_chats WHERE held_for_manager = 1 ORDER BY jid')
    .pluck()
    .all();
}

function controlOf(db: Database.Database, chatId: ChatId): unknown {
  return createChatsRepo(db).getById(chatId)?.control;
}

function workingKey(db: Database.Database): unknown {
  return db.prepare("SELECT value FROM app_state WHERE key = 'working_since_ms'").pluck().get();
}

function errorOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

describe('pipeline/working-mode settleWorkingMode: закрытый режим', () => {
  it('TEST_MODE=true: рабочего режима нет, без границы ничего не пишется и не логируется', () => {
    const rig = linkedRig();

    expect(settleWorkingMode(rig.deps, CLOSED)).toBeNull();

    expect(workingKey(rig.db)).toBeUndefined();
    expect(heldOf(rig.db)).toEqual([]);
    expect(rig.logs).toEqual([]);
  });

  it('TEST_MODE=true после рабочего режима: граница снимается, одна строка в лог; отметки и статусы на месте', () => {
    const rig = linkedRig();
    settleWorkingMode(rig.deps, WORKING);
    const held = heldOf(rig.db);

    expect(settleWorkingMode(rig.deps, CLOSED)).toBeNull();

    expect(workingKey(rig.db)).toBeUndefined();
    expect(heldOf(rig.db)).toEqual(held);
    expect(controlOf(rig.db, rig.former)).toEqual({ status: 'manager', by: 'phone' });
    expect(rig.logs.at(-1)).toMatchObject({
      level: 'info',
      message: expect.stringContaining('Закрытый режим') as unknown,
    });
  });
});

describe('pipeline/working-mode settleWorkingMode: отказ перехода', () => {
  it('номер ещё не привязан: отказ понятным текстом, ничего не записано', () => {
    const rig = rigOf();
    createKnownChatsRepo(rig.db).touch(PN_B, LINKED_AT, 'history');

    const error = errorOf(() => settleWorkingMode(rig.deps, WORKING));

    expect(error).toBeInstanceOf(WorkingModeRefusedError);
    expect(error).toBeInstanceOf(SafeError);
    expect((error as Error).message).toMatch(/TEST_MODE=false.*не привязан/);
    expect(workingKey(rig.db)).toBeUndefined();
    expect(heldOf(rig.db)).toEqual([]);
  });

  it('флаг «список чатов неполный»: отказ, граница, отметки и статусы не меняются', () => {
    const rig = linkedRig();
    createAppStateRepo(rig.db).markHistoryIncomplete(LINKED_AT + 1000);

    const error = errorOf(() => settleWorkingMode(rig.deps, WORKING));

    expect(error).toBeInstanceOf(WorkingModeRefusedError);
    expect((error as Error).message).toMatch(/список чатов неполный/);
    expect((error as Error).message).toMatch(/TEST_MODE=true/);
    expect(workingKey(rig.db)).toBeUndefined();
    expect(heldOf(rig.db)).toEqual([]);
    expect(controlOf(rig.db, rig.former)).toEqual({ status: 'bot', by: null });
    expect(rig.logs).toEqual([]);
  });

  it('список чатов пуст (первая синхронизация ещё не пришла): отказ понятным текстом, ничего не записано', () => {
    const rig = rigOf();
    createAppStateRepo(rig.db).setLinkedAtMs(LINKED_AT);
    const former = insertChat(rig.db, { replyJid: STRANGER_PN, pnJid: STRANGER_PN });

    const error = errorOf(() => settleWorkingMode(rig.deps, WORKING));

    expect(error).toBeInstanceOf(WorkingModeRefusedError);
    expect(error).toMatchObject({ reason: 'no_known_chats' });
    expect((error as Error).message).toMatch(/TEST_MODE=false.*список чатов.*пуст/);
    expect((error as Error).message).toMatch(/Первая синхронизация/);
    expect((error as Error).message).not.toMatch(/7700000000\d|@lid|@s\.whatsapp\.net/);
    expect(workingKey(rig.db)).toBeUndefined();
    expect(controlOf(rig.db, former)).toEqual({ status: 'bot', by: null });
    expect(rig.logs).toEqual([]);
  });

  it('отказ и при уже снятой границе: флаг проверяется на каждом переходе', () => {
    const rig = linkedRig();
    settleWorkingMode(rig.deps, WORKING);
    settleWorkingMode(rig.deps, CLOSED);
    createAppStateRepo(rig.db).markHistoryIncomplete(NOW);

    expect(errorOf(() => settleWorkingMode(rig.deps, WORKING))).toBeInstanceOf(
      WorkingModeRefusedError,
    );
    expect(workingKey(rig.db)).toBeUndefined();
  });
});

describe('pipeline/working-mode settleWorkingMode: первый переход', () => {
  it('граница = сейчас; все известные чаты у менеджера; чат не из списка в базе => manager, тестировщик как был', () => {
    const rig = linkedRig();

    const mode = settleWorkingMode(rig.deps, WORKING);

    expect(mode).toEqual({ sinceMs: NOW, allowlist: ALLOWLIST });
    expect(createAppStateRepo(rig.db).getWorkingSinceMs()).toBe(NOW);
    expect(heldOf(rig.db)).toEqual([PN_A, LID_A, PN_B, LID_B, STRANGER_PN].toSorted());
    expect(controlOf(rig.db, rig.former)).toEqual({ status: 'manager', by: 'phone' });
    expect(controlOf(rig.db, rig.tester)).toEqual({ status: 'bot', by: null });
  });

  it('чат, который уже ведёт менеджер, остаётся как был (кто и когда перехватил)', () => {
    const rig = linkedRig();
    createChatsRepo(rig.db).setStatus(rig.former, { status: 'manager', by: 'panel' }, LINKED_AT);

    settleWorkingMode(rig.deps, WORKING);

    expect(controlOf(rig.db, rig.former)).toEqual({ status: 'manager', by: 'panel' });
  });

  it('в лог одна строка с числом чатов, без адресов и номеров', () => {
    const rig = linkedRig();

    settleWorkingMode(rig.deps, WORKING);

    expect(rig.logs).toEqual([
      {
        level: 'info',
        context: { heldAddresses: 5, movedChats: 1 },
        message: expect.stringMatching(/^Переход в рабочий режим: .*5.*1/) as unknown,
      },
    ]);
    expect(JSON.stringify(rig.logs)).not.toMatch(/7700000000\d|@lid|@s\.whatsapp\.net/);
  });

  it('сбой посреди перехода откатывает всё: ни границы, ни отметок, ни статусов', () => {
    const failing: Pick<ChatsRepo, 'setStatus'> = {
      setStatus: () => {
        throw new Error('диск переполнен');
      },
    };
    const rig = linkedRig({ chats: failing });

    expect(errorOf(() => settleWorkingMode(rig.deps, WORKING))).toMatchObject({
      message: 'диск переполнен',
    });

    expect(workingKey(rig.db)).toBeUndefined();
    expect(heldOf(rig.db)).toEqual([]);
    expect(controlOf(rig.db, rig.former)).toEqual({ status: 'bot', by: null });
  });
});

describe('pipeline/working-mode settleWorkingMode: граница уже есть', () => {
  it('второй запуск: граница прежняя, отметки и статусы не пересчитываются', () => {
    const rig = linkedRig();
    settleWorkingMode(rig.deps, WORKING);
    createChatsRepo(rig.db).setStatus(rig.former, { status: 'bot', by: 'panel' }, NOW + 1);
    createKnownChatsRepo(rig.db).touch(LATER_LID, NOW + 2, 'message');
    rig.setNow(NOW + HOUR_MS);

    const mode = settleWorkingMode(rig.deps, WORKING);

    expect(mode).toEqual({ sinceMs: NOW, allowlist: ALLOWLIST });
    expect(controlOf(rig.db, rig.former)).toEqual({ status: 'bot', by: 'panel' });
    expect(heldOf(rig.db)).toHaveLength(5);
    expect(rig.logs.at(-1)).toMatchObject({ level: 'info', context: { workingSinceMs: NOW } });
  });

  it('повторный переход после закрытого режима: новая граница, правило считается заново', () => {
    const rig = linkedRig();
    settleWorkingMode(rig.deps, WORKING);
    createChatsRepo(rig.db).setStatus(rig.former, { status: 'bot', by: 'panel' }, NOW + 1);
    settleWorkingMode(rig.deps, CLOSED);
    createKnownChatsRepo(rig.db).touch(LATER_LID, NOW + 2, 'message');
    rig.setNow(NOW + 24 * HOUR_MS);

    const mode = settleWorkingMode(rig.deps, WORKING);

    expect(mode?.sinceMs).toBe(NOW + 24 * HOUR_MS);
    expect(heldOf(rig.db)).toContain(LATER_LID);
    expect(controlOf(rig.db, rig.former)).toEqual({ status: 'manager', by: 'phone' });
  });
});

describe('pipeline/working-mode startsWithManager: правило по умолчанию до решения владельца', () => {
  it.each<[string, number | null]>([
    ['вчера', NOW - 24 * HOUR_MS],
    ['год назад', NOW - 365 * 24 * HOUR_MS],
    ['без известной активности', null],
  ])('чат с активностью %s начинает у менеджера', (_case, lastActivityMs) => {
    expect(startsWithManager(lastActivityMs, NOW)).toBe(true);
  });
});

describe('pipeline/working-mode createHeldForManagerCheck: новый чат после перехода', () => {
  const MODE: WorkingMode = { sinceMs: NOW, allowlist: ALLOWLIST };

  function checkOf(mode: WorkingMode | null): (identity: ChatIdentity) => boolean {
    const db = useMigratedDb();
    const known = createKnownChatsRepo(db);
    for (const jid of [PN_A, LID_B, STRANGER_PN]) known.touch(jid, LINKED_AT, 'history');
    const repo = createWorkingModeRepo(db);
    repo.holdForManager([PN_A, LID_B, STRANGER_PN]);
    return createHeldForManagerCheck(mode, repo);
  }

  it('адрес отмечен при переходе => у менеджера; по любому из адресов чата', () => {
    const check = checkOf(MODE);

    expect(check({ replyJid: STRANGER_PN, lidJid: null, pnJid: STRANGER_PN })).toBe(true);
    expect(check({ replyJid: PN_B, lidJid: LID_B, pnJid: PN_B })).toBe(true);
  });

  it('адрес не отмечен (впервые написал после перехода) => бот', () => {
    expect(checkOf(MODE)({ replyJid: PN_B, lidJid: null, pnJid: PN_B })).toBe(false);
  });

  it('номер из TEST_ALLOWLIST никогда не уходит менеджеру по правилу, даже с отмеченным адресом', () => {
    expect(checkOf(MODE)({ replyJid: PN_A, lidJid: null, pnJid: PN_A })).toBe(false);
  });

  it('закрытый режим: правило не действует', () => {
    expect(checkOf(null)({ replyJid: STRANGER_PN, lidJid: null, pnJid: STRANGER_PN })).toBe(false);
  });
});

describe('pipeline/working-mode createUnseenHold: переписка без бота в рабочем режиме', () => {
  const MODE: WorkingMode = { sinceMs: NOW, allowlist: ALLOWLIST };

  function holdOf(mode: WorkingMode | null) {
    const db = useMigratedDb();
    const known = createKnownChatsRepo(db);
    for (const jid of [PN_A, PN_B, LID_B]) known.touch(jid, LINKED_AT, 'history');
    const repo = createWorkingModeRepo(db);
    repo.holdForManager([PN_A]);
    return { db, hold: createUnseenHold(mode, repo) };
  }

  it('рабочий режим: адреса отмечены «у менеджера» в добавление к прежним, true', () => {
    const { db, hold } = holdOf(MODE);

    expect(hold([PN_B, LID_B])).toBe(true);

    expect(heldOf(db)).toEqual([PN_A, PN_B, LID_B].toSorted());
  });

  it('закрытый режим: ничего не отмечается, false', () => {
    const { db, hold } = holdOf(null);

    expect(hold([PN_B, LID_B])).toBe(false);

    expect(heldOf(db)).toEqual([PN_A]);
  });
});

describe('pipeline/working-mode resumeFloorMs: возврат боту', () => {
  const MODE: WorkingMode = { sinceMs: NOW, allowlist: ALLOWLIST };
  const stranger: ChatIdentity = { replyJid: STRANGER_PN, lidJid: null, pnJid: STRANGER_PN };
  const tester: ChatIdentity = { replyJid: PN_A, lidJid: null, pnJid: PN_A };

  it('чат не из списка: бот не отвечает на сообщения до перехода', () => {
    expect(resumeFloorMs(MODE, stranger)).toBe(NOW);
  });

  it('номер из списка и закрытый режим: ограничения нет', () => {
    expect(resumeFloorMs(MODE, tester)).toBe(0);
    expect(resumeFloorMs(null, stranger)).toBe(0);
  });
});
