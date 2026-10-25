import type Database from 'better-sqlite3';
import type { CallBudget } from '../../domain/ports.js';
import type { ApiLimits } from '../../domain/types.js';
import { notImplemented } from '../../shared/todo.js';

/**
 * Дневной предохранитель расходов API в SQLite (решение владельца, числа API_DAILY_LIMIT и API_DAILY_LIMIT_PER_CHAT в .env).
 * TODO(этап 3): счётчики хранить в базе, чтобы лимит переживал перезапуск; сутки считать по времени Алматы (UTC+5).
 * TODO(этап 3): засчитывается каждая попытка вызова Anthropic и OpenRouter до её отправки, в том числе повторная, поэтому неудачный вызов тоже идёт в счёт.
 * TODO(этап 3): сначала общий лимит (отказ scope 'global'), затем лимит чата (отказ scope 'chat'); при отказе счётчики не увеличивать.
 * TODO(этап 3): проверка и увеличение атомарно: один UPDATE ... WHERE count < limit для каждого счётчика внутри db.transaction(...).immediate(), иначе две параллельные пачки проскочат лимит; только подготовленные запросы.
 */
export function createCallBudget(db: Database.Database, limits: ApiLimits): CallBudget {
  return notImplemented('этап 3', 'db/repos/call-budget.createCallBudget');
}
