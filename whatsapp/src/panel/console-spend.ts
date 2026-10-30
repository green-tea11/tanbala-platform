import { open as openFile, type FileHandle } from 'node:fs/promises';
import type { Clock } from '../domain/ports.js';
import { almatyDayOf, consoleText } from './console-json.js';
import type { DayRange } from './console-params.js';

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
  /** Строк, которые не разобрались (длиннее предела, обрыв записи, чужой формат): в сумму не вошли. */
  readonly skippedLines: number;
}

/** Расход за период; один расчёт за раз, повтор того же периода по тем же файлам в течение минуты из памяти. */
export interface SpendReader {
  read(range: DayRange): Promise<SpendReport>;
}

/** Открытие файла на чтение; шов для тестов (гонка с ротацией, нет прав). */
export type OpenForRead = (path: string) => Promise<FileHandle>;

export interface SpendReaderOptions {
  /** TOKEN_LOG_PATH: читаются он и прошлый файл после ротации (.1). */
  readonly tokenLogPath: string;
  readonly clock: Pick<Clock, 'now'>;
  /** Шов для тестов: предел размера файла (по умолчанию SPEND_FILE_MAX_BYTES). */
  readonly maxFileBytes?: number;
  /** Шов для тестов: открытие файла (по умолчанию fs/promises.open). */
  readonly open?: OpenForRead;
}

/** Файл лога больше предела: расход не считается (лучше отказ, чем тихие нули). */
export class SpendLogTooLargeError extends Error {
  override readonly name = 'SpendLogTooLargeError';
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

/** Открытый файл лога: дескриптор, размер и время изменения на момент открытия. */
interface LogFile {
  readonly handle: FileHandle;
  readonly size: number;
  readonly mtimeMs: number;
}

interface CachedReport {
  readonly atMs: number;
  readonly report: SpendReport;
}

/** Суффикс прошлого файла: logrotate с delaycompress оставляет его несжатым (deploy/logrotate/tanbala). */
export const ROTATED_SUFFIX = '.1';
/** Файл больше этого не читается (503): при полном лимите лог растёт примерно на 3 МБ в месяц. */
export const SPEND_FILE_MAX_BYTES = 32 * 1024 * 1024;
/** Строка лога длиннее этого (в байтах) не накапливается в памяти, а пропускается и считается в skippedLines. */
export const SPEND_LINE_MAX_BYTES = 4096;
/** Сколько помнить готовый ответ для тех же from, to и тех же файлов (размер и время изменения). */
export const SPEND_CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 32;
const NEWLINE = 0x0a;
const MAX_MODEL_LENGTH = 200;
/** Начало записи llm/token-log.ts: ts идёт первым полем, по нему строка вне периода отбрасывается без JSON.parse. */
const TS_PREFIX = /^\{"ts":"([^"]{1,40})"/;
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
  const model = consoleText(value).trim();
  return model === '' || model.length > MAX_MODEL_LENGTH ? null : model;
}

/** Запись лога: только известные провайдеры и виды вызова, токены целые не меньше нуля; иначе null. */
export function parseUsageLine(line: string): UsageLine | null {
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

/**
 * Дешёвая проверка до JSON.parse: строка начинается с {"ts":"…" и день этой записи по Алматы вне периода. Другое
 * начало или не время => false: строку разберёт parseUsageLine (и посчитает в skippedLines, если она испорчена).
 */
export function outsideRange(line: string, range: DayRange): boolean {
  const stamp = TS_PREFIX.exec(line)?.[1];
  if (stamp === undefined) return false;
  const ms = Date.parse(stamp);
  if (!Number.isFinite(ms)) return false;
  const day = almatyDayOf(ms);
  return day < range.from || day > range.to;
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

/**
 * Строки потока по байту \n. Строка длиннее maxBytes не копится: её байты отбрасываются до конца строки, вместо неё
 * выдаётся null. Последняя строка без \n тоже выдаётся (обрыв записи разберёт parseUsageLine).
 */
export async function* readLines(
  chunks: AsyncIterable<Buffer>,
  maxBytes: number,
): AsyncGenerator<string | null> {
  let parts: Buffer[] = [];
  let length = 0;
  let overflow = false;
  const keep = (piece: Buffer): void => {
    if (overflow || piece.length === 0) return;
    if (length + piece.length > maxBytes) {
      overflow = true;
      parts = [];
      length = 0;
      return;
    }
    parts.push(piece);
    length += piece.length;
  };
  const finish = (): string | null => {
    const line = overflow ? null : Buffer.concat(parts, length).toString('utf8');
    parts = [];
    length = 0;
    overflow = false;
    return line;
  };
  for await (const chunk of chunks) {
    let start = 0;
    for (let end = chunk.indexOf(NEWLINE); end !== -1; end = chunk.indexOf(NEWLINE, start)) {
      keep(chunk.subarray(start, end));
      yield finish();
      start = end + 1;
    }
    keep(chunk.subarray(start));
  }
  if (length > 0 || overflow) yield finish();
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Открывает файл лога: нет файла (в том числе пропал при ротации между запросами) или это не файл => null. Размер и
 * время берутся у открытого дескриптора: ротация после открытия на чтение не влияет.
 */
async function openLog(path: string, open: OpenForRead): Promise<LogFile | null> {
  let handle: FileHandle;
  try {
    handle = await open(path);
  } catch (error: unknown) {
    if (isNotFound(error)) return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (info.isFile()) return { handle, size: info.size, mtimeMs: info.mtimeMs };
  } catch (error: unknown) {
    await handle.close();
    throw error;
  }
  await handle.close();
  return null;
}

/** Добавляет записи периода из файла в rows (только первые size байт); возвращает число пропущенных строк. */
async function collect(
  file: LogFile,
  range: DayRange,
  rows: Map<string, SpendRow>,
): Promise<number> {
  if (file.size === 0) return 0;
  // Поток в конце закрывает дескриптор сам; закрытие в createSpendReader нужно для файлов без чтения и при ошибке,
  // повторное закрытие FileHandle безопасно.
  const stream = file.handle.createReadStream({ start: 0, end: file.size - 1 });
  let skipped = 0;
  for await (const text of readLines(stream, SPEND_LINE_MAX_BYTES)) {
    if (text === null) {
      skipped += 1;
      continue;
    }
    if (text.trim() === '' || outsideRange(text, range)) continue;
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

/** Ключ памяти: период и у каждого файла размер и время изменения (нет файла => «-»). */
function cacheKeyOf(range: DayRange, files: readonly (LogFile | null)[]): string {
  const marks = files.map((file) => (file === null ? '-' : `${file.size}:${file.mtimeMs}`));
  return [range.from, range.to, ...marks].join('|');
}

/** Запоминает ответ: старше SPEND_CACHE_TTL_MS удаляются, больше CACHE_MAX_ENTRIES — самые старые. */
function remember(cache: Map<string, CachedReport>, key: string, entry: CachedReport): void {
  for (const [oldKey, old] of cache) {
    if (entry.atMs - old.atMs >= SPEND_CACHE_TTL_MS) cache.delete(oldKey);
  }
  cache.delete(key);
  cache.set(key, entry);
  for (const oldKey of cache.keys()) {
    if (cache.size <= CACHE_MAX_ENTRIES) break;
    cache.delete(oldKey);
  }
}

function tooLargeMessage(index: number, maxBytes: number): string {
  const which = index === 0 ? `прошлый файл после ротации (${ROTATED_SUFFIX})` : 'текущий файл';
  const megabytes = Math.round(maxBytes / (1024 * 1024));
  return (
    `Лог расхода TOKEN_LOG_PATH, ${which}, больше ${megabytes} МБ: расход не посчитан. ` +
    'Проверьте ротацию лога на сервере (deploy/logrotate).'
  );
}

/**
 * Расход за период: прошлый файл после ротации (TOKEN_LOG_PATH.1) и текущий, сутки по Алматы включительно.
 * Нет файла (и пропал между запросами при ротации) => ничего. Файл больше предела => SpendLogTooLargeError, без
 * частичных сумм. Файлы читаются кусками, строка длиннее SPEND_LINE_MAX_BYTES пропускается и считается в
 * skippedLines, как и неразобранная; строки вне периода по префиксу ts отбрасываются без JSON.parse. Одновременно
 * идёт один расчёт (остальные ждут очереди), готовый ответ для тех же from, to и тех же файлов (размер и время
 * изменения) живёт SPEND_CACHE_TTL_MS.
 */
export function createSpendReader(options: SpendReaderOptions): SpendReader {
  const paths = [`${options.tokenLogPath}${ROTATED_SUFFIX}`, options.tokenLogPath];
  const maxFileBytes = options.maxFileBytes ?? SPEND_FILE_MAX_BYTES;
  const open = options.open ?? ((path: string) => openFile(path, 'r'));
  const cache = new Map<string, CachedReport>();
  let queue: Promise<unknown> = Promise.resolve();

  const compute = async (range: DayRange): Promise<SpendReport> => {
    const files: (LogFile | null)[] = [];
    try {
      for (const path of paths) files.push(await openLog(path, open));
      files.forEach((file, index) => {
        if (file !== null && file.size > maxFileBytes) {
          throw new SpendLogTooLargeError(tooLargeMessage(index, maxFileBytes));
        }
      });
      const key = cacheKeyOf(range, files);
      const nowMs = options.clock.now();
      const cached = cache.get(key);
      if (cached !== undefined && nowMs - cached.atMs < SPEND_CACHE_TTL_MS) return cached.report;
      const rows = new Map<string, SpendRow>();
      let skippedLines = 0;
      for (const file of files) {
        if (file !== null) skippedLines += await collect(file, range, rows);
      }
      const report = { rows: [...rows.values()].sort(compareRows), skippedLines };
      remember(cache, key, { atMs: nowMs, report });
      return report;
    } finally {
      const opened = files.filter((file): file is LogFile => file !== null);
      await Promise.all(opened.map((file) => file.handle.close()));
    }
  };

  return {
    read(range: DayRange): Promise<SpendReport> {
      const run = queue.then(() => compute(range));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
