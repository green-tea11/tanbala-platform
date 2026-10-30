import { describe, expect, it } from 'vitest';
import { createOutputGuard, MAX_BLOCKED_OUTPUT_MS } from '../../../src/shared/terminal-output.js';

function clockAt(start: number) {
  let nowMs = start;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe('shared/terminal-output: повтор записи в занятый stdout', () => {
  it('занятый вывод ждётся, пока занят меньше предела, потом строка бросается', () => {
    const clock = clockAt(1_000);
    const guard = createOutputGuard(clock.now);

    expect(guard.retry()).toBe(true);
    clock.advance(MAX_BLOCKED_OUTPUT_MS - 1);
    expect(guard.retry()).toBe(true);
    clock.advance(1);
    expect(guard.retry()).toBe(false);
  });

  it('удачная запись начинает отсчёт заново', () => {
    const clock = clockAt(0);
    const guard = createOutputGuard(clock.now);

    guard.retry();
    clock.advance(MAX_BLOCKED_OUTPUT_MS - 1);
    guard.written();
    clock.advance(MAX_BLOCKED_OUTPUT_MS - 1);
    expect(guard.retry()).toBe(true);
  });

  it('после SIGHUP (терминал закрыт) вывод не ждётся вовсе', () => {
    const guard = createOutputGuard(() => 0);

    guard.hangUp();

    expect(guard.retry()).toBe(false);
  });
});
