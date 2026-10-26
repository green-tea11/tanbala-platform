import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createCallBudget } from '../../../../src/db/repos/call-budget.js';
import type { CallBudget } from '../../../../src/domain/ports.js';
import type { ApiLimits, ChatId } from '../../../../src/domain/types.js';
import { useMigratedDb } from '../fixture.js';

const LIMITS: ApiLimits = { apiCallsPerDay: 3, apiCallsPerChatPerDay: 2 };

/** 26.10.2026 00:00 по Алматы (UTC+5) = 25.10.2026 19:00 UTC. */
const ALMATY_MIDNIGHT = Date.UTC(2026, 9, 25, 19, 0, 0);
const NOON = ALMATY_MIDNIGHT + 12 * 60 * 60 * 1000;

const CHAT_A = 1 as ChatId;
const CHAT_B = 2 as ChatId;
const CHAT_C = 3 as ChatId;

function setup(limits: ApiLimits = LIMITS): { db: Database.Database; budget: CallBudget } {
  const db = useMigratedDb();
  return { db, budget: createCallBudget(db, limits) };
}

function consumeTimes(budget: CallBudget, chatId: ChatId, times: number, nowMs = NOON): void {
  for (let i = 0; i < times; i += 1) budget.tryConsume(chatId, nowMs);
}

function counters(db: Database.Database): unknown[] {
  return db.prepare('SELECT day, chat_id, count FROM api_usage ORDER BY day, chat_id').all();
}

describe('createCallBudget: tryConsume', () => {
  it('засчитывает вызовы, пока оба лимита позволяют: общий счётчик и счётчик чата за сутки по Алматы', () => {
    const { db, budget } = setup();

    expect(budget.tryConsume(CHAT_A, NOON)).toEqual({ ok: true });
    expect(budget.tryConsume(CHAT_B, NOON)).toEqual({ ok: true });

    expect(counters(db)).toEqual([
      { day: '2026-10-26', chat_id: 0, count: 2 },
      { day: '2026-10-26', chat_id: CHAT_A, count: 1 },
      { day: '2026-10-26', chat_id: CHAT_B, count: 1 },
    ]);
  });

  it('лимит чата исчерпан: отказ scope chat без увеличения счётчиков, другой чат работает', () => {
    const { db, budget } = setup();
    consumeTimes(budget, CHAT_A, 2);
    const before = counters(db);

    expect(budget.tryConsume(CHAT_A, NOON)).toEqual({ ok: false, scope: 'chat' });
    expect(counters(db)).toEqual(before);
    expect(budget.tryConsume(CHAT_B, NOON)).toEqual({ ok: true });
  });

  it('общий лимит исчерпан: отказ scope global для любого чата без увеличения счётчиков', () => {
    const { db, budget } = setup();
    consumeTimes(budget, CHAT_A, 2);
    consumeTimes(budget, CHAT_B, 1);
    const before = counters(db);

    expect(budget.tryConsume(CHAT_C, NOON)).toEqual({ ok: false, scope: 'global' });
    expect(budget.tryConsume(CHAT_A, NOON)).toEqual({ ok: false, scope: 'global' });
    expect(counters(db)).toEqual(before);
  });

  it('новые сутки начинаются в 00:00 по Алматы, а не по UTC', () => {
    const { budget } = setup();
    consumeTimes(budget, CHAT_A, 2, ALMATY_MIDNIGHT - 1);
    const utcMidnight = Date.UTC(2026, 9, 26, 0, 0, 0);

    expect(budget.tryConsume(CHAT_A, ALMATY_MIDNIGHT)).toEqual({ ok: true });
    expect(budget.tryConsume(CHAT_A, utcMidnight)).toEqual({ ok: true });
    expect(budget.tryConsume(CHAT_A, utcMidnight)).toEqual({ ok: false, scope: 'chat' });
  });

  it('счётчики в базе: новый предохранитель на той же базе (перезапуск) продолжает счёт', () => {
    const { db, budget } = setup();
    consumeTimes(budget, CHAT_A, 2);

    const restarted = createCallBudget(db, LIMITS);

    expect(restarted.tryConsume(CHAT_A, NOON)).toEqual({ ok: false, scope: 'chat' });
  });

  it('лимит 1 пропускает ровно один вызов', () => {
    const { budget } = setup({ apiCallsPerDay: 1, apiCallsPerChatPerDay: 1 });

    expect(budget.tryConsume(CHAT_A, NOON)).toEqual({ ok: true });
    expect(budget.tryConsume(CHAT_A, NOON)).toEqual({ ok: false, scope: 'global' });
  });

  it.each([0, -1, 1.5])('ID чата %s недопустим (0 занят общим счётчиком): RangeError', (chatId) => {
    const { db, budget } = setup();

    expect(() => budget.tryConsume(chatId as ChatId, NOON)).toThrow(RangeError);
    expect(counters(db)).toEqual([]);
  });

  it.each([-1, 1.5, Number.NaN])('неверное время %s: RangeError', (nowMs) => {
    const { budget } = setup();

    expect(() => budget.tryConsume(CHAT_A, nowMs)).toThrow(RangeError);
  });
});

describe('createCallBudget: лимиты', () => {
  it.each([
    ['общий 0', { apiCallsPerDay: 0, apiCallsPerChatPerDay: 1 }],
    ['общий дробный', { apiCallsPerDay: 1.5, apiCallsPerChatPerDay: 1 }],
    ['чата отрицательный', { apiCallsPerDay: 1, apiCallsPerChatPerDay: -1 }],
    ['чата NaN', { apiCallsPerDay: 1, apiCallsPerChatPerDay: Number.NaN }],
  ])('недопустимый лимит (%s): RangeError при создании', (_label, limits) => {
    const db = useMigratedDb();

    expect(() => createCallBudget(db, limits)).toThrow(RangeError);
  });
});
