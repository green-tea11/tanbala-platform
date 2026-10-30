import { pino } from 'pino';
import type { LogDestination } from './logger.js';

/**
 * Сколько вывод может подряд отвечать EAGAIN или EBUSY, прежде чем строка лога бросается. pino по умолчанию пишет
 * синхронно и повторяет такую запись бесконечно (Atomics.wait): если терминал SSH пропал, а sudo держит свой pty и
 * больше его не читает, бот висел бы на строке лога, возможно с открытой базой (проверка на сервере 30.10.2026).
 */
export const MAX_BLOCKED_OUTPUT_MS = 2_000;

/** Когда повторять запись в stdout. */
export interface OutputGuard {
  /** Повторять ли запись после EAGAIN или EBUSY: да, пока вывод занят меньше MAX_BLOCKED_OUTPUT_MS и не было SIGHUP. */
  readonly retry: () => boolean;
  /** Запись прошла: отсчёт занятости заново. */
  readonly written: () => void;
  /** Терминал закрыт (SIGHUP): вывод больше не ждать вовсе. */
  readonly hangUp: () => void;
}

export function createOutputGuard(now: () => number = Date.now): OutputGuard {
  let blockedSince: number | null = null;
  let hungUp = false;
  return {
    retry: () => {
      if (hungUp) return false;
      const at = now();
      blockedSince ??= at;
      return at - blockedSince < MAX_BLOCKED_OUTPUT_MS;
    },
    written: () => {
      blockedSince = null;
    },
    hangUp: () => {
      hungUp = true;
    },
  };
}

/**
 * stdout для лога: синхронно, как pino по умолчанию, но повтор после EAGAIN решает guard. Брошенная запись приходит в
 * onError ошибкой с кодом EAGAIN или EBUSY.
 */
export function createStdoutDestination(
  guard: OutputGuard,
  onError: (error: unknown) => void,
): LogDestination {
  const stream = pino.destination({ dest: 1, sync: true, retryEAGAIN: guard.retry });
  stream.on('write', guard.written);
  stream.on('error', onError);
  return stream;
}
