import { describe, expect, it } from 'vitest';
import { createLoginLimiter } from '../../../src/panel/login-limiter.js';

const T0 = 1_761_400_000_000;
const MINUTE = 60_000;

describe('createLoginLimiter', () => {
  const options = { maxFailures: 3, windowMs: 10 * MINUTE, maxKeys: 5 };

  it('до порога неудач вход разрешён', () => {
    const limiter = createLoginLimiter(options);

    limiter.recordFailure('a', T0);
    limiter.recordFailure('a', T0 + 1);

    expect(limiter.retryAfterMs('a', T0 + 2)).toBe(0);
  });

  it('после порога блокирует, пока самая старая неудача не выйдет из окна', () => {
    const limiter = createLoginLimiter(options);
    limiter.recordFailure('a', T0);
    limiter.recordFailure('a', T0 + MINUTE);
    limiter.recordFailure('a', T0 + 2 * MINUTE);

    expect(limiter.retryAfterMs('a', T0 + 3 * MINUTE)).toBe(7 * MINUTE);
    expect(limiter.retryAfterMs('a', T0 + 10 * MINUTE - 1)).toBe(1);
    expect(limiter.retryAfterMs('a', T0 + 10 * MINUTE)).toBe(0);
  });

  it('ключи независимы', () => {
    const limiter = createLoginLimiter(options);
    for (let i = 0; i < 3; i += 1) limiter.recordFailure('a', T0);

    expect(limiter.retryAfterMs('a', T0)).toBeGreaterThan(0);
    expect(limiter.retryAfterMs('b', T0)).toBe(0);
  });

  it('успешный вход сбрасывает счётчик ключа', () => {
    const limiter = createLoginLimiter(options);
    for (let i = 0; i < 3; i += 1) limiter.recordFailure('a', T0);

    limiter.reset('a');
    limiter.reset('нет-такого');

    expect(limiter.retryAfterMs('a', T0 + 1)).toBe(0);
  });

  it('память ограничена: самые старые ключи забываются, свежие остаются под счётом', () => {
    const limiter = createLoginLimiter(options);
    for (let key = 0; key < 20; key += 1) {
      for (let i = 0; i < 3; i += 1) limiter.recordFailure(`k${key}`, T0 + key);
    }

    expect(limiter.retryAfterMs('k0', T0 + 100)).toBe(0);
    expect(limiter.retryAfterMs('k19', T0 + 100)).toBeGreaterThan(0);
  });

  it('значения по умолчанию: пять неудач за десять минут', () => {
    const limiter = createLoginLimiter();
    for (let i = 0; i < 4; i += 1) limiter.recordFailure('a', T0);
    expect(limiter.retryAfterMs('a', T0)).toBe(0);

    limiter.recordFailure('a', T0);

    expect(limiter.retryAfterMs('a', T0)).toBe(10 * MINUTE);
  });
});
