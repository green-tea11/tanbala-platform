const MINUTE_MS = 60_000;

export interface LoginLimiterOptions {
  /** Попыток с одного адреса за окно. */
  readonly ipMax: number;
  readonly ipWindowMs: number;
  /** Попыток на одно имя (любое, в том числе несуществующее) за окно. */
  readonly nameMax: number;
  readonly nameWindowMs: number;
  /** Сколько адресов и имён помнить; лишние самые давние забываются, память не растёт от потока чужих ключей. */
  readonly maxKeys: number;
  /**
   * Сколько помнить, что с этого адреса под этим именем уже входили: такой паре окно имени не мешает (окно адреса
   * действует). Иначе любой, кто прошёл пароль Caddy, мог бы 10 неудачами в час держать владельца без входа.
   */
  readonly trustMs: number;
}

export const DEFAULT_LIMITS: LoginLimiterOptions = {
  ipMax: 5,
  ipWindowMs: 10 * MINUTE_MS,
  nameMax: 10,
  nameWindowMs: 60 * MINUTE_MS,
  maxKeys: 1000,
  trustMs: 30 * 24 * 60 * MINUTE_MS,
};

/** Допуск к проверке пароля. Ровно один из методов вызывается, когда проверка закончилась. */
export interface LoginTicket {
  /** Вход удался: попытка не засчитывается (возвращается), проверка для адреса и имени свободна. */
  succeeded(): void;
  /** Неверный пароль: попытка остаётся засчитанной. */
  failed(): void;
  /** Проверка не состоялась (сервер занят): попытка возвращается. */
  cancelled(): void;
}

export type Admission =
  | { readonly ok: true; readonly ticket: LoginTicket }
  | { readonly ok: false; readonly reason: 'limited'; readonly retryAfterMs: number }
  | { readonly ok: false; readonly reason: 'busy' };

export interface LoginLimiter {
  /**
   * Можно ли проверять пароль сейчас. Попытка засчитывается здесь, до расчёта хэша: одновременные запросы не
   * обгонят предел. Отказ, если у адреса или имени уже идёт проверка (busy) или окно заполнено (limited).
   */
  admit(ip: string, name: string, nowMs: number): Admission;
}

type Stamps = readonly number[];

/** Окна попыток по ключу: Map хранит ключи в порядке вставки, самые давние вытесняются первыми. */
function createWindows(windowMs: number, maxKeys: number) {
  const stamps = new Map<string, Stamps>();
  const live = (key: string, nowMs: number): Stamps =>
    (stamps.get(key) ?? []).filter((at) => at > nowMs - windowMs);
  return {
    live,
    add(key: string, nowMs: number): void {
      const next = [...live(key, nowMs), nowMs];
      stamps.delete(key);
      stamps.set(key, next);
      while (stamps.size > maxKeys) {
        const oldest = stamps.keys().next();
        if (oldest.done === true) break;
        stamps.delete(oldest.value);
      }
    },
    remove(key: string, at: number): void {
      const current = stamps.get(key);
      if (current === undefined) return;
      const index = current.indexOf(at);
      if (index >= 0) stamps.set(key, [...current.slice(0, index), ...current.slice(index + 1)]);
    },
    /** Через сколько мс освободится место, если окно заполнено (max попыток); иначе 0. */
    waitMs(key: string, max: number, nowMs: number): number {
      const current = live(key, nowMs);
      if (current.length < max) return 0;
      const freeing = current[current.length - max] ?? nowMs;
      return freeing + windowMs - nowMs;
    },
  };
}

/** Пары «адрес + имя» с успешным входом: до какого момента окно имени для них не действует. */
function createTrust(trustMs: number, maxKeys: number) {
  const until = new Map<string, number>();
  const keyOf = (ip: string, name: string): string => `${ip}\n${name}`;
  return {
    has: (ip: string, name: string, nowMs: number): boolean =>
      (until.get(keyOf(ip, name)) ?? 0) > nowMs,
    add(ip: string, name: string, nowMs: number): void {
      const key = keyOf(ip, name);
      until.delete(key);
      until.set(key, nowMs + trustMs);
      while (until.size > maxKeys) {
        const oldest = until.keys().next();
        if (oldest.done === true) break;
        until.delete(oldest.value);
      }
    },
  };
}

/**
 * Ограничитель входа: 5 попыток за 10 минут на адрес и 10 за час на имя (кроме адресов, с которых под этим именем
 * уже входили), одна проверка сразу на адрес и на имя. Всё в памяти: перезапуск консоли сбрасывает счётчики.
 */
export function createLoginLimiter(overrides: Partial<LoginLimiterOptions> = {}): LoginLimiter {
  const options: LoginLimiterOptions = { ...DEFAULT_LIMITS, ...overrides };
  const byIp = createWindows(options.ipWindowMs, options.maxKeys);
  const byName = createWindows(options.nameWindowMs, options.maxKeys);
  const trust = createTrust(options.trustMs, options.maxKeys);
  const busyIps = new Set<string>();
  const busyNames = new Set<string>();

  return {
    admit(ip, name, nowMs) {
      if (busyIps.has(ip) || busyNames.has(name)) return { ok: false, reason: 'busy' };
      const nameWaitMs = trust.has(ip, name, nowMs)
        ? 0
        : byName.waitMs(name, options.nameMax, nowMs);
      const retryAfterMs = Math.max(byIp.waitMs(ip, options.ipMax, nowMs), nameWaitMs);
      if (retryAfterMs > 0) return { ok: false, reason: 'limited', retryAfterMs };
      byIp.add(ip, nowMs);
      byName.add(name, nowMs);
      busyIps.add(ip);
      busyNames.add(name);
      let open = true;
      const finish = (refund: boolean): void => {
        if (!open) return;
        open = false;
        busyIps.delete(ip);
        busyNames.delete(name);
        if (refund) {
          byIp.remove(ip, nowMs);
          byName.remove(name, nowMs);
        }
      };
      return {
        ok: true,
        ticket: {
          succeeded: () => {
            if (open) trust.add(ip, name, nowMs);
            finish(true);
          },
          failed: () => finish(false),
          cancelled: () => finish(true),
        },
      };
    },
  };
}

export interface HashGateOptions {
  /** Сколько расчётов scrypt идёт одновременно (около 32 МиБ каждый). */
  readonly maxActive: number;
  /** Сколько ждут в очереди; сверх этого отказ без расчёта. */
  readonly maxQueued: number;
}

export const DEFAULT_GATE: HashGateOptions = { maxActive: 2, maxQueued: 4 };

export type GateResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/** Общий семафор расчётов хэша для всей консоли. */
export interface HashGate {
  run<T>(work: () => Promise<T>): Promise<GateResult<T>>;
}

export function createHashGate(overrides: Partial<HashGateOptions> = {}): HashGate {
  const options: HashGateOptions = { ...DEFAULT_GATE, ...overrides };
  let active = 0;
  const queue: (() => void)[] = [];
  const release = (): void => {
    const next = queue.shift();
    if (next === undefined) active -= 1;
    else next();
  };
  const acquire = (): Promise<void> | null => {
    if (active < options.maxActive) {
      active += 1;
      return Promise.resolve();
    }
    if (queue.length >= options.maxQueued) return null;
    return new Promise((resolve) => queue.push(resolve));
  };
  return {
    async run(work) {
      const slot = acquire();
      if (slot === null) return { ok: false };
      await slot;
      try {
        return { ok: true, value: await work() };
      } finally {
        release();
      }
    },
  };
}
