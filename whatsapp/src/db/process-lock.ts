import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { ProcessLock } from '../domain/ports.js';
import { SafeError } from '../shared/safe-error.js';

/** Папку данных держит другой процесс: второй экземпляр бота не запускается. */
export class ProcessLockBusyError extends SafeError {
  override readonly name: string = 'ProcessLockBusyError';

  constructor(options?: ErrorOptions) {
    super('Бот уже запущен: папка данных занята другим процессом', options);
  }
}

/**
 * Замок «бот уже запущен» на папку данных: отдельный файл SQLite (path), открытый в locking_mode = EXCLUSIVE
 * с транзакцией BEGIN EXCLUSIVE до release. Замок держит ОС: если процесс упал, она снимает его сама, поэтому нет
 * ни гонки при захвате, ни ложной занятости из-за повторного PID. Журнал в памяти: в файл ничего не пишется,
 * и после падения рядом не остаётся файла -journal. Ожидания нет: занято => сразу ProcessLockBusyError
 * (текст безопасно показать владельцу, подробности в cause); прочие сбои пробрасываются как есть.
 */
export function acquireProcessLock(path: string): ProcessLock {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { timeout: 0 });
  try {
    db.pragma('locking_mode = EXCLUSIVE');
    db.pragma('journal_mode = MEMORY');
    db.exec('BEGIN EXCLUSIVE');
  } catch (error: unknown) {
    db.close();
    if (isBusy(error)) throw new ProcessLockBusyError({ cause: error });
    throw error;
  }
  return {
    release(): void {
      // close откатывает открытую транзакцию и отпускает блокировку файла.
      if (db.open) db.close();
    },
  };
}

function isBusy(error: unknown): boolean {
  return error instanceof Database.SqliteError && error.code.startsWith('SQLITE_BUSY');
}
