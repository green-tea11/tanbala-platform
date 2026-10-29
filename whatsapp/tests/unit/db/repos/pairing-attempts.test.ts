import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../../src/db/connection.js';
import { runMigrations } from '../../../../src/db/migrations.js';
import {
  createPairingGuard,
  PAIRING_MAX_ATTEMPTS_PER_DAY,
} from '../../../../src/db/repos/pairing-attempts.js';
import { errorOf, useMigratedDb, useTempDir } from '../fixture.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = 1_761_400_000_000;
const MIRROR_NAME = '.pairing-attempts.json';

function setup() {
  const dir = useTempDir();
  const db = useMigratedDb();
  const mirrorPath = join(dir.path, MIRROR_NAME);
  return { dir, db, mirrorPath, guard: createPairingGuard(db, mirrorPath) };
}

function storedAttempts(db: Database.Database): unknown[] {
  return db.prepare('SELECT at_ms FROM pairing_attempts ORDER BY at_ms').pluck().all();
}

function seedStored(db: Database.Database, ...attemptsMs: number[]): void {
  const insert = db.prepare('INSERT INTO pairing_attempts (at_ms) VALUES (?)');
  for (const atMs of attemptsMs) insert.run(atMs);
}

function seedMirror(path: string, attemptsMs: readonly number[]): void {
  writeFileSync(path, JSON.stringify({ attemptsMs }));
}

function mirrorContent(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('createPairingGuard: лимит попыток', () => {
  it('лимит задан в коде: две попытки за скользящие сутки', () => {
    expect(PAIRING_MAX_ATTEMPTS_PER_DAY).toBe(2);
  });

  it('первые две попытки разрешены, третья в те же сутки нет', () => {
    const { guard } = setup();

    expect(guard.tryBeginAttempt(T0)).toEqual({ ok: true, attemptsLeft: 1 });
    expect(guard.tryBeginAttempt(T0 + HOUR)).toEqual({ ok: true, attemptsLeft: 0 });
    expect(guard.tryBeginAttempt(T0 + 2 * HOUR)).toEqual({ ok: false, retryAfterMs: 22 * HOUR });
  });

  it('окно скользящее: попытка освобождается ровно через 24 часа после самой ранней', () => {
    const { guard } = setup();
    guard.tryBeginAttempt(T0);
    guard.tryBeginAttempt(T0 + HOUR);

    expect(guard.tryBeginAttempt(T0 + DAY - 1)).toEqual({ ok: false, retryAfterMs: 1 });
    expect(guard.tryBeginAttempt(T0 + DAY)).toEqual({ ok: true, attemptsLeft: 0 });
    expect(guard.tryBeginAttempt(T0 + DAY + 1)).toEqual({ ok: false, retryAfterMs: HOUR - 1 });
  });

  it('не календарные сутки: после попыток в 23:59 и 00:01 попытка в 00:02 запрещена', () => {
    const { guard } = setup();
    const lateEvening = Date.UTC(2026, 9, 25, 23, 59);
    const afterMidnight = Date.UTC(2026, 9, 26, 0, 1);
    guard.tryBeginAttempt(lateEvening);
    guard.tryBeginAttempt(afterMidnight);

    expect(guard.tryBeginAttempt(afterMidnight + 60_000)).toEqual({
      ok: false,
      retryAfterMs: lateEvening + DAY - (afterMidnight + 60_000),
    });
  });

  it('попытка со временем в будущем (часы перевели назад) считается внутри окна', () => {
    const { db, guard } = setup();
    seedStored(db, T0 + 3 * HOUR);

    expect(guard.tryBeginAttempt(T0)).toEqual({ ok: true, attemptsLeft: 0 });
    expect(guard.tryBeginAttempt(T0 + 1)).toEqual({ ok: false, retryAfterMs: DAY - 1 });
  });

  it('две попытки далеко в будущем держат лимит, пока не выйдут из окна', () => {
    const { db, guard } = setup();
    seedStored(db, T0 + 10 * DAY, T0 + 10 * DAY + 1);

    expect(guard.tryBeginAttempt(T0)).toEqual({ ok: false, retryAfterMs: 11 * DAY });
  });

  it('при лишних попытках в окне ждать, пока их останется меньше лимита', () => {
    const { db, guard } = setup();
    seedStored(db, T0, T0 + HOUR, T0 + 2 * HOUR);

    expect(guard.tryBeginAttempt(T0 + 3 * HOUR)).toEqual({
      ok: false,
      retryAfterMs: DAY - 2 * HOUR,
    });
  });

  it.each([-1, 1.5, Number.NaN])('отклоняет неверное время %s и ничего не пишет', (nowMs) => {
    const { db, guard, mirrorPath } = setup();

    expect(() => guard.tryBeginAttempt(nowMs)).toThrow(RangeError);
    expect(storedAttempts(db)).toEqual([]);
    expect(existsSync(mirrorPath)).toBe(false);
  });
});

describe('createPairingGuard: база и файл-копия', () => {
  it('разрешённая попытка пишется и в базу, и в файл, без временных файлов', () => {
    const { db, dir, guard, mirrorPath } = setup();

    guard.tryBeginAttempt(T0);

    expect(storedAttempts(db)).toEqual([T0]);
    expect(mirrorContent(mirrorPath)).toEqual({ attemptsMs: [T0] });
    expect(readdirSync(dir.path)).toEqual([MIRROR_NAME]);
  });

  it('отказ ничего не пишет: ни в базу, ни в файл', () => {
    const { db, guard, mirrorPath } = setup();
    guard.tryBeginAttempt(T0);
    guard.tryBeginAttempt(T0 + 1);
    const before = readFileSync(mirrorPath, 'utf8');

    guard.tryBeginAttempt(T0 + 2);

    expect(storedAttempts(db)).toEqual([T0, T0 + 1]);
    expect(readFileSync(mirrorPath, 'utf8')).toBe(before);
  });

  it('удаление базы не обнуляет лимит: счёт берётся и из файла', () => {
    const { guard, mirrorPath } = setup();
    seedMirror(mirrorPath, [T0, T0 + HOUR]);

    expect(guard.tryBeginAttempt(T0 + 2 * HOUR)).toEqual({ ok: false, retryAfterMs: 22 * HOUR });
  });

  it('удаление файла не обнуляет лимит: счёт берётся и из базы', () => {
    const { db, guard } = setup();
    seedStored(db, T0, T0 + HOUR);

    expect(guard.tryBeginAttempt(T0 + 2 * HOUR)).toEqual({ ok: false, retryAfterMs: 22 * HOUR });
  });

  it('одна и та же попытка в базе и в файле считается один раз', () => {
    const { db, guard, mirrorPath } = setup();
    seedStored(db, T0);
    seedMirror(mirrorPath, [T0]);

    expect(guard.tryBeginAttempt(T0 + HOUR)).toEqual({ ok: true, attemptsLeft: 0 });
    expect(storedAttempts(db)).toEqual([T0, T0 + HOUR]);
    expect(mirrorContent(mirrorPath)).toEqual({ attemptsMs: [T0, T0 + HOUR] });
  });

  it('разные попытки в базе и в файле складываются', () => {
    const { db, guard, mirrorPath } = setup();
    seedStored(db, T0);
    seedMirror(mirrorPath, [T0 + HOUR]);

    expect(guard.tryBeginAttempt(T0 + 2 * HOUR)).toEqual({ ok: false, retryAfterMs: 22 * HOUR });
  });

  it('пропавшие из базы попытки восстанавливаются из файла при следующей попытке', () => {
    const { db, guard, mirrorPath } = setup();
    seedMirror(mirrorPath, [T0]);

    expect(guard.tryBeginAttempt(T0 + HOUR)).toEqual({ ok: true, attemptsLeft: 0 });
    expect(storedAttempts(db)).toEqual([T0, T0 + HOUR]);
    expect(mirrorContent(mirrorPath)).toEqual({ attemptsMs: [T0, T0 + HOUR] });
  });

  it('пропавший файл восстанавливается из базы при следующей попытке', () => {
    const { db, guard, mirrorPath } = setup();
    seedStored(db, T0 - 3 * DAY, T0);

    guard.tryBeginAttempt(T0 + HOUR);

    expect(mirrorContent(mirrorPath)).toEqual({ attemptsMs: [T0 - 3 * DAY, T0, T0 + HOUR] });
  });

  it.each([
    ['не JSON', '{'],
    ['пустой файл', ''],
    ['список вместо объекта', '[1, 2]'],
    ['нет списка попыток', '{}'],
    ['время текстом', '{"attemptsMs":["вчера"]}'],
    ['дробное время', '{"attemptsMs":[1.5]}'],
    ['отрицательное время', '{"attemptsMs":[-1]}'],
  ])('испорченный файл (%s): явная ошибка, ничего не пишется', (_label, content) => {
    const { db, guard, mirrorPath } = setup();
    writeFileSync(mirrorPath, content);

    expect(() => guard.tryBeginAttempt(T0)).toThrow(/испорчен/);
    expect(storedAttempts(db)).toEqual([]);
    expect(readFileSync(mirrorPath, 'utf8')).toBe(content);
  });

  it('нечитаемый файл (на его месте папка): явная ошибка, ничего не пишется', () => {
    const { db, guard, mirrorPath } = setup();
    mkdirSync(mirrorPath);

    expect(() => guard.tryBeginAttempt(T0)).toThrow(/нечитаем/);
    expect(storedAttempts(db)).toEqual([]);
  });

  it('файл не записался: попытка не засчитана и в базе', () => {
    const { db, dir } = setup();
    const guard = createPairingGuard(db, join(dir.path, 'missing', MIRROR_NAME));

    expect(() => guard.tryBeginAttempt(T0)).toThrow(/записать/);
    expect(storedAttempts(db)).toEqual([]);
    expect(readdirSync(dir.path)).toEqual([]);
  });
});

describe('createPairingGuard: второй экземпляр', () => {
  function openMigrated(path: string): Database.Database {
    const db = openDatabase(path);
    runMigrations(db);
    return db;
  }

  it('два экземпляра на одной базе и одном файле вместе не проскочат лимит', () => {
    const dir = useTempDir();
    const dbPath = join(dir.path, 'tanbala.db');
    const mirrorPath = join(dir.path, MIRROR_NAME);
    const first = createPairingGuard(dir.track(openMigrated(dbPath)), mirrorPath);
    const second = createPairingGuard(dir.track(openMigrated(dbPath)), mirrorPath);

    expect(first.tryBeginAttempt(T0)).toEqual({ ok: true, attemptsLeft: 1 });
    expect(second.tryBeginAttempt(T0 + 1)).toEqual({ ok: true, attemptsLeft: 0 });
    expect(first.tryBeginAttempt(T0 + 2)).toMatchObject({ ok: false });
    expect(second.tryBeginAttempt(T0 + 3)).toMatchObject({ ok: false });
  });

  it('подсчёт идёт под блокировкой записи: пока пишет другое соединение, попытка не считается', () => {
    const dir = useTempDir();
    const dbPath = join(dir.path, 'tanbala.db');
    const mirrorPath = join(dir.path, MIRROR_NAME);
    const db = dir.track(openMigrated(dbPath));
    db.pragma('busy_timeout = 0');
    const other = dir.track(new Database(dbPath, { timeout: 0 }));
    other.exec('BEGIN IMMEDIATE');

    const error = errorOf(() => createPairingGuard(db, mirrorPath).tryBeginAttempt(T0));
    other.exec('ROLLBACK');

    expect(error).toMatchObject({ code: 'SQLITE_BUSY' });
    expect(storedAttempts(db)).toEqual([]);
    expect(existsSync(mirrorPath)).toBe(false);
  });
});
