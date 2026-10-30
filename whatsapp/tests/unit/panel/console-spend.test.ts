import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { open as openFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createSpendReader,
  outsideRange,
  readLines,
  SPEND_CACHE_TTL_MS,
  SPEND_LINE_MAX_BYTES,
  SpendLogTooLargeError,
  type OpenForRead,
  type SpendReaderOptions,
} from '../../../src/panel/console-spend.js';

// Чтение расхода для консоли: куски с пределом строки, дешёвый отсев по ts, предел файла, гонка с ротацией,
// один расчёт за раз и память на минуту.

const DAY = { from: '2026-10-30', to: '2026-10-30' };
const T0 = Date.UTC(2026, 9, 30, 10, 0);

function line(ts: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts,
    provider: 'anthropic',
    purpose: 'reply',
    model: 'claude-sonnet-5-5',
    input: 100,
    output: 20,
    cacheRead: 5,
    cacheWrite: 1,
    chatId: 1,
    ok: true,
    ...overrides,
  });
}

const IN_DAY = line('2026-10-30T10:00:00.000Z');

function useDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tanbala-spend-reader-'));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

interface Bench {
  readonly path: string;
  readonly clock: { now: () => number; advance: (ms: number) => void };
  reader(options?: Partial<SpendReaderOptions>): ReturnType<typeof createSpendReader>;
}

function bench(current: readonly string[] | null, rotated: readonly string[] | null = null): Bench {
  const path = join(useDir(), 'token-usage.jsonl');
  if (current !== null) writeFileSync(path, `${current.join('\n')}\n`);
  if (rotated !== null) writeFileSync(`${path}.1`, `${rotated.join('\n')}\n`);
  let now = T0;
  const clock = {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
  return {
    path,
    clock,
    reader: (options = {}) => createSpendReader({ tokenLogPath: path, clock, ...options }),
  };
}

/** Поток из кусков: каждый кусок приходит отдельно, как из файла. */
function chunksOf(...parts: string[]): AsyncIterable<Buffer> {
  return Readable.from(parts.map((part) => Buffer.from(part, 'utf8')));
}

async function linesOf(chunks: AsyncIterable<Buffer>, max: number): Promise<(string | null)[]> {
  const lines: (string | null)[] = [];
  for await (const value of readLines(chunks, max)) lines.push(value);
  return lines;
}

describe('расход: строки потока', () => {
  it('строки на стыке кусков, последняя без перевода строки, пустые строки', async () => {
    expect(await linesOf(chunksOf('ab', 'c\nde', '\n\nfg'), 10)).toEqual(['abc', 'de', '', 'fg']);
    expect(await linesOf(chunksOf('ab\n'), 10)).toEqual(['ab']);
    expect(await linesOf(chunksOf(), 10)).toEqual([]);
  });

  it('строка длиннее предела не копится: вместо неё null, соседние целы', async () => {
    expect(await linesOf(chunksOf('12345\n123', '456', '7\nok\n', '1234567'), 5)).toEqual([
      '12345',
      null,
      'ok',
      null,
    ]);
  });

  it('предел в байтах, а не в символах: кириллица занимает два байта', async () => {
    expect(await linesOf(chunksOf('жжж\nжж\n'), 4)).toEqual([null, 'жж']);
  });
});

describe('расход: отсев по ts до JSON.parse', () => {
  it.each([
    ['день вне периода', '{"ts":"2026-10-29T10:00:00.000Z",испорчено', true],
    ['19:00 UTC — уже следующий день Алматы', '{"ts":"2026-10-29T19:00:00.000Z"', false],
    ['день периода', `${IN_DAY}`, false],
    ['другое начало', '{"model":"x","ts":"2026-01-01T00:00:00Z"}', false],
    ['не время', '{"ts":"вчера"}', false],
  ])('%s', (_label, text, outside) => {
    expect(outsideRange(text, DAY)).toBe(outside);
  });
});

describe('расход: чтение файлов', () => {
  it('длинная строка пропускается и считается, строки вне периода не разбираются и не считаются', async () => {
    const json = line('2026-10-30T11:00:00.000Z');
    const exact = `${json}${' '.repeat(SPEND_LINE_MAX_BYTES - Buffer.byteLength(json))}`;
    const b = bench([
      IN_DAY,
      'x'.repeat(200_000),
      exact,
      `${exact} `,
      '{"ts":"2026-09-01T10:00:00.000Z",испорчено',
      '{"ts":"2026-10-30T10:00:00.000Z",испорчено',
      ...Array.from({ length: 3000 }, () => IN_DAY),
    ]);

    const report = await b.reader().read(DAY);

    expect(report.skippedLines).toBe(3);
    expect(report.rows).toEqual([expect.objectContaining({ calls: 3002, input: 300_200 })]);
  });

  it('файл больше предела: SpendLogTooLargeError, без частичных сумм; у прошлого файла свой текст', async () => {
    const current = bench(['x'.repeat(100)]);
    const rotated = bench([IN_DAY], ['x'.repeat(100)]);

    await expect(current.reader({ maxFileBytes: 50 }).read(DAY)).rejects.toThrow(
      /текущий файл, больше 0 МБ/,
    );
    const error: unknown = await rotated
      .reader({ maxFileBytes: 50 })
      .read(DAY)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpendLogTooLargeError);
    expect((error as Error).message).toContain('прошлый файл после ротации (.1)');
  });

  it('файл пропал при ротации между запросами (ENOENT при открытии): считается, что его нет', async () => {
    const b = bench([IN_DAY], [IN_DAY]);
    const open: OpenForRead = (path) =>
      path.endsWith('.1')
        ? Promise.reject(Object.assign(new Error('нет файла'), { code: 'ENOENT' }))
        : openFile(path, 'r');

    const report = await b.reader({ open }).read(DAY);

    expect(report.rows).toEqual([expect.objectContaining({ calls: 1 })]);
  });

  it('прочая ошибка открытия всплывает; следующий запрос работает', async () => {
    const b = bench([IN_DAY]);
    let fail = true;
    const open: OpenForRead = (path) => {
      if (fail) {
        fail = false;
        return Promise.reject(Object.assign(new Error('нет прав'), { code: 'EACCES' }));
      }
      return openFile(path, 'r');
    };
    const reader = b.reader({ open });

    await expect(reader.read(DAY)).rejects.toThrow('нет прав');
    await expect(reader.read(DAY)).resolves.toMatchObject({ skippedLines: 0 });
  });

  it('сбой stat у открытого файла: дескриптор закрыт, ошибка всплывает', async () => {
    const b = bench([IN_DAY]);
    const close = vi.fn(() => Promise.resolve());
    const open: OpenForRead = () =>
      Promise.resolve({
        stat: () => Promise.reject(new Error('stat не прошёл')),
        close,
      } as unknown as FileHandle);

    await expect(b.reader({ open }).read(DAY)).rejects.toThrow('stat не прошёл');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('папка вместо файла и пустой файл: ничего', async () => {
    const b = bench(['']);
    mkdirSync(`${b.path}.1`);

    expect(await b.reader().read(DAY)).toEqual({ rows: [], skippedLines: 0 });
  });
});

describe('расход: один расчёт за раз и память на минуту', () => {
  it('одновременные запросы идут по очереди: файлы второго открываются после закрытия первого', async () => {
    const b = bench([IN_DAY], [IN_DAY]);
    const events: string[] = [];
    const open: OpenForRead = async (path) => {
      const handle = await openFile(path, 'r');
      const name = path.endsWith('.1') ? 'прошлый' : 'текущий';
      events.push(`открыт ${name}`);
      const close = handle.close.bind(handle);
      handle.close = () => {
        events.push(`закрыт ${name}`);
        return close();
      };
      return handle;
    };
    const reader = b.reader({ open });

    const [first, second] = await Promise.all([
      reader.read(DAY),
      reader.read({ from: '2026-10-29', to: '2026-10-30' }),
    ]);

    // Второй расчёт начинается (третье открытие) только после того, как первый закрыл оба файла.
    const secondStart = events.findIndex((event, index) => index > 1 && event.startsWith('открыт'));
    const between = events.slice(2, secondStart);
    expect(first).toEqual(second);
    expect(events.slice(0, 2)).toEqual(['открыт прошлый', 'открыт текущий']);
    expect(between).toEqual(expect.arrayContaining(['закрыт прошлый', 'закрыт текущий']));
    expect(between.every((event) => event.startsWith('закрыт'))).toBe(true);
    expect(events.filter((event) => event.startsWith('открыт'))).toHaveLength(4);
  });

  it('тот же период и те же файлы: из памяти минуту, потом заново; изменился файл — заново сразу', async () => {
    const b = bench([IN_DAY]);
    // Время изменения в целых секундах: его можно вернуть точно.
    const mtime = Math.floor(statSync(b.path).mtimeMs / 1000);
    utimesSync(b.path, mtime, mtime);
    const reader = b.reader();
    const first = await reader.read(DAY);
    // Тот же размер и то же время изменения: ответ из памяти.
    writeFileSync(b.path, `${line('2026-10-30T10:00:00.000Z', { input: 900 })}\n`);
    utimesSync(b.path, mtime, mtime);

    const cached = await reader.read(DAY);
    b.clock.advance(SPEND_CACHE_TTL_MS);
    const expired = await reader.read(DAY);
    writeFileSync(b.path, `${IN_DAY}\n${IN_DAY}\n`);
    const changed = await reader.read(DAY);

    expect(cached).toBe(first);
    expect(expired.rows[0]).toMatchObject({ input: 900 });
    expect(changed.rows[0]).toMatchObject({ calls: 2 });
  });

  it('другой период считается отдельно; память не растёт без предела', async () => {
    const b = bench([IN_DAY]);
    const reader = b.reader();

    const results = [];
    // 40 разных периодов: больше, чем помнит память (32), старые вытесняются.
    for (let day = 0; day < 40; day += 1) {
      const from = new Date(Date.UTC(2026, 7, 1 + day)).toISOString().slice(0, 10);
      results.push(await reader.read({ from, to: '2026-10-30' }));
    }
    const again = await reader.read({ from: '2026-08-01', to: '2026-10-30' });

    expect(results.every((report) => report.rows.length === 1)).toBe(true);
    expect(again).not.toBe(results[0]);
    expect(again).toEqual(results[0]);
  });
});
