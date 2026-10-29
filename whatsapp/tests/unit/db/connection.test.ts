import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createUnitOfWork, openDatabase } from '../../../src/db/connection.js';
import { errorOf, useMemoryDb, useTempDir } from './fixture.js';

describe('openDatabase', () => {
  it('создаёт недостающие папки файла и включает WAL, внешние ключи и ожидание блокировки', () => {
    const dir = useTempDir();
    const path = join(dir.path, 'nested', 'deeper', 'tanbala.db');

    const db = dir.track(openDatabase(path));

    expect(existsSync(path)).toBe(true);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('база в памяти: без WAL, но с внешними ключами и ожиданием блокировки', () => {
    const db = useMemoryDb();

    expect(db.memory).toBe(true);
    expect(db.pragma('journal_mode', { simple: true })).toBe('memory');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('повторное открытие файла видит прежние данные', () => {
    const dir = useTempDir();
    const path = join(dir.path, 'tanbala.db');
    const first = dir.track(openDatabase(path));
    first.exec('CREATE TABLE t (v INTEGER NOT NULL) STRICT; INSERT INTO t (v) VALUES (42);');
    first.close();

    const second = dir.track(openDatabase(path));

    expect(second.prepare('SELECT v FROM t').pluck().get()).toBe(42);
  });

  it('сбой открытия не прячется: на месте папки лежит файл', () => {
    const dir = useTempDir();
    const blocker = join(dir.path, 'not-a-dir');
    writeFileSync(blocker, '');

    expect(() => openDatabase(join(blocker, 'tanbala.db'))).toThrow();
  });
});

describe('createUnitOfWork', () => {
  function setup(db: Database.Database = useMemoryDb()) {
    db.exec('CREATE TABLE t (v INTEGER NOT NULL) STRICT');
    const insert = db.prepare<[number]>('INSERT INTO t (v) VALUES (?)');
    return {
      uow: createUnitOfWork(db),
      insert: (value: number): void => {
        insert.run(value);
      },
      values: (): unknown[] => db.prepare('SELECT v FROM t ORDER BY v').pluck().all(),
    };
  }

  it('run возвращает результат работы и сохраняет все записи', () => {
    const { uow, insert, values } = setup();

    const result = uow.run(() => {
      insert(1);
      insert(2);
      return 'готово';
    });

    expect(result).toBe('готово');
    expect(values()).toEqual([1, 2]);
  });

  it('исключение откатывает все записи и пробрасывается как есть', () => {
    const { uow, insert, values } = setup();
    const failure = new Error('сбой посреди работы');

    const error = errorOf(() =>
      uow.run(() => {
        insert(1);
        throw failure;
      }),
    );

    expect(error).toBe(failure);
    expect(values()).toEqual([]);
  });

  it('вложенный run откатывает только свою часть, если внешний перехватил ошибку', () => {
    const { uow, insert, values } = setup();

    uow.run(() => {
      insert(1);
      const inner = errorOf(() =>
        uow.run(() => {
          insert(2);
          throw new Error('сбой внутри');
        }),
      );
      expect(inner).toBeInstanceOf(Error);
      insert(3);
    });

    expect(values()).toEqual([1, 3]);
  });

  it('асинхронная работа запрещена: TypeError и откат', () => {
    const { uow, insert, values } = setup();

    const error = errorOf(() =>
      uow.run(() => {
        insert(1);
        return Promise.resolve();
      }),
    );

    expect(error).toBeInstanceOf(TypeError);
    expect(values()).toEqual([]);
  });

  it('транзакция сразу берёт блокировку записи: второе соединение не начнёт запись', () => {
    const dir = useTempDir();
    const path = join(dir.path, 'tanbala.db');
    const { uow } = setup(dir.track(openDatabase(path)));
    const other = dir.track(new Database(path, { timeout: 0 }));

    const error = uow.run(() => errorOf(() => other.exec('BEGIN IMMEDIATE')));

    expect(error).toMatchObject({ code: 'SQLITE_BUSY' });
  });
});
