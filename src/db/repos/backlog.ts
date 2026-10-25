import type Database from 'better-sqlite3';
import type { BacklogRepo } from '../../domain/ports.js';
import type { BacklogChat, ChatId, PhoneDigits } from '../../domain/types.js';
import { assertTimeMs } from '../time.js';

/** Строка listPending: имена колонок уже как в BacklogChat. */
interface PendingRow {
  readonly chatId: number;
  readonly name: string | null;
  readonly phone: string | null;
  readonly lastMessageAtMs: number;
}

/**
 * Чаты простоя в SQLite (таблица backlog_chats): одна строка на чат, без потерь при падении и без дублей.
 * markStale: более позднее сообщение сдвигает marked_at_ms и сбрасывает notified_at_ms (менеджер узнает о новом
 * старом сообщении); то же или более раннее время (повторная доставка) ничего не меняет.
 * listPending: чаты без notified_at_ms с именем и номером из chats, давние первыми.
 * markNotified: notified_at_ms = nowMs для переданных чатов одной транзакцией. Только подготовленные запросы.
 */
export function createBacklogRepo(db: Database.Database): BacklogRepo {
  const upsertStale = db.prepare<{ chatId: ChatId; atMs: number }>(
    `INSERT INTO backlog_chats (chat_id, marked_at_ms, notified_at_ms) VALUES (@chatId, @atMs, NULL)
     ON CONFLICT (chat_id) DO UPDATE SET
       marked_at_ms = excluded.marked_at_ms,
       notified_at_ms = NULL
     WHERE excluded.marked_at_ms > backlog_chats.marked_at_ms`,
  );
  const selectPending = db.prepare<[], PendingRow>(
    `SELECT b.chat_id AS chatId, c.push_name AS name, c.phone AS phone, b.marked_at_ms AS lastMessageAtMs
     FROM backlog_chats AS b JOIN chats AS c ON c.id = b.chat_id
     WHERE b.notified_at_ms IS NULL
     ORDER BY b.marked_at_ms, b.chat_id`,
  );
  const setNotified = db.prepare<{ chatId: ChatId; nowMs: number }>(
    'UPDATE backlog_chats SET notified_at_ms = @nowMs WHERE chat_id = @chatId',
  );
  const markAllNotified = db.transaction((chatIds: readonly ChatId[], nowMs: number) => {
    for (const chatId of chatIds) setNotified.run({ chatId, nowMs });
  });
  return {
    markStale(chatId: ChatId, lastMessageAtMs: number): void {
      assertTimeMs(lastMessageAtMs, 'lastMessageAtMs');
      upsertStale.run({ chatId, atMs: lastMessageAtMs });
    },
    listPending(): readonly BacklogChat[] {
      return selectPending.all().map(toBacklogChat);
    },
    markNotified(chatIds: readonly ChatId[], nowMs: number): void {
      assertTimeMs(nowMs, 'nowMs');
      markAllNotified.immediate(chatIds, nowMs);
    },
  };
}

function toBacklogChat(row: PendingRow): BacklogChat {
  return {
    chatId: row.chatId as ChatId,
    name: row.name,
    phone: row.phone as PhoneDigits | null,
    lastMessageAtMs: row.lastMessageAtMs,
  };
}
