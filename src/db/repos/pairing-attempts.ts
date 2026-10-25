import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { PairingDecision, PairingGuard } from '../../domain/ports.js';
import { assertTimeMs } from '../time.js';

/**
 * Не больше двух попыток привязки по QR за скользящие 24 часа (решение владельца).
 * Константа в коде, а не в .env: настройкой лимит не ослабить.
 */
export const PAIRING_MAX_ATTEMPTS_PER_DAY = 2;

/** Окно скользящее, 24 часа от текущего момента, а не календарные сутки: иначе две попытки в 23:59 и ещё две в 00:01. */
const PAIRING_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Файл-копия: {"attemptsMs":[...]}, время попыток в мс UTC по возрастанию. */
const mirrorSchema = z.object({ attemptsMs: z.array(z.int().nonnegative()) });

/**
 * Счётчик попыток привязки по QR в SQLite (таблица pairing_attempts) с копией вне data/.
 * mirrorPath: файл .pairing-attempts.json в корне проекта (в .gitignore); удаление data/ не обнуляет лимит.
 * В счёт идёт объединение попыток из базы и копии без дублей: одна копия не может уменьшить счётчик, а пропавшие
 * записи при следующей разрешённой попытке восстанавливаются в обе копии. Попытка со временем в будущем (часы
 * перевели назад) считается попавшей в окно. Отказ: retryAfterMs до момента, когда в окне останется меньше лимита;
 * при отказе ничего не пишется. Разрешённая попытка пишется в базу и в файл (временный файл, fsync, rename) в одной
 * транзакции db.transaction(...).immediate(): сбой записи файла откатывает базу, второй экземпляр ждёт блокировку
 * и не проскочит лимит. Только подготовленные запросы.
 * Файл есть, но нечитаем или испорчен => tryBeginAttempt бросает ошибку: молча обнулять лимит нельзя, а вызывающий
 * (whatsapp/connection.ts) не запускает привязку и пишет ошибку в лог.
 * Старые записи не удаляются: их не больше двух в сутки, а удаление при сбитых часах могло бы вернуть попытки.
 * requestPairingCode (привязка по коду) не использовать; если когда-нибудь понадобится, каждый вызов тоже попытка
 * через этот же счётчик.
 */
export function createPairingGuard(db: Database.Database, mirrorPath: string): PairingGuard {
  const selectAttempts = db.prepare<[], number>('SELECT at_ms FROM pairing_attempts').pluck();
  const insertAttempt = db.prepare<[number]>('INSERT INTO pairing_attempts (at_ms) VALUES (?)');
  const beginAttempt = db.transaction((nowMs: number): PairingDecision => {
    const stored = selectAttempts.all();
    const restored = missingFrom(stored, readMirror(mirrorPath));
    const known = [...stored, ...restored];
    const decision = decide(known, nowMs);
    if (!decision.ok) return decision;
    for (const atMs of [...restored, nowMs]) insertAttempt.run(atMs);
    writeMirror(mirrorPath, [...known, nowMs]);
    return decision;
  });
  return {
    tryBeginAttempt(nowMs: number): PairingDecision {
      assertTimeMs(nowMs, 'nowMs');
      return beginAttempt.immediate(nowMs);
    },
  };
}

function decide(attemptsMs: readonly number[], nowMs: number): PairingDecision {
  const windowStartMs = nowMs - PAIRING_WINDOW_MS;
  const inWindow = attemptsMs.filter((atMs) => atMs > windowStartMs).toSorted((a, b) => a - b);
  if (inWindow.length < PAIRING_MAX_ATTEMPTS_PER_DAY) {
    return { ok: true, attemptsLeft: PAIRING_MAX_ATTEMPTS_PER_DAY - inWindow.length - 1 };
  }
  // Лимит освободится, когда из окна выйдет самая ранняя из последних PAIRING_MAX_ATTEMPTS_PER_DAY попыток.
  const blockingAtMs = Math.min(...inWindow.slice(-PAIRING_MAX_ATTEMPTS_PER_DAY));
  return { ok: false, retryAfterMs: blockingAtMs + PAIRING_WINDOW_MS - nowMs };
}

/** Попытки копии, которых нет в базе: каждое время столько раз, на сколько в копии его больше. */
function missingFrom(stored: readonly number[], mirrored: readonly number[]): number[] {
  const missing = [...mirrored];
  for (const atMs of stored) {
    const index = missing.indexOf(atMs);
    if (index !== -1) missing.splice(index, 1);
  }
  return missing;
}

function readMirror(path: string): readonly number[] {
  const text = readMirrorText(path);
  if (text === null) return [];
  try {
    const data: unknown = JSON.parse(text);
    return mirrorSchema.parse(data).attemptsMs;
  } catch (error: unknown) {
    throw new Error(`Копия счётчика привязок по QR испорчена (${path}): привязка остановлена`, {
      cause: error,
    });
  }
}

/** Текст копии; null, если файла ещё нет (первая привязка). */
function readMirrorText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new Error(`Копия счётчика привязок по QR нечитаема (${path}): привязка остановлена`, {
      cause: error,
    });
  }
}

/** Пишет копию целиком через временный файл: при сбое на диске остаётся прежняя копия, а не половина новой. */
function writeMirror(path: string, attemptsMs: readonly number[]): void {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  const text = `${JSON.stringify({ attemptsMs: attemptsMs.toSorted((a, b) => a - b) })}\n`;
  try {
    writeDurably(tempPath, text);
    renameSync(tempPath, path);
  } catch (error: unknown) {
    rmSync(tempPath, { force: true });
    throw new Error(
      `Не удалось записать копию счётчика привязок по QR (${path}): попытка не засчитана`,
      {
        cause: error,
      },
    );
  }
}

function writeDurably(path: string, text: string): void {
  const fd = openSync(path, 'wx');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
