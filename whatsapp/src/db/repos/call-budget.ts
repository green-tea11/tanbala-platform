import type Database from 'better-sqlite3';
import type { BudgetDecision, CallBudget } from '../../domain/ports.js';
import type { ApiLimits, ChatId } from '../../domain/types.js';
import { assertTimeMs } from '../time.js';

/** chat_id общего счётчика бота в api_usage: ID чатов из базы начинаются с 1. */
const GLOBAL_COUNTER = 0;

/** Весь Казахстан с 01.03.2024 живёт по UTC+5 без летнего времени: сутки Алматы начинаются в 19:00 UTC. */
const ALMATY_OFFSET_MS = 5 * 60 * 60 * 1000;

/** Длина даты ГГГГ-ММ-ДД в начале toISOString. */
const DATE_LENGTH = 10;

/** Параметры одного счётчика: сутки, чат (0 общий) и лимит. */
interface CounterParams {
  readonly day: string;
  readonly chatId: number;
  readonly limit: number;
}

/**
 * Дневной предохранитель расходов API в SQLite (решение владельца, числа API_DAILY_LIMIT и API_DAILY_LIMIT_PER_CHAT в .env).
 * Счётчики в таблице api_usage переживают перезапуск; сутки по времени Алматы (UTC+5). Засчитывается каждая попытка
 * вызова Anthropic и OpenRouter до её отправки, в том числе повторная, поэтому неудачный вызов тоже идёт в счёт.
 * Сначала общий лимит (отказ scope 'global'), затем лимит чата (отказ scope 'chat'); при отказе счётчики не растут.
 * Проверка и увеличение атомарны: один INSERT ... ON CONFLICT DO UPDATE ... WHERE count < limit на счётчик внутри
 * db.transaction(...).immediate(), поэтому параллельные пачки и второй экземпляр не проскочат лимит. Отказ лимита чата
 * в той же транзакции возвращает назад уже засчитанный общий вызов. Только подготовленные запросы.
 * Лимиты не меньше 1 (иначе первая строка счётчика обошла бы лимит): неверные => RangeError при создании.
 */
export function createCallBudget(db: Database.Database, limits: ApiLimits): CallBudget {
  assertLimit(limits.apiCallsPerDay, 'apiCallsPerDay');
  assertLimit(limits.apiCallsPerChatPerDay, 'apiCallsPerChatPerDay');
  const consumeOne = db.prepare<CounterParams>(
    `INSERT INTO api_usage (day, chat_id, count) VALUES (@day, @chatId, 1)
     ON CONFLICT (day, chat_id) DO UPDATE SET count = api_usage.count + 1
     WHERE api_usage.count < @limit`,
  );
  const returnOne = db.prepare<Omit<CounterParams, 'limit'>>(
    'UPDATE api_usage SET count = count - 1 WHERE day = @day AND chat_id = @chatId AND count > 0',
  );
  const consume = db.transaction((chatId: ChatId, day: string): BudgetDecision => {
    const global = { day, chatId: GLOBAL_COUNTER, limit: limits.apiCallsPerDay };
    if (consumeOne.run(global).changes === 0) return { ok: false, scope: 'global' };
    if (consumeOne.run({ day, chatId, limit: limits.apiCallsPerChatPerDay }).changes === 0) {
      returnOne.run({ day, chatId: GLOBAL_COUNTER });
      return { ok: false, scope: 'chat' };
    }
    return { ok: true };
  });
  return {
    tryConsume(chatId: ChatId, nowMs: number): BudgetDecision {
      if (!Number.isSafeInteger(chatId) || chatId <= GLOBAL_COUNTER) {
        throw new RangeError('chatId: ожидается ID чата из базы, целое число больше нуля');
      }
      assertTimeMs(nowMs, 'nowMs');
      return consume.immediate(chatId, almatyDay(nowMs));
    },
  };
}

function assertLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name}: ожидается целое число вызовов не меньше 1`);
  }
}

/** Дата ГГГГ-ММ-ДД по Алматы. */
function almatyDay(nowMs: number): string {
  return new Date(nowMs + ALMATY_OFFSET_MS).toISOString().slice(0, DATE_LENGTH);
}
