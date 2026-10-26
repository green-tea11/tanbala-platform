import { Buffer } from 'node:buffer';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type {
  BudgetDecision,
  CallBudget,
  Clock,
  Logger,
  TokenLog,
} from '../../../src/domain/ports.js';
import type { AudioClip, ChatId, LlmResult } from '../../../src/domain/types.js';
import {
  createDisabledTranscriber,
  createOpenRouterTranscriber,
  MAX_AUDIO_BYTES,
  TRANSCRIBE_TIMEOUT_MS,
} from '../../../src/voice/transcriber.js';

const API_KEY = 'sk-or-v1-test-secret-value';
const MODEL = 'elevenlabs/scribe-v2';
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const CHAT_ID = 7 as ChatId;
const OGG_BYTES = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0xff]);
const VOICE: AudioClip = { data: OGG_BYTES, mimeType: 'audio/ogg; codecs=opus' };
const USAGE = {
  seconds: 9.2,
  total_tokens: 113,
  input_tokens: 83,
  output_tokens: 30,
  cost: 0.0006,
};
const UNAVAILABLE = { ok: false, failure: 'unavailable' };
const INVALID_OUTPUT = { ok: false, failure: 'invalid_output' };

/** Запись лога расхода для этого вызова: меняются только токены и успех. */
function usageEntry(input: number, output: number, ok: boolean): Record<string, unknown> {
  const source = { provider: 'openrouter', purpose: 'transcribe', model: MODEL };
  return { ...source, input, output, cacheRead: 0, cacheWrite: 0, chatId: CHAT_ID, ok };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Ответ OpenRouter с текстом и usage. */
function transcription(text: string): () => Promise<Response> {
  return () => Promise.resolve(jsonResponse({ text, usage: USAGE }));
}

/** Пауза, которая заканчивается только снятием через signal, как у системных часов. */
function sleepUntilAborted(_ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('пауза снята')), { once: true });
  });
}

/** Запрос, на который сервер не отвечает: обрывается только через signal. */
function hangingFetch(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

interface LogEntry {
  readonly level: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly message?: string;
}

/** Логгер в память: записи уровня, контекста и сообщения. */
function createMemoryLogger(entries: LogEntry[]): Logger {
  const at =
    (level: string) =>
    (context: Readonly<Record<string, unknown>>, message?: string): void => {
      entries.push({ level, context, message });
    };
  const logger: Logger = {
    level: 'info',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    silent: at('silent'),
    child: () => logger,
  };
  return logger;
}

interface SetupOptions {
  readonly fetchFn?: typeof fetch;
  readonly budget?: BudgetDecision;
  readonly sleep?: Clock['sleep'];
  readonly record?: TokenLog['record'];
  readonly timeoutMs?: number;
}

interface Setup {
  readonly transcribe: (clip?: AudioClip) => Promise<LlmResult<string>>;
  readonly fetchFn: Mock<typeof fetch>;
  readonly tryConsume: Mock<CallBudget['tryConsume']>;
  readonly record: Mock<TokenLog['record']>;
  readonly sleep: Mock<Clock['sleep']>;
  readonly logs: readonly LogEntry[];
}

function setup(options: SetupOptions = {}): Setup {
  const fetchFn = vi.fn<typeof fetch>(options.fetchFn ?? transcription('Здравствуйте'));
  const tryConsume = vi.fn<CallBudget['tryConsume']>(() => options.budget ?? { ok: true });
  const record = vi.fn<TokenLog['record']>(options.record ?? (() => Promise.resolve()));
  const sleep = vi.fn<Clock['sleep']>(options.sleep ?? sleepUntilAborted);
  const logs: LogEntry[] = [];
  const transcriber = createOpenRouterTranscriber({
    apiKey: API_KEY,
    model: MODEL,
    fetchFn,
    budget: { tryConsume },
    clock: { now: () => NOW, sleep },
    tokenLog: { record },
    logger: createMemoryLogger(logs),
    timeoutMs: options.timeoutMs,
  });
  if (!transcriber.enabled) throw new Error('расшифровка OpenRouter должна быть включена');
  return {
    transcribe: (clip = VOICE) => transcriber.transcribe(clip, CHAT_ID),
    fetchFn,
    tryConsume,
    record,
    sleep,
    logs,
  };
}

/** Единственный запрос к fetchFn: адрес, параметры и разобранное тело. */
function sentRequest(fetchFn: Mock<typeof fetch>): {
  url: unknown;
  init: RequestInit;
  body: unknown;
} {
  expect(fetchFn).toHaveBeenCalledOnce();
  const [url, init = {}] = fetchFn.mock.calls[0] ?? [];
  return { url, init, body: JSON.parse(init.body as string) };
}

describe('voice/transcriber: выключенная расшифровка', () => {
  it('createDisabledTranscriber: enabled false, расшифровать нечем', () => {
    expect(createDisabledTranscriber()).toEqual({ enabled: false });
  });
});

describe('voice/transcriber: запрос к OpenRouter', () => {
  it('голосовое WhatsApp уходит POST на адрес OpenRouter с ключом, моделью и base64, format ogg', async () => {
    const { transcribe, fetchFn } = setup();

    await transcribe();

    const { url, init, body } = sentRequest(fetchFn);
    expect(url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(body).toEqual({
      model: MODEL,
      input_audio: { data: Buffer.from(OGG_BYTES).toString('base64'), format: 'ogg' },
    });
  });

  it.each([
    ['audio/mpeg', 'mp3'],
    ['audio/opus', 'ogg'],
    ['Audio/OGG; codecs=opus', 'ogg'],
  ])('тип %s уходит как format %s', async (mimeType, format) => {
    const { transcribe, fetchFn } = setup();

    await transcribe({ data: OGG_BYTES, mimeType });

    expect(sentRequest(fetchFn).body).toMatchObject({ input_audio: { format } });
  });

  it('аудио ровно на лимите размера уходит в API', async () => {
    const { transcribe, fetchFn } = setup();

    await transcribe({ data: new Uint8Array(MAX_AUDIO_BYTES), mimeType: VOICE.mimeType });

    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it.each([
    ['неизвестный тип аудио', { data: OGG_BYTES, mimeType: 'audio/amr' }],
    ['пустое аудио', { data: new Uint8Array(0), mimeType: VOICE.mimeType }],
    [
      'аудио больше лимита',
      { data: new Uint8Array(MAX_AUDIO_BYTES + 1), mimeType: VOICE.mimeType },
    ],
  ])('%s: unavailable без запроса, без списания лимита и без записи в лог', async (_name, clip) => {
    const { transcribe, fetchFn, tryConsume, record } = setup();

    expect(await transcribe(clip)).toEqual(UNAVAILABLE);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(tryConsume).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

describe('voice/transcriber: лимит и лог расхода', () => {
  it('возвращает текст, пишет вызов в лог расхода по usage, а секунды и доллары в лог приложения', async () => {
    const { transcribe, record, logs } = setup();

    expect(await transcribe()).toEqual({ ok: true, value: 'Здравствуйте' });
    expect(record).toHaveBeenCalledExactlyOnceWith(usageEntry(83, 30, true));
    expect(logs).toEqual([
      {
        level: 'info',
        context: { audioSeconds: 9.2, costUsd: 0.0006 },
        message: 'Расход на расшифровку голосового',
      },
    ]);
  });

  it('засчитывает вызов в дневной лимит до запроса, с ID чата и временем часов', async () => {
    const { transcribe, tryConsume, fetchFn } = setup();

    await transcribe();

    expect(tryConsume).toHaveBeenCalledExactlyOnceWith(CHAT_ID, NOW);
    expect(tryConsume.mock.invocationCallOrder[0]).toBeLessThan(
      fetchFn.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('лимит исчерпан: budget_exceeded со scope, без запроса и без записи в лог', async () => {
    const { transcribe, fetchFn, record } = setup({ budget: { ok: false, scope: 'global' } });

    expect(await transcribe()).toEqual({ ok: false, failure: 'budget_exceeded', scope: 'global' });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('ответ без usage: в логе расхода нули, секунд и долларов нет', async () => {
    const { transcribe, record, logs } = setup({
      fetchFn: () => Promise.resolve(jsonResponse({ text: 'Да' })),
    });

    expect(await transcribe()).toEqual({ ok: true, value: 'Да' });
    expect(record).toHaveBeenCalledExactlyOnceWith(usageEntry(0, 0, true));
    expect(logs).toContainEqual(
      expect.objectContaining({ context: { audioSeconds: null, costUsd: null } }),
    );
  });

  it('пустая расшифровка тоже оплачена: секунды и доллары в лог приложения', async () => {
    const { transcribe, logs } = setup({ fetchFn: transcription('   ') });

    expect(await transcribe()).toEqual(INVALID_OUTPUT);
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 'info', context: { audioSeconds: 9.2, costUsd: 0.0006 } }),
    );
  });

  it('сбой записи в лог расхода не теряет расшифровку: в лог имя ошибки без её текста', async () => {
    const { transcribe, logs } = setup({
      record: () => Promise.reject(new Error('диск заполнен')),
    });

    expect(await transcribe()).toEqual({ ok: true, value: 'Здравствуйте' });
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 'error', context: { errorName: 'Error' } }),
    );
    expect(JSON.stringify(logs)).not.toContain('диск заполнен');
  });
});

describe('voice/transcriber: сбои', () => {
  it.each([
    [429, 'rate_limited', 'OpenRouter ограничил частоту запросов (429)'],
    [400, 'unavailable', 'OpenRouter не принял запрос (400): например, формат аудио'],
    [401, 'unavailable', 'OpenRouter не принял ключ (401): проверьте OPENROUTER_API_KEY'],
    [
      402,
      'unavailable',
      'OpenRouter: не хватает кредитов (402): проверьте баланс и лимит ключа на openrouter.ai',
    ],
    [502, 'unavailable', 'OpenRouter отказал в расшифровке голосового'],
  ])(
    'HTTP %i => %s, в логе подсказка, статус и причина, вызов в логе расхода с нулями',
    async (status, failure, message) => {
      const error = { error: { code: status, message: 'ошибка' } };
      const { transcribe, record, logs } = setup({
        fetchFn: () => Promise.resolve(jsonResponse(error, status)),
      });

      expect(await transcribe()).toEqual({ ok: false, failure });
      expect(record).toHaveBeenCalledExactlyOnceWith(usageEntry(0, 0, false));
      expect(logs).toEqual([{ level: 'warn', context: { status, reason: 'ошибка' }, message }]);
    },
  );

  it('причина отказа в логе без ключа, без длинных чисел и не длиннее 200 символов', async () => {
    const message = `Key sk-or-v1-abc_123 of 77011234567: ${'я'.repeat(300)}`;
    const { transcribe, logs } = setup({
      fetchFn: () => Promise.resolve(jsonResponse({ error: { message } }, 402)),
    });

    await transcribe();

    const reason = String(logs[0]?.context.reason);
    expect(reason.startsWith('Key sk-*** of ***: я')).toBe(true);
    expect(Array.from(reason)).toHaveLength(200);
  });

  it('тело отказа не JSON: в логе только статус', async () => {
    const { transcribe, logs } = setup({
      fetchFn: () => Promise.resolve(new Response('<html>Bad Gateway</html>', { status: 502 })),
    });

    expect(await transcribe()).toEqual(UNAVAILABLE);
    expect(logs).toEqual([expect.objectContaining({ level: 'warn', context: { status: 502 } })]);
  });

  // Второй случай: объект с полями ошибки, но не Error; его name в лог не берётся.
  const networkFailures: ReadonlyArray<readonly [Error, string]> = [
    [new TypeError('fetch failed'), 'TypeError'],
    [{ name: 'Подделка', message: 'не Error' }, 'object'],
  ];
  it.each(networkFailures)(
    'сбой сети (%o): unavailable значением, в логе %s, вызов в логе расхода',
    async (thrown, errorName) => {
      const { transcribe, record, logs } = setup({ fetchFn: () => Promise.reject(thrown) });

      expect(await transcribe()).toEqual(UNAVAILABLE);
      expect(record).toHaveBeenCalledExactlyOnceWith(usageEntry(0, 0, false));
      expect(logs).toEqual([expect.objectContaining({ level: 'warn', context: { errorName } })]);
    },
  );

  it('тайм-аут по часам обрывает запрос: unavailable, вызов в логе', async () => {
    const { transcribe, sleep, record } = setup({
      fetchFn: hangingFetch,
      sleep: () => Promise.resolve(),
      timeoutMs: 1234,
    });

    expect(await transcribe()).toEqual(UNAVAILABLE);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1234, expect.any(AbortSignal));
    expect(record).toHaveBeenCalledExactlyOnceWith(usageEntry(0, 0, false));
  });

  it('без timeoutMs тайм-аут TRANSCRIBE_TIMEOUT_MS, после ответа пауза тайм-аута снимается', async () => {
    const { transcribe, sleep } = setup();

    await transcribe();

    expect(sleep).toHaveBeenCalledExactlyOnceWith(TRANSCRIBE_TIMEOUT_MS, expect.any(AbortSignal));
    expect(sleep.mock.calls[0]?.[1]?.aborted).toBe(true);
  });

  it.each([
    ['пустая расшифровка', { text: ' \n\u200B ', usage: USAGE }],
    ['нет текста', { usage: USAGE }],
  ])('%s: invalid_output, usage в логе с ok false', async (_name, body) => {
    const { transcribe, record } = setup({ fetchFn: () => Promise.resolve(jsonResponse(body)) });

    expect(await transcribe()).toEqual(INVALID_OUTPUT);
    expect(record).toHaveBeenCalledExactlyOnceWith(usageEntry(83, 30, false));
  });

  it('ответ не объект: invalid_output, вызов в логе с нулями', async () => {
    const { transcribe, record } = setup({
      fetchFn: () => Promise.resolve(jsonResponse(['Здравствуйте'])),
    });

    expect(await transcribe()).toEqual(INVALID_OUTPUT);
    expect(record).toHaveBeenCalledExactlyOnceWith(usageEntry(0, 0, false));
  });

  it('ключ OpenRouter не попадает ни в логи, ни в результат', async () => {
    const ok = setup();
    const failed = setup({
      fetchFn: () => Promise.reject(new Error(`401 for Bearer ${API_KEY}`)),
    });

    const results = [await ok.transcribe(), await failed.transcribe()];

    const runs = [ok, failed].map(({ record, logs }) => [record.mock.calls, logs]);
    expect(JSON.stringify([results, runs])).not.toContain(API_KEY);
    expect(failed.logs).toHaveLength(1);
  });
});

describe('voice/transcriber: расшифровка как недоверенный текст клиента', () => {
  it('убирает невидимые символы, приводит к NFKC и обрезает пробелы по краям', async () => {
    const { transcribe } = setup({ fetchFn: transcription('\u200B Добрый\u00A0день\u202E \n') });

    expect(await transcribe()).toEqual({ ok: true, value: 'Добрый день' });
  });

  it('длинная расшифровка обрезается до 4096 символов, как текстовое сообщение', async () => {
    const { transcribe } = setup({ fetchFn: transcription('я'.repeat(5000)) });

    expect(await transcribe()).toEqual({ ok: true, value: 'я'.repeat(4096) });
  });
});
