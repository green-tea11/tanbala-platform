import type { CallBudget, Clock, Logger, TokenLog } from '../../../src/domain/ports.js';
import type { TokenUsageEntry } from '../../../src/domain/types.js';

// Фейки портов для тестов адаптеров LLM: без диска, сети и реального времени.

export const NOW = Date.UTC(2026, 9, 26, 7, 30, 0);

export const fixedClock: Clock = { now: () => NOW, sleep: () => Promise.resolve() };

export interface LogEntry {
  readonly level: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly message: string | undefined;
}

/** Логгер, который запоминает сырые аргументы: видно, что ушло в лог до любой маскировки. */
export function createFakeLogger(entries: LogEntry[]): Logger {
  const log =
    (level: string) =>
    (context: Readonly<Record<string, unknown>>, message?: string): void => {
      entries.push({ level, context, message });
    };
  const logger: Logger = {
    level: 'debug',
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    fatal: log('fatal'),
    silent: log('silent'),
    child: () => logger,
  };
  return logger;
}

/** Лог расхода в памяти; onRecord позволяет отметить порядок вызовов или уронить запись. */
export function createMemoryTokenLog(
  records: TokenUsageEntry[],
  onRecord: () => void = () => undefined,
): TokenLog {
  return {
    record: (entry: TokenUsageEntry): Promise<void> => {
      try {
        onRecord();
      } catch (error: unknown) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      records.push(entry);
      return Promise.resolve();
    },
  };
}

/** Предохранитель, который всегда разрешает вызов. */
export const openBudget: CallBudget = { tryConsume: () => ({ ok: true }) };
