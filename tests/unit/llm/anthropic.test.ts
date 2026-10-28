import {
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  RateLimitError,
  type Anthropic,
  type ClientOptions,
} from '@anthropic-ai/sdk';
import type {
  Message,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/messages';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CallBudget, StructuredRequest } from '../../../src/domain/ports.js';
import type { ChatId, TokenUsageEntry } from '../../../src/domain/types.js';
import { createAnthropicLlm, type AnthropicLlmDeps } from '../../../src/llm/anthropic.js';
import { SafeError } from '../../../src/shared/safe-error.js';
import {
  createFakeLogger,
  createMemoryTokenLog,
  fixedClock,
  NOW,
  openBudget,
  type LogEntry,
} from './fakes.js';

// SDK подменён фабрикой createSdk: ни одного запроса в сеть, проверяются аргументы и разбор ответа.

const API_KEY = 'test-key-not-real';
const MODEL = 'claude-haiku-5-5';
const CHAT_ID = 7 as ChatId;
const CLIENT_TEXT = 'Здравствуйте, у меня магазин одежды на 300 метров';
const answerSchema = z.object({ answer: z.string() });
type Answer = z.infer<typeof answerSchema>;

const REQUEST: StructuredRequest<Answer> = {
  purpose: 'reply',
  model: MODEL,
  system: [
    { text: 'ЗНАНИЯ', cache: true },
    { text: 'ИНСТРУКЦИЯ', cache: false },
  ],
  turns: [
    { role: 'user', text: CLIENT_TEXT },
    { role: 'assistant', text: 'Что вы хотите учитывать?' },
    { role: 'user', text: 'Где лежит каждая вещь' },
  ],
  schema: answerSchema,
  maxTokens: 2048,
  chatId: CHAT_ID,
};

type CreateFn = (params: MessageCreateParamsNonStreaming) => Promise<Message>;

interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens: number | null;
  readonly cache_read_input_tokens: number | null;
}

const USAGE: Usage = {
  input_tokens: 120,
  output_tokens: 45,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: 9000,
};

/** Ответ API: по умолчанию размышление и текст с JSON по схеме. */
function message(overrides: Record<string, unknown> = {}): Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [
      { type: 'thinking', thinking: 'клиент рассказал о бизнесе', signature: 'sig' },
      { type: 'text', text: '{"answer":"Понял вас"}', citations: null },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: USAGE,
    ...overrides,
  } as unknown as Message;
}

interface Setup {
  readonly create: ReturnType<typeof vi.fn<CreateFn>>;
  readonly createSdk: ReturnType<typeof vi.fn<(options: ClientOptions) => Anthropic>>;
  readonly records: TokenUsageEntry[];
  readonly entries: LogEntry[];
  readonly calls: string[];
  readonly deps: AnthropicLlmDeps;
}

function setup(overrides: Partial<AnthropicLlmDeps> = {}): Setup {
  const calls: string[] = [];
  const records: TokenUsageEntry[] = [];
  const entries: LogEntry[] = [];
  const create = vi.fn<CreateFn>(() => {
    calls.push('create');
    return Promise.resolve(message());
  });
  const createSdk = vi.fn(
    (options: ClientOptions) => ({ messages: { create } }) as unknown as Anthropic,
  );
  const budget: CallBudget = {
    tryConsume: (chatId, nowMs) => {
      calls.push(`budget:${chatId}:${nowMs}`);
      return openBudget.tryConsume(chatId, nowMs);
    },
  };
  const deps: AnthropicLlmDeps = {
    apiKey: API_KEY,
    createSdk,
    budget,
    clock: fixedClock,
    tokenLog: createMemoryTokenLog(records, () => calls.push('record')),
    logger: createFakeLogger(entries),
    ...overrides,
  };
  return { create, createSdk, records, entries, calls, deps };
}

function sentParams(create: Setup['create']): MessageCreateParamsNonStreaming {
  const params = create.mock.calls[0]?.[0];
  if (params === undefined) {
    throw new Error('messages.create не вызван');
  }
  return params;
}

function sdkOptions(createSdk: Setup['createSdk']): ClientOptions {
  const options = createSdk.mock.calls[0]?.[0];
  if (options === undefined) {
    throw new Error('SDK не создан');
  }
  return options;
}

describe('createAnthropicLlm: создание SDK', () => {
  it('передаёт ключ и адрес явно, без чтения окружения, без повторов SDK и без телеметрии', () => {
    const { createSdk, deps } = setup();

    createAnthropicLlm(deps);

    expect(createSdk).toHaveBeenCalledTimes(1);
    const options = sdkOptions(createSdk);
    expect(options).toEqual({
      apiKey: API_KEY,
      authToken: null,
      baseURL: 'https://api.anthropic.com',
      logLevel: 'warn',
      logger: expect.any(Object) as unknown,
      openTelemetry: false,
      maxRetries: 0,
      timeout: expect.any(Number) as unknown,
    });
    expect(options.timeout).toBeGreaterThanOrEqual(30_000);
  });

  it.each(['', '   '])('пустой ключ %j: клиент не создаётся вовсе', (apiKey) => {
    const { createSdk, deps } = setup({ apiKey });

    expect(() => createAnthropicLlm({ ...deps, apiKey })).toThrow(SafeError);
    expect(createSdk).not.toHaveBeenCalled();
  });

  it('логгер SDK пишет в наш логгер только строку сообщения, без тел запросов и ответов', () => {
    const { createSdk, entries, deps } = setup();
    createAnthropicLlm(deps);
    const sdkLogger = sdkOptions(createSdk).logger;

    sdkLogger?.warn('Retrying request', { body: CLIENT_TEXT });
    sdkLogger?.error('Could not parse message into JSON:', CLIENT_TEXT);

    expect(entries).toEqual([
      { level: 'warn', context: { module: 'anthropic-sdk' }, message: 'Retrying request' },
      {
        level: 'error',
        context: { module: 'anthropic-sdk' },
        message: 'Could not parse message into JSON:',
      },
    ]);
  });
});

describe('createAnthropicLlm: запрос', () => {
  it('отправляет знания с точкой кэша, инструкцию без кэша, реплики и формат ответа по схеме; без temperature, top_p, top_k', async () => {
    const { create, deps } = setup();

    await createAnthropicLlm(deps).structured(REQUEST);

    const params = sentParams(create);
    expect(Object.keys(params).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'output_config',
      'system',
    ]);
    expect(params).toMatchObject({
      model: MODEL,
      max_tokens: 2048,
      system: [
        { type: 'text', text: 'ЗНАНИЯ', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'ИНСТРУКЦИЯ' },
      ],
      messages: [
        { role: 'user', content: CLIENT_TEXT },
        { role: 'assistant', content: 'Что вы хотите учитывать?' },
        { role: 'user', content: 'Где лежит каждая вещь' },
      ],
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    });
    expect(params.system).toHaveLength(2);
    expect(Array.isArray(params.system) && 'cache_control' in (params.system[1] ?? {})).toBe(false);
    expect(params.output_config?.format?.schema).toMatchObject({
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    });
  });

  it.each(['reply', 'review', 'interest'] as const)(
    'вызов %s: effort low в запросе и тот же вид вызова в логе расхода',
    async (purpose) => {
      const { create, records, deps } = setup();

      await createAnthropicLlm(deps).structured({ ...REQUEST, purpose });

      expect(sentParams(create).output_config?.effort).toBe('low');
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ provider: 'anthropic', purpose, model: MODEL });
    },
  );

  it.each(['claude-haiku-5-5', 'claude-sonnet-5-5'])(
    'модель %s: уходит в API и в лог расхода как в запросе, адаптер не привязан к одной модели',
    async (model) => {
      const { create, records, deps } = setup();

      await createAnthropicLlm(deps).structured({ ...REQUEST, model });

      expect(sentParams(create).model).toBe(model);
      expect(records[0]).toMatchObject({ model });
      expect(Object.keys(sentParams(create))).not.toContain('thinking');
    },
  );

  it('сначала засчитывает вызов в дневной лимит, затем вызывает API, пишет расход и только потом проверяет схему', async () => {
    const { calls, deps } = setup();
    const schema = z.object({ answer: z.string() });
    const safeParse = schema.safeParse.bind(schema);
    vi.spyOn(schema, 'safeParse').mockImplementation((data) => {
      calls.push('safeParse');
      return safeParse(data);
    });

    await createAnthropicLlm(deps).structured({ ...REQUEST, schema });

    expect(calls).toEqual([`budget:${CHAT_ID}:${NOW}`, 'create', 'record', 'safeParse']);
  });
});

describe('createAnthropicLlm: картинка в запросе (вызов logo)', () => {
  const PHOTO_BYTES = new Uint8Array([1, 2, 3, 250, 251, 252]);
  const PHOTO_BASE64 = Buffer.from(PHOTO_BYTES).toString('base64');
  const LOGO_REQUEST: StructuredRequest<Answer> = {
    ...REQUEST,
    purpose: 'logo',
    turns: [{ role: 'user', text: 'Какое название компании на логотипе?' }],
    image: { data: PHOTO_BYTES, mimeType: 'image/png' },
  };

  it('последняя реплика user уходит блоками: сначала картинка base64 с media_type, затем текст', async () => {
    const { create, deps } = setup();

    await createAnthropicLlm(deps).structured(LOGO_REQUEST);

    expect(sentParams(create).messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: PHOTO_BASE64 },
          },
          { type: 'text', text: 'Какое название компании на логотипе?' },
        ],
      },
    ]);
  });

  it('картинка только у последней реплики: прежние реплики остаются строками', async () => {
    const { create, deps } = setup();

    await createAnthropicLlm(deps).structured({
      ...LOGO_REQUEST,
      turns: [
        { role: 'user', text: 'Первая реплика' },
        { role: 'assistant', text: 'Ответ' },
        { role: 'user', text: 'Последняя реплика' },
      ],
    });

    const { messages } = sentParams(create);
    expect(messages[0]).toEqual({ role: 'user', content: 'Первая реплика' });
    expect(messages[1]).toEqual({ role: 'assistant', content: 'Ответ' });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        expect.objectContaining({ type: 'image' }),
        { type: 'text', text: 'Последняя реплика' },
      ],
    });
  });

  it.each(['image/jpeg', 'image/png', 'image/webp'] as const)(
    'тип %s уходит в media_type как есть',
    async (mimeType) => {
      const { create, deps } = setup();

      await createAnthropicLlm(deps).structured({
        ...LOGO_REQUEST,
        image: { data: PHOTO_BYTES, mimeType },
      });

      const content = sentParams(create).messages[0]?.content;
      expect(Array.isArray(content) && content[0]).toMatchObject({
        source: { type: 'base64', media_type: mimeType },
      });
    },
  );

  it('байты берутся ровно те, что в массиве: часть общего буфера (byteOffset) не тянет соседние', async () => {
    const { create, deps } = setup();
    const shared = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);

    await createAnthropicLlm(deps).structured({
      ...LOGO_REQUEST,
      image: { data: shared.subarray(2, 5), mimeType: 'image/jpeg' },
    });

    const content = sentParams(create).messages[0]?.content;
    expect(Array.isArray(content) && content[0]).toMatchObject({
      source: { data: Buffer.from([1, 2, 3]).toString('base64') },
    });
  });

  it('без картинки все реплики остаются строками, как раньше', async () => {
    const { create, deps } = setup();

    await createAnthropicLlm(deps).structured(REQUEST);

    expect(sentParams(create).messages.map((message) => typeof message.content)).toEqual([
      'string',
      'string',
      'string',
    ]);
  });

  it('вызов logo: effort low, модель из запроса, а в лог расхода идёт вид вызова logo', async () => {
    const { create, records, deps } = setup();

    const result = await createAnthropicLlm(deps).structured(LOGO_REQUEST);

    expect(result).toEqual({ ok: true, value: { answer: 'Понял вас' } });
    expect(sentParams(create).output_config?.effort).toBe('low');
    expect(sentParams(create).model).toBe(MODEL);
    expect(records).toEqual([
      expect.objectContaining({ provider: 'anthropic', purpose: 'logo', model: MODEL, ok: true }),
    ]);
  });

  it('сбой вызова с картинкой тоже пишется в расход с видом logo; в лог не попадают байты и base64', async () => {
    const { create, records, entries, deps } = setup();
    create.mockRejectedValueOnce(new APIConnectionError({ message: 'Connection error.' }));

    const result = await createAnthropicLlm(deps).structured(LOGO_REQUEST);

    expect(result).toEqual({ ok: false, failure: 'unavailable' });
    expect(records).toEqual([expect.objectContaining({ purpose: 'logo', ok: false })]);
    expect(JSON.stringify(entries)).not.toContain(PHOTO_BASE64);
  });
});

describe('createAnthropicLlm: ответ', () => {
  it('возвращает значение по схеме из текстового блока и пишет расход (null в кэше => 0)', async () => {
    const { records, deps } = setup();

    const result = await createAnthropicLlm(deps).structured(REQUEST);

    expect(result).toEqual({ ok: true, value: { answer: 'Понял вас' } });
    expect(records).toEqual([
      {
        provider: 'anthropic',
        purpose: 'reply',
        model: MODEL,
        input: 120,
        output: 45,
        cacheRead: 9000,
        cacheWrite: 0,
        chatId: CHAT_ID,
        ok: true,
      },
    ]);
  });

  it('null в чтении кэша тоже пишется нулём', async () => {
    const { create, records, deps } = setup();
    const usage = { ...USAGE, cache_read_input_tokens: null, cache_creation_input_tokens: 700 };
    create.mockResolvedValueOnce(message({ usage }));

    await createAnthropicLlm(deps).structured(REQUEST);

    expect(records[0]).toMatchObject({ cacheRead: 0, cacheWrite: 700 });
  });

  it.each([
    ['refusal', 'refusal'],
    ['max_tokens', 'truncated'],
    ['model_context_window_exceeded', 'truncated'],
  ] as const)('stop_reason %s => %s, расход всё равно записан', async (stopReason, failure) => {
    const { create, records, entries, deps } = setup();
    create.mockResolvedValueOnce(message({ stop_reason: stopReason }));

    const result = await createAnthropicLlm(deps).structured(REQUEST);

    expect(result).toEqual({ ok: false, failure });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ input: 120, output: 45 });
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        context: expect.objectContaining({ failure }) as unknown,
      }),
    );
  });

  it.each([
    ['не JSON', [{ type: 'text', text: 'Понял вас', citations: null }]],
    ['JSON не по схеме', [{ type: 'text', text: '{"answer":42}', citations: null }]],
    ['нет текстового блока', [{ type: 'thinking', thinking: '...', signature: 'sig' }]],
  ])('%s => invalid_output, расход записан', async (_name, content) => {
    const { create, records, deps } = setup();
    create.mockResolvedValueOnce(message({ content }));

    const result = await createAnthropicLlm(deps).structured(REQUEST);

    expect(result).toEqual({ ok: false, failure: 'invalid_output' });
    expect(records).toHaveLength(1);
  });
});

describe('createAnthropicLlm: дневной лимит', () => {
  it.each(['chat', 'global'] as const)(
    'отказ предохранителя (%s) => budget_exceeded без вызова API и без записи расхода',
    async (scope) => {
      const { create, records, deps } = setup({
        budget: { tryConsume: () => ({ ok: false, scope }) },
      });

      const result = await createAnthropicLlm(deps).structured(REQUEST);

      expect(result).toEqual({ ok: false, failure: 'budget_exceeded', scope });
      expect(create).not.toHaveBeenCalled();
      expect(records).toEqual([]);
    },
  );
});

describe('createAnthropicLlm: ошибки API', () => {
  it.each([
    ['429', 'rate_limited', new RateLimitError(429, undefined, 'rate limited', new Headers())],
    ['529', 'unavailable', new InternalServerError(529, undefined, 'overloaded', new Headers())],
    ['сеть', 'unavailable', new APIConnectionError({ message: 'Connection error.' })],
    ['тайм-аут', 'unavailable', new APIConnectionTimeoutError()],
    ['401', 'unavailable', new AuthenticationError(401, undefined, 'bad key', new Headers())],
    ['не ошибка SDK', 'unavailable', new TypeError('boom')],
    ['не Error', 'unavailable', 'boom'],
  ] as const)('%s => %s; неудачный вызов тоже пишется в расход', async (_name, failure, error) => {
    const { create, records, deps } = setup();
    create.mockRejectedValueOnce(error);

    const result = await createAnthropicLlm(deps).structured(REQUEST);

    expect(result).toEqual({ ok: false, failure });
    expect(records).toEqual([
      {
        provider: 'anthropic',
        purpose: 'reply',
        model: MODEL,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        chatId: CHAT_ID,
        ok: false,
      },
    ]);
  });

  it('в лог идут статус, тип ошибки и ID запроса, но не текст ошибки, текст клиента и ключ', async () => {
    const { create, entries, deps } = setup();
    const headers = new Headers({ 'request-id': 'req_123' });
    create.mockRejectedValueOnce(
      new BadRequestError(
        400,
        { type: 'error', error: { type: 'invalid_request_error', message: CLIENT_TEXT } },
        undefined,
        headers,
        'invalid_request_error',
      ),
    );

    await createAnthropicLlm(deps).structured(REQUEST);

    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        context: expect.objectContaining({
          failure: 'unavailable',
          status: 400,
          errorType: 'invalid_request_error',
          requestId: 'req_123',
        }) as unknown,
      }),
    );
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain('магазин');
    expect(logged).not.toContain(API_KEY);
  });

  it('сбой записи расхода не теряет ответ модели: ошибка уходит в лог', async () => {
    const records: TokenUsageEntry[] = [];
    const { entries, deps } = setup({
      tokenLog: createMemoryTokenLog(records, () => {
        throw new Error('EACCES');
      }),
    });

    const result = await createAnthropicLlm(deps).structured(REQUEST);

    expect(result).toEqual({ ok: true, value: { answer: 'Понял вас' } });
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        context: expect.objectContaining({ errorName: 'Error' }) as unknown,
      }),
    );
  });
});
