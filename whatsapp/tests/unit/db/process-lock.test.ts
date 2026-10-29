import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { acquireProcessLock, ProcessLockBusyError } from '../../../src/db/process-lock.js';
import type { ProcessLock } from '../../../src/domain/ports.js';
import { SafeError } from '../../../src/shared/safe-error.js';
import { ROOT } from '../../helpers/source-files.js';
import { errorOf, type TempDir, useTempDir } from './fixture.js';

const BUSY_TEXT = 'Бот уже запущен: папка данных занята другим процессом';

// Другой процесс держит замок тем же способом, что и бот: эксклюзивная блокировка файла SQLite.
const HOLDER = [
  "const Database = require('better-sqlite3');",
  'const db = new Database(process.argv[1], { timeout: 0 });',
  "db.pragma('locking_mode = EXCLUSIVE');",
  "db.pragma('journal_mode = MEMORY');",
  "db.exec('BEGIN EXCLUSIVE');",
  "console.log('locked');",
  'setInterval(() => {}, 1000);',
].join(' ');

type Holder = ChildProcessByStdio<null, Readable, null>;

/** Захватывает замок и снимает его после теста, даже если тест упал. */
function lockFor(dir: TempDir, path: string): ProcessLock {
  const lock = acquireProcessLock(path);
  dir.defer(() => {
    lock.release();
  });
  return lock;
}

/** Запускает процесс-владельца замка и ждёт, пока он захватит файл. */
async function holdInOtherProcess(dir: TempDir, path: string): Promise<Holder> {
  const holder = spawn(process.execPath, ['-e', HOLDER, path], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  dir.defer(() => {
    holder.kill();
  });
  await new Promise<void>((resolve, reject) => {
    holder.stdout.once('data', () => {
      resolve();
    });
    holder.once('exit', (code) => {
      reject(new Error(`Владелец замка завершился раньше времени: код ${String(code)}`));
    });
  });
  return holder;
}

describe('acquireProcessLock', () => {
  it('захватывает замок и создаёт недостающую папку', () => {
    const dir = useTempDir();
    const path = join(dir.path, 'data', 'bot.lock');

    lockFor(dir, path);

    expect(existsSync(path)).toBe(true);
  });

  it('второй захват того же пути падает ProcessLockBusyError с безопасным текстом', () => {
    const dir = useTempDir();
    const path = join(dir.path, 'bot.lock');
    lockFor(dir, path);

    const error = errorOf(() => acquireProcessLock(path));

    expect(error).toBeInstanceOf(ProcessLockBusyError);
    expect(error).toBeInstanceOf(SafeError);
    expect(error).toMatchObject({
      name: 'ProcessLockBusyError',
      message: BUSY_TEXT,
      cause: expect.objectContaining({ code: 'SQLITE_BUSY' }) as unknown,
    });
  });

  it('после release тот же путь захватывается снова; неудачный захват файл не держит', () => {
    const dir = useTempDir();
    const path = join(dir.path, 'bot.lock');
    const first = acquireProcessLock(path);
    expect(errorOf(() => acquireProcessLock(path))).toBeInstanceOf(ProcessLockBusyError);

    first.release();

    expect(() => lockFor(dir, path)).not.toThrow();
  });

  it('release идемпотентный', () => {
    const dir = useTempDir();
    const path = join(dir.path, 'bot.lock');
    const lock = acquireProcessLock(path);

    lock.release();

    expect(() => {
      lock.release();
    }).not.toThrow();
    expect(() => lockFor(dir, path)).not.toThrow();
  });

  it('замок держит ОС: занят, пока жив другой процесс, и свободен после его гибели', async () => {
    const dir = useTempDir();
    const path = join(dir.path, 'bot.lock');
    const holder = await holdInOtherProcess(dir, path);

    expect(errorOf(() => acquireProcessLock(path))).toBeInstanceOf(ProcessLockBusyError);

    const exited = once(holder, 'exit');
    holder.kill();
    await exited;

    expect(() => lockFor(dir, path)).not.toThrow();
  });

  it('прочий сбой не выдаётся за занятый замок: на месте файла замка не база', () => {
    const dir = useTempDir();
    const path = join(dir.path, 'bot.lock');
    writeFileSync(path, 'не база SQLite '.repeat(300));

    const error = errorOf(() => acquireProcessLock(path));

    expect(error).not.toBeInstanceOf(ProcessLockBusyError);
    expect(error).toMatchObject({ code: 'SQLITE_NOTADB' });
  });
});
