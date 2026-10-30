import { describe, expect, it } from 'vitest';
import type { ChatId } from '../../../src/domain/types.js';
import {
  CONSOLE_REPLIES_PER_CHAT_PER_HOUR,
  CONSOLE_REPLIES_PER_HOUR,
  createReplyRateLimit,
  REPLY_LIMIT_TEXTS,
  type ReplyRateLimit,
  type ReplySlot,
} from '../../../src/panel/console-reply-limit.js';

// Предел ответов из консоли: скользящий час в памяти, 20 в чат и 100 всего, место освобождается, если ответ не ушёл.

const HOUR_MS = 60 * 60_000;

function clockAt(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

function takeOk(limit: ReplyRateLimit, chat: number): ReplySlot {
  const result = limit.take(chat as ChatId);
  if (result.kind !== 'taken') throw new Error(`место не занято: ${result.message}`);
  return result.slot;
}

describe('предел ответов из консоли', () => {
  it('20 в один чат за час, другой чат независим', () => {
    const limit = createReplyRateLimit(clockAt(0));
    for (let i = 0; i < CONSOLE_REPLIES_PER_CHAT_PER_HOUR; i += 1) takeOk(limit, 1);

    expect(limit.take(1 as ChatId)).toEqual({ kind: 'limited', message: REPLY_LIMIT_TEXTS.chat });
    expect(limit.take(2 as ChatId).kind).toBe('taken');
  });

  it('100 на все чаты за час', () => {
    const limit = createReplyRateLimit(clockAt(0));
    for (let i = 0; i < CONSOLE_REPLIES_PER_HOUR; i += 1) takeOk(limit, i + 1);

    expect(limit.take(500 as ChatId)).toEqual({
      kind: 'limited',
      message: REPLY_LIMIT_TEXTS.total,
    });
  });

  it('окно скользящее: место освобождается ровно через час после ответа', () => {
    const clock = clockAt(1_000);
    const limit = createReplyRateLimit(clock);
    takeOk(limit, 1);
    clock.advance(30 * 60_000);
    for (let i = 1; i < CONSOLE_REPLIES_PER_CHAT_PER_HOUR; i += 1) takeOk(limit, 1);

    clock.advance(30 * 60_000 - 1);
    expect(limit.take(1 as ChatId).kind).toBe('limited');
    clock.advance(1);
    expect(limit.take(1 as ChatId).kind).toBe('taken');
    expect(limit.take(1 as ChatId).kind).toBe('limited');
    clock.advance(HOUR_MS);
    expect(limit.take(1 as ChatId).kind).toBe('taken');
  });

  it('снятое место можно занять снова; повторное снятие ничего не трогает', () => {
    const limit = createReplyRateLimit(clockAt(0));
    const slots = Array.from({ length: CONSOLE_REPLIES_PER_CHAT_PER_HOUR }, () => takeOk(limit, 1));

    slots[0]?.release();
    slots[0]?.release();

    expect(limit.take(1 as ChatId).kind).toBe('taken');
    expect(limit.take(1 as ChatId).kind).toBe('limited');
  });

  it('тексты отказа по-русски с числами предела', () => {
    expect(REPLY_LIMIT_TEXTS.chat).toContain(
      `${String(CONSOLE_REPLIES_PER_CHAT_PER_HOUR)} ответов`,
    );
    expect(REPLY_LIMIT_TEXTS.total).toContain(`${String(CONSOLE_REPLIES_PER_HOUR)} ответов`);
  });
});
