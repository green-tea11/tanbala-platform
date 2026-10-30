/** Часы консоли: в тестах подменяются, чтобы проверять сроки сессий и окна попыток входа. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
