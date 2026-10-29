/** Ограничение неудачных попыток входа по ключу (адрес клиента). Всё в памяти. */
export interface LoginLimiter {
  /** Через сколько мс можно пробовать снова; 0: можно сейчас. */
  retryAfterMs(key: string, nowMs: number): number;
  recordFailure(key: string, nowMs: number): void;
  /** Успешный вход: счётчик ключа обнуляется. */
  reset(key: string): void;
}

export interface LoginLimiterOptions {
  /** Столько неудач за окно закрывают вход ключу. */
  readonly maxFailures: number;
  readonly windowMs: number;
  /** Сколько ключей помнить; лишние старые забываются, память не растёт от потока чужих адресов. */
  readonly maxKeys: number;
}

const DEFAULT_OPTIONS: LoginLimiterOptions = {
  maxFailures: 5,
  windowMs: 10 * 60 * 1000,
  maxKeys: 1000,
};

/**
 * Скользящее окно неудач на ключ: maxFailures неудач за windowMs закрывают вход, пока самая старая из них
 * не выйдет из окна. Ключом служит адрес клиента (request.ip; за Caddy на 127.0.0.1 это адрес из X-Forwarded-For).
 */
export function createLoginLimiter(overrides: Partial<LoginLimiterOptions> = {}): LoginLimiter {
  const options: LoginLimiterOptions = { ...DEFAULT_OPTIONS, ...overrides };
  const failures = new Map<string, readonly number[]>();
  const inWindow = (key: string, nowMs: number): readonly number[] =>
    (failures.get(key) ?? []).filter((failedAtMs) => failedAtMs > nowMs - options.windowMs);

  return {
    retryAfterMs(key: string, nowMs: number): number {
      const stamps = inWindow(key, nowMs);
      if (stamps.length < options.maxFailures) return 0;
      // Место освободится, когда выйдет из окна неудача под этим номером (от старых к новым).
      const freeing = stamps[stamps.length - options.maxFailures] ?? nowMs;
      return freeing + options.windowMs - nowMs;
    },
    recordFailure(key: string, nowMs: number): void {
      const stamps = inWindow(key, nowMs);
      // Ключ переставляется в конец порядка вставки: вытесняются самые давние.
      failures.delete(key);
      failures.set(key, [...stamps, nowMs]);
      while (failures.size > options.maxKeys) {
        const oldest = failures.keys().next();
        if (oldest.done === true) break;
        failures.delete(oldest.value);
      }
    },
    reset(key: string): void {
      failures.delete(key);
    },
  };
}
