import type { Db } from './connection.js';

/**
 * Что пользователь уже видел: передачи от бота (id передачи), «писали после письма» (id чата) и уведомления
 * менеджеру (id уведомления). У бота отметки «просмотрено» нет, её хранит консоль у себя.
 */
export const SEEN_KINDS = ['handoff', 'after_letter', 'notification'] as const;
export type SeenKind = (typeof SEEN_KINDS)[number];

export interface SeenRepo {
  mark(userId: number, kind: SeenKind, ids: readonly number[], nowMs: number): void;
  /** Какие из ids пользователь уже отметил. */
  seenAmong(userId: number, kind: SeenKind, ids: readonly number[]): ReadonlySet<number>;
  purgeOlderThan(cutoffMs: number): number;
}

/** Сколько id за раз проверяется одним запросом (предел параметров SQLite намного выше). */
const CHUNK = 500;
/** Отметок одного вида у пользователя не больше этого: самые старые вытесняются (база не растёт без предела). */
export const SEEN_MAX_PER_KIND = 5000;

export function createSeenRepo(db: Db): SeenRepo {
  const upsert = db.prepare(
    `INSERT INTO seen_marks (user_id, kind, item_id, at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, kind, item_id) DO NOTHING`,
  );
  const trim = db.prepare(
    `DELETE FROM seen_marks WHERE user_id = ? AND kind = ? AND item_id NOT IN (
       SELECT item_id FROM seen_marks WHERE user_id = ? AND kind = ?
       ORDER BY at DESC, item_id DESC LIMIT ?)`,
  );
  const markAll = db.transaction(
    (userId: number, kind: SeenKind, ids: readonly number[], nowMs: number) => {
      ids.forEach((id) => upsert.run(userId, kind, id, nowMs));
      trim.run(userId, kind, userId, kind, SEEN_MAX_PER_KIND);
    },
  );
  const purge = db.prepare('DELETE FROM seen_marks WHERE at < ?');

  const seenChunk = (userId: number, kind: SeenKind, ids: readonly number[]): number[] => {
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare<unknown[], { item_id: number }>(
        `SELECT item_id FROM seen_marks WHERE user_id = ? AND kind = ? AND item_id IN (${placeholders})`,
      )
      .all(userId, kind, ...ids);
    return rows.map((row) => row.item_id);
  };

  return {
    mark(userId, kind, ids, nowMs) {
      markAll(userId, kind, ids, nowMs);
    },
    seenAmong(userId, kind, ids) {
      const unique = [...new Set(ids)];
      const found: number[] = [];
      for (let start = 0; start < unique.length; start += CHUNK) {
        found.push(...seenChunk(userId, kind, unique.slice(start, start + CHUNK)));
      }
      return new Set(found);
    },
    purgeOlderThan: (cutoffMs) => purge.run(cutoffMs).changes,
  };
}
