/** Цена модели: USD за миллион токенов (таблица из leads/tanbala_leads/llm.py, отдаёт почта). */
export interface ModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

/** Строка расхода: токены одной модели за день (у бота ещё провайдер). */
export interface TokenRow {
  readonly day: string;
  readonly model: string;
  readonly provider?: string;
  readonly calls: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/**
 * Итог расхода. usd — сумма по известным ценам (null: цен нет вовсе, почта недоступна); unpricedTokens — токены
 * моделей без цены (не угадываются); notCountedCalls — вызовы расшифровки OpenRouter: их цена есть только
 * в журнале бота, показываются как «не учтено».
 */
export interface SpendTotal {
  readonly usd: number | null;
  readonly tokens: number;
  readonly unpricedTokens: number;
  readonly calls: number;
  readonly notCountedCalls: number;
}

export interface DaySpend extends SpendTotal {
  readonly day: string;
}

const MILLION = 1_000_000;
/** Доллары до шести знаков: дальше шум сложения дробей. */
const USD_DECIMALS = 1_000_000;
/** Провайдер, чьи вызовы консоль не оценивает (расшифровка голосовых). */
const NOT_COUNTED_PROVIDER = 'openrouter';

function tokensOf(row: TokenRow): number {
  return row.input + row.output + row.cacheRead + row.cacheWrite;
}

/** Стоимость строки по формуле llm.py: (вход·in + выход·out + чтение кэша·cr + запись кэша·cw) / 1e6. */
export function rowCostUsd(row: TokenRow, price: ModelPrice): number {
  return (
    (row.input * price.input +
      row.output * price.output +
      row.cacheRead * price.cacheRead +
      row.cacheWrite * price.cacheWrite) /
    MILLION
  );
}

function roundUsd(value: number): number {
  return Math.round(value * USD_DECIMALS) / USD_DECIMALS;
}

/**
 * Сумма расхода по строкам. Модель без цены не оценивается по самой дорогой (как spent_today_usd почты), а
 * откладывается в unpricedTokens (как cost_from_rows почты): консоль не выдумывает деньги. prices null —
 * цен нет совсем: usd null, все токены без цены.
 */
export function sumSpend(rows: readonly TokenRow[], prices: PriceTable | null): SpendTotal {
  let usd = 0;
  let tokens = 0;
  let unpricedTokens = 0;
  let calls = 0;
  let notCountedCalls = 0;
  for (const row of rows) {
    if (row.provider === NOT_COUNTED_PROVIDER) {
      notCountedCalls += row.calls;
      continue;
    }
    // Object.hasOwn: модель с именем «constructor» не должна найти чужую «цену».
    const price =
      prices !== null && Object.hasOwn(prices, row.model) ? prices[row.model] : undefined;
    tokens += tokensOf(row);
    calls += row.calls;
    if (price === undefined) unpricedTokens += tokensOf(row);
    else usd += rowCostUsd(row, price);
  }
  return {
    usd: prices === null ? null : roundUsd(usd),
    tokens,
    unpricedTokens,
    calls,
    notCountedCalls,
  };
}

/** Расход по дням (только дни, где есть строки), по возрастанию дня. */
export function spendByDay(rows: readonly TokenRow[], prices: PriceTable | null): DaySpend[] {
  const days = [...new Set(rows.map((row) => row.day))].sort();
  return days.map((day) => ({
    day,
    ...sumSpend(
      rows.filter((row) => row.day === day),
      prices,
    ),
  }));
}

/** Строки за дни from..to включительно (дни ГГГГ-ММ-ДД сравниваются как строки). */
export function rowsBetween<T extends TokenRow>(
  rows: readonly T[],
  from: string,
  to: string,
): readonly T[] {
  return rows.filter((row) => row.day >= from && row.day <= to);
}
