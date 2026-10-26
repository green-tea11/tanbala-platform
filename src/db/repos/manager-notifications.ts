import type Database from 'better-sqlite3';
import type { ManagerNotificationsRepo } from '../../domain/ports.js';
import type {
  ChatId,
  ManagerNotification,
  ManagerNotificationKind,
  ManagerNotificationStatus,
  WaMessageId,
} from '../../domain/types.js';
import { assertTimeMs } from '../time.js';
import { assertCount, oneOf } from '../values.js';

/** Строка таблицы manager_notifications: имена колонок уже как в ManagerNotification. */
interface NotificationRow {
  readonly id: number;
  readonly kind: string;
  readonly chatId: number | null;
  readonly text: string;
  readonly status: string;
  readonly attempts: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** Итог попытки отправки: статус без pending. */
type ResultStatus = Exclude<ManagerNotificationStatus, 'pending'>;

interface AddParams {
  readonly kind: ManagerNotificationKind;
  readonly chatId: ChatId | null;
  readonly text: string;
  readonly nowMs: number;
}

interface ResultParams {
  readonly id: number;
  readonly status: ResultStatus;
  readonly waId: WaMessageId | null;
  readonly nowMs: number;
}

interface RetryParams {
  readonly maxAttempts: number;
  readonly staleBeforeMs: number;
  readonly limit: number;
}

interface PageParams {
  readonly limit: number;
  readonly offset: number;
}

const KINDS: readonly ManagerNotificationKind[] = ['handoff', 'limit', 'backlog'];
const RESULT_STATUSES: readonly ResultStatus[] = ['sent', 'no_manager', 'skipped_limit', 'failed'];
const STATUSES: readonly ManagerNotificationStatus[] = ['pending', ...RESULT_STATUSES];

const SELECT_NOTIFICATION = `SELECT id, kind, chat_id AS chatId, text, status, attempts,
  created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs FROM manager_notifications`;

/**
 * Уведомления менеджеру в SQLite (таблица manager_notifications). Только подготовленные запросы.
 * add пишет уведомление ДО отправки: pending, ноль попыток, текст целиком; возвращает его id.
 * setResult записывает итог одной попытки: новый статус (не pending), ID отправленного сообщения (null, если не sent
 * или ID нет) и attempts + 1; неизвестный id => явная ошибка. Ошибки базы не глотаются: уведомление без записи
 * отправлять нельзя.
 * listRetryable: failed и зависшие pending (updated_at_ms не позже staleBeforeMs) с попытками меньше maxAttempts,
 * старые по созданию первыми, не больше limit. Условие status IN (...) в запросе повторяет условие частичного индекса
 * manager_notifications_retry: иначе SQLite не стал бы им пользоваться.
 * listRecent для панели: новые сверху, при равном времени сначала поздняя запись. latestForChat: последнее по созданию.
 */
export function createManagerNotificationsRepo(db: Database.Database): ManagerNotificationsRepo {
  const statements = prepareStatements(db);
  return {
    add(entry: AddParams): number {
      assertTimeMs(entry.nowMs, 'nowMs');
      const { kind, chatId, text, nowMs } = entry;
      return Number(statements.insert.run({ kind, chatId, text, nowMs }).lastInsertRowid);
    },
    setResult(
      id: number,
      result: { readonly status: ResultStatus; readonly waId: WaMessageId | null },
      nowMs: number,
    ): void {
      assertTimeMs(nowMs, 'nowMs');
      assertResultStatus(result.status);
      const { status, waId } = result;
      if (statements.updateResult.run({ id, status, waId, nowMs }).changes === 0) {
        throw new Error(`Уведомление #${id} не найдено: итог отправки не записан`);
      }
    },
    listRetryable(query: RetryParams): readonly ManagerNotification[] {
      assertCount(query.maxAttempts, 'maxAttempts');
      assertCount(query.limit, 'limit');
      assertTimeMs(query.staleBeforeMs, 'staleBeforeMs');
      const { maxAttempts, staleBeforeMs, limit } = query;
      return statements.selectRetryable
        .all({ maxAttempts, staleBeforeMs, limit })
        .map(toNotification);
    },
    listRecent(query: PageParams): readonly ManagerNotification[] {
      assertCount(query.limit, 'limit');
      assertCount(query.offset, 'offset');
      const { limit, offset } = query;
      return statements.selectRecent.all({ limit, offset }).map(toNotification);
    },
    countAll(): number {
      return statements.countAll.get() ?? 0;
    },
    latestForChat(chatId: ChatId): ManagerNotification | null {
      const row = statements.selectLatest.get(chatId);
      return row === undefined ? null : toNotification(row);
    },
  };
}

function prepareStatements(db: Database.Database) {
  return {
    insert: db.prepare<AddParams>(
      `INSERT INTO manager_notifications (kind, chat_id, text, status, attempts, created_at_ms, updated_at_ms)
       VALUES (@kind, @chatId, @text, 'pending', 0, @nowMs, @nowMs)`,
    ),
    updateResult: db.prepare<ResultParams>(
      `UPDATE manager_notifications
       SET status = @status, wa_id = @waId, attempts = attempts + 1, updated_at_ms = @nowMs
       WHERE id = @id`,
    ),
    selectRetryable: db.prepare<RetryParams, NotificationRow>(
      `${SELECT_NOTIFICATION}
       WHERE status IN ('pending', 'failed') AND attempts < @maxAttempts
         AND (status = 'failed' OR updated_at_ms <= @staleBeforeMs)
       ORDER BY created_at_ms, id LIMIT @limit`,
    ),
    selectRecent: db.prepare<PageParams, NotificationRow>(
      `${SELECT_NOTIFICATION} ORDER BY created_at_ms DESC, id DESC LIMIT @limit OFFSET @offset`,
    ),
    selectLatest: db.prepare<[ChatId], NotificationRow>(
      `${SELECT_NOTIFICATION} WHERE chat_id = ? ORDER BY created_at_ms DESC, id DESC LIMIT 1`,
    ),
    countAll: db.prepare<[], number>('SELECT count(*) FROM manager_notifications').pluck(),
  };
}

/** pending итогом попытки не бывает: типы это запрещают, а проверка не даёт обойти их приведением. */
function assertResultStatus(status: ResultStatus): void {
  if (!RESULT_STATUSES.includes(status)) {
    throw new RangeError(
      'status: итогом попытки может быть sent, no_manager, skipped_limit или failed',
    );
  }
}

function toNotification(row: NotificationRow): ManagerNotification {
  return {
    id: row.id,
    kind: oneOf(KINDS, row.kind, 'В manager_notifications неизвестный вид уведомления'),
    chatId: row.chatId as ChatId | null,
    text: row.text,
    status: oneOf(STATUSES, row.status, 'В manager_notifications неизвестный статус уведомления'),
    attempts: row.attempts,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}
