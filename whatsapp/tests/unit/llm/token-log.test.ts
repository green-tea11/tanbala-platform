import { describe, expect, it } from 'vitest';
import type { Clock } from '../../../src/domain/ports.js';
import type { ChatId, TokenUsageEntry } from '../../../src/domain/types.js';
import { createJsonlTokenLog } from '../../../src/llm/token-log.js';
import { NOW } from './fakes.js';

const LOG_PATH = 'C:/tanbala/data/token-usage.jsonl';

const ENTRY: TokenUsageEntry = {
  provider: 'anthropic',
  purpose: 'reply',
  model: 'claude-haiku-5-5',
  input: 120,
  output: 45,
  cacheRead: 9000,
  cacheWrite: 0,
  chatId: 7 as ChatId,
  ok: true,
};

interface Written {
  readonly path: string;
  readonly line: string;
}

function setup(times: readonly number[] = [NOW]) {
  const written: Written[] = [];
  let call = 0;
  const clock: Clock = {
    now: () => times[Math.min(call++, times.length - 1)] ?? NOW,
    sleep: () => Promise.resolve(),
  };
  const appendLine = (path: string, line: string): Promise<void> => {
    written.push({ path, line });
    return Promise.resolve();
  };
  return { written, log: createJsonlTokenLog(LOG_PATH, appendLine, clock) };
}

describe('createJsonlTokenLog', () => {
  it('пишет одну строку JSON на вызов: время из часов, затем провайдер, вызов, модель, токены, чат и успех', async () => {
    const { written, log } = setup();

    await log.record(ENTRY);

    expect(written).toHaveLength(1);
    expect(written[0]?.path).toBe(LOG_PATH);
    expect(written[0]?.line).toBe(
      '{"ts":"2026-10-26T07:30:00.000Z","provider":"anthropic","purpose":"reply","model":"claude-haiku-5-5",' +
        '"input":120,"output":45,"cacheRead":9000,"cacheWrite":0,"chatId":7,"ok":true}\n',
    );
  });

  it('пишет только числа, модель и ID чата: лишние поля записи (например, текст) в лог не попадают', async () => {
    const { written, log } = setup();
    const withText = { ...ENTRY, text: 'Здравствуйте, сколько стоит?', phone: '77000000002' };

    await log.record(withText);

    const line = written[0]?.line ?? '';
    expect(Object.keys(JSON.parse(line) as object)).toEqual([
      'ts',
      'provider',
      'purpose',
      'model',
      'input',
      'output',
      'cacheRead',
      'cacheWrite',
      'chatId',
      'ok',
    ]);
    expect(line).not.toContain('Здравствуйте');
    expect(line).not.toContain('77000000002');
  });

  it('ставит время каждой записи в момент записи и пишет неудачные вызовы и расшифровку', async () => {
    const later = NOW + 1500;
    const { written, log } = setup([NOW, later]);

    await log.record({ ...ENTRY, ok: false, input: 0, output: 0, cacheRead: 0 });
    await log.record({ ...ENTRY, provider: 'openrouter', purpose: 'transcribe', model: 'scribe' });

    const lines = written.map(({ line }) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map(({ ts }) => ts)).toEqual([
      new Date(NOW).toISOString(),
      new Date(later).toISOString(),
    ]);
    expect(lines[0]).toMatchObject({ ok: false, input: 0, output: 0 });
    expect(lines[1]).toMatchObject({ provider: 'openrouter', purpose: 'transcribe' });
  });

  it('ошибку записи на диск не глотает: её видит вызывающий', async () => {
    const failing = createJsonlTokenLog(LOG_PATH, () => Promise.reject(new Error('EACCES')), {
      now: () => NOW,
      sleep: () => Promise.resolve(),
    });

    await expect(failing.record(ENTRY)).rejects.toThrow('EACCES');
  });
});
