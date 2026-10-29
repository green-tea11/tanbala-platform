import type Database from 'better-sqlite3';
import type { RejectedDraftsRepo } from '../../domain/ports.js';
import type {
  ChatId,
  RejectedDraft,
  RejectionSource,
  StoredRejectedDraft,
} from '../../domain/types.js';
import { assertTimeMs } from '../time.js';
import { oneOf } from '../values.js';

const SOURCES: readonly RejectionSource[] = ['code', 'review'];

interface Row {
  readonly id: number;
  readonly chatId: number;
  readonly attempt: number;
  readonly source: string;
  readonly draft: string;
  readonly remarks: string;
  readonly atMs: number;
}

/** Замечания из JSON; не массив строк (строка испорчена) => пустой список: карточка чата всё равно открывается. */
function remarksOf(json: string): readonly string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
  } catch {
    return [];
  }
}

function toStored(row: Row): StoredRejectedDraft {
  return {
    id: row.id,
    chatId: row.chatId as ChatId,
    attempt: row.attempt === 2 ? 2 : 1,
    source: oneOf(SOURCES, row.source, 'В rejected_drafts неизвестный источник'),
    draft: row.draft,
    remarks: remarksOf(row.remarks),
    atMs: row.atMs,
  };
}

/**
 * Отклонённые черновики в SQLite (таблица rejected_drafts, схема версии 10). Только подготовленные запросы. Попытку вне
 * 1 и 2 и источник вне списка отклоняет CHECK таблицы; время проверяется до записи. Замечания хранятся JSON-массивом.
 * Чтение для карточки чата: свежие первыми, при равном времени позже записанный. deleteOlderThan: срок хранения.
 */
export function createRejectedDraftsRepo(db: Database.Database): RejectedDraftsRepo {
  const insert = db.prepare<{
    chatId: ChatId;
    attempt: number;
    source: string;
    draft: string;
    remarks: string;
    atMs: number;
  }>(
    `INSERT INTO rejected_drafts (chat_id, attempt, source, draft, remarks, at_ms)
     VALUES (@chatId, @attempt, @source, @draft, @remarks, @atMs)`,
  );
  const selectForChat = db.prepare<[ChatId, number], Row>(
    `SELECT id, chat_id AS chatId, attempt, source, draft, remarks, at_ms AS atMs
     FROM rejected_drafts WHERE chat_id = ? ORDER BY at_ms DESC, id DESC LIMIT ?`,
  );
  const deleteOlder = db.prepare<[number]>('DELETE FROM rejected_drafts WHERE at_ms < ?');
  return {
    add(entry: RejectedDraft): void {
      assertTimeMs(entry.atMs, 'atMs');
      insert.run({
        chatId: entry.chatId,
        attempt: entry.attempt,
        source: entry.source,
        draft: entry.draft,
        remarks: JSON.stringify(entry.remarks),
        atMs: entry.atMs,
      });
    },
    listForChat(chatId: ChatId, limit: number): readonly StoredRejectedDraft[] {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new RangeError('limit: ожидается целое число больше нуля');
      }
      return selectForChat.all(chatId, limit).map(toStored);
    },
    deleteOlderThan(cutoffMs: number): number {
      assertTimeMs(cutoffMs, 'cutoffMs');
      return deleteOlder.run(cutoffMs).changes;
    },
  };
}
