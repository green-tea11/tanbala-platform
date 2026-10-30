import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { almatyDayOf } from './console-json.js';
import type { DayRange } from './console-params.js';
import { cleanText } from './html.js';

// Расход API бота за период из лога TOKEN_LOG_PATH (llm/token-log.ts) и прошлого файла после ротации (.1): токены
// по дням Алматы, провайдеру, модели и виду вызова. Деньги считает консоль по одной таблице цен.

/** Строка ответа: вызовы, из них неудачные, и токены. */
export interface SpendRow {
  readonly day: string;
  readonly provider: string;
  readonly model: string;
  readonly purpose: string;
  readonly calls: number;
  readonly failed: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface SpendReport {
  readonly rows: readonly SpendRow[];
  /** Строк, которые не разобрались (обрыв записи, чужой формат): в сумму не вошли. */
  readonly skippedLines: number;
}

/** Одна запись лога после проверки. */
interface UsageLine {
  readonly day: string;
  readonly provider: string;
  readonly model: string;
  readonly purpose: string;
  readonly ok: boolean;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Суффикс прошлого файла: logrotate с delaycompress оставляет его несжатым (deploy/logrotate/tanbala). */
export const ROTATED_SUFFIX = '.1';
/** Файл больше этого не читается: при полном лимите лог растёт примерно на 3 МБ в месяц. */
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_LINE_LENGTH = 4096;
const MAX_MODEL_LENGTH = 200;
const PROVIDERS: ReadonlySet<string> = new Set(['anthropic', 'openrouter']);
const PURPOSES: ReadonlySet<string> = new Set([
  'reply',
  'review',
  'interest',
  'logo',
  'transcribe',
]);
const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Время записи в мс UTC; не время => null. */
function timeOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Модель: строка без скрытых символов, не пустая и не длиннее MAX_MODEL_LENGTH. */
function modelOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const model = cleanText(value).trim();
  return model === '' || model.length > MAX_MODEL_LENGTH ? null : model;
}

/** Запись лога: только известные провайдеры и виды вызова, токены целые не меньше нуля; иначе null. */
export function parseUsageLine(line: string): UsageLine | null {
  if (line.length > MAX_LINE_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const ms = timeOf(value['ts']);
  const model = modelOf(value['model']);
  const { provider, purpose, ok } = value;
  if (ms === null || model === null || typeof ok !== 'boolean') return null;
  if (typeof provider !== 'string' || !PROVIDERS.has(provider)) return null;
  if (typeof purpose !== 'string' || !PURPOSES.has(purpose)) return null;
  const [input, output, cacheRead, cacheWrite] = TOKEN_FIELDS.map((name) => value[name]);
  if (!isCount(input) || !isCount(output) || !isCount(cacheRead) || !isCount(cacheWrite))
    return null;
  return {
    day: almatyDayOf(ms),
    provider,
    model,
    purpose,
    ok,
    input,
    output,
    cacheRead,
    cacheWrite,
  };
}

/** Сумма записей: ключ день, провайдер, модель, вид вызова. */
function addTo(rows: Map<string, SpendRow>, line: UsageLine): Map<string, SpendRow> {
  const key = [line.day, line.provider, line.model, line.purpose].join('\u0000');
  const previous = rows.get(key);
  const base: SpendRow = previous ?? {
    day: line.day,
    provider: line.provider,
    model: line.model,
    purpose: line.purpose,
    calls: 0,
    failed: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  return rows.set(key, {
    ...base,
    calls: base.calls + 1,
    failed: base.failed + (line.ok ? 0 : 1),
    input: base.input + line.input,
    output: base.output + line.output,
    cacheRead: base.cacheRead + line.cacheRead,
    cacheWrite: base.cacheWrite + line.cacheWrite,
  });
}

/** Можно ли читать файл: есть, обычный файл, не больше MAX_FILE_BYTES. Нет файла => false. */
async function readable(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size <= MAX_FILE_BYTES;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Читает файл построчно (без загрузки целиком) и добавляет записи периода в rows; возвращает число пропущенных. */
async function collect(
  path: string,
  range: DayRange,
  rows: Map<string, SpendRow>,
): Promise<number> {
  if (!(await readable(path))) return 0;
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let skipped = 0;
  for await (const text of lines) {
    if (text.trim() === '') continue;
    const line = parseUsageLine(text);
    if (line === null) skipped += 1;
    else if (line.day >= range.from && line.day <= range.to) addTo(rows, line);
  }
  return skipped;
}

function compareRows(a: SpendRow, b: SpendRow): number {
  const keyOf = (row: SpendRow): string =>
    [row.day, row.provider, row.model, row.purpose].join('\u0000');
  return keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0;
}

/**
 * Расход за период: прошлый файл после ротации (TOKEN_LOG_PATH.1) и текущий, сутки по Алматы включительно.
 * Нет файла => ничего; неразобранные строки считаются в skippedLines. Строки по дню, провайдеру, модели и виду.
 */
export async function readSpend(tokenLogPath: string, range: DayRange): Promise<SpendReport> {
  const rows = new Map<string, SpendRow>();
  let skippedLines = 0;
  for (const path of [`${tokenLogPath}${ROTATED_SUFFIX}`, tokenLogPath]) {
    skippedLines += await collect(path, range, rows);
  }
  return { rows: [...rows.values()].sort(compareRows), skippedLines };
}
