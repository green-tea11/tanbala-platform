import type { Logger } from '../../src/domain/ports.js';

/** Запись лога так, как её получил логгер: сырые аргументы, до любой маскировки. */
export interface LogEntry {
  readonly level: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly message: string | undefined;
}

/** Логгер, который складывает записи в entries: видно, что именно ушло бы в лог. */
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
