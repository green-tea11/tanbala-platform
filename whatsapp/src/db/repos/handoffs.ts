import type Database from 'better-sqlite3';
import type { HandoffsRepo } from '../../domain/ports.js';
import type { ChatId, HandoffReason, InterestLevel, OpenHandoff } from '../../domain/types.js';
import { assertTimeMs } from '../time.js';
import { HANDOFF_REASONS, LEVELS, oneOf } from '../values.js';

/** Колонки open. */
interface OpenParams {
  readonly chatId: ChatId;
  readonly reason: HandoffReason;
  readonly level: InterestLevel;
  readonly snapshot: string;
  readonly nowMs: number;
}

/** Строка findOpen: имена колонок уже как в OpenHandoff. */
interface OpenRow {
  readonly reason: string;
  readonly level: string;
  readonly openedAtMs: number;
}

/**
 * Передачи чатов менеджеру в SQLite (таблица handoffs). Открытая передача на чат одна (частичный уникальный индекс
 * по chat_id среди строк без resolved_at_ms), поэтому все методы адресуются по chatId. Только подготовленные запросы.
 * open: ON CONFLICT по этому индексу не пишет вторую открытую передачу и возвращает false; прочие ошибки (чата нет,
 * причина или уровень вне списка) остаются ошибками, а не тихим false. open и chats.setStatus вызываются в одной
 * транзакции на общем соединении (UnitOfWork.run из db/connection.ts): репозиторий сам транзакций не открывает.
 * resolve закрывает открытую передачу (возврат чата боту из панели), историю не удаляет; закрытие не раньше открытия,
 * даже если часы ушли назад. Судьба уведомления о передаче хранится не здесь, а в manager_notifications.
 */
export function createHandoffsRepo(db: Database.Database): HandoffsRepo {
  const insertOpen = db.prepare<OpenParams>(
    `INSERT INTO handoffs (chat_id, reason, level, snapshot, opened_at_ms)
     VALUES (@chatId, @reason, @level, @snapshot, @nowMs)
     ON CONFLICT (chat_id) WHERE resolved_at_ms IS NULL DO NOTHING`,
  );
  const selectOpen = db.prepare<[ChatId], OpenRow>(
    `SELECT reason, level, opened_at_ms AS openedAtMs FROM handoffs
     WHERE chat_id = ? AND resolved_at_ms IS NULL`,
  );
  const updateResolved = db.prepare<{ chatId: ChatId; nowMs: number }>(
    `UPDATE handoffs SET resolved_at_ms = max(@nowMs, opened_at_ms)
     WHERE chat_id = @chatId AND resolved_at_ms IS NULL`,
  );
  return {
    open(
      chatId: ChatId,
      reason: HandoffReason,
      level: InterestLevel,
      snapshot: string,
      nowMs: number,
    ): boolean {
      assertTimeMs(nowMs, 'nowMs');
      return insertOpen.run({ chatId, reason, level, snapshot, nowMs }).changes === 1;
    },
    findOpen(chatId: ChatId): OpenHandoff | null {
      const row = selectOpen.get(chatId);
      return row === undefined ? null : toOpenHandoff(row);
    },
    resolve(chatId: ChatId, nowMs: number): void {
      assertTimeMs(nowMs, 'nowMs');
      updateResolved.run({ chatId, nowMs });
    },
  };
}

function toOpenHandoff(row: OpenRow): OpenHandoff {
  return {
    reason: oneOf(HANDOFF_REASONS, row.reason, 'В handoffs неизвестная причина передачи'),
    level: oneOf(LEVELS, row.level, 'В handoffs неизвестный уровень интереса'),
    openedAtMs: row.openedAtMs,
  };
}
