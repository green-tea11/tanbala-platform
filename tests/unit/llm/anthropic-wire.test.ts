import { Anthropic, type ClientOptions } from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { StructuredRequest } from '../../../src/domain/ports.js';
import type { ChatId, TokenUsageEntry } from '../../../src/domain/types.js';
import { createAnthropicLlm, type AnthropicLlmDeps } from '../../../src/llm/anthropic.js';
import {
  createFakeLogger,
  createMemoryTokenLog,
  fixedClock,
  openBudget,
  type LogEntry,
} from './fakes.js';

// Настоящий SDK 0.135.0 с поддельным fetch: видно, что именно уйдёт по сети, но сеть не трогается.
// Без подделки fetch заблокирован tests/setup/no-network.ts.

const API_KEY = 'test-key-not-real';
const CHAT_ID = 3 as ChatId;
const schema = z.object({ answer: z.string() });

const REQUEST: StructuredRequest<z.infer<typeof schema>> = {
  purpose: 'reply',
  model: 'claude-haiku-5-5',
  system: [
    { text: 'ЗНАНИЯ', cache: true },
    { text: 'ИНСТРУКЦИЯ', cache: false },
  ],
  turns: [{ role: 'user', text: 'Здравствуйте' }],
  schema,
  maxTokens: 1024,
  chatId: CHAT_ID,
};

const API_MESSAGE = {
  id: 'msg_wire',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: [{ type: 'text', text: '{"answer":"Добрый день"}' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 15,
    output_tokens: 30,
    cache_creation_input_tokens: 6000,
    cache_read_input_tokens: 0,
  },
};

interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_wire' },
  });
}

function setup(respond: () => Response) {
  const sent: Sent[] = [];
  const records: TokenUsageEntry[] = [];
  const entries: LogEntry[] = [];
  const fakeFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    sent.push({
      url: input instanceof Request ? input.url : String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >,
    });
    return Promise.resolve(respond());
  };
  const deps: AnthropicLlmDeps = {
    apiKey: API_KEY,
    createSdk: (options: ClientOptions) => new Anthropic({ ...options, fetch: fakeFetch }),
    budget: openBudget,
    clock: fixedClock,
    tokenLog: createMemoryTokenLog(records),
    logger: createFakeLogger(entries),
  };
  return { sent, records, llm: createAnthropicLlm(deps) };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createAnthropicLlm с настоящим SDK', () => {
  it('идёт на api.anthropic.com только с нашим ключом, даже если в окружении чужие адрес и токен', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://proxy.example.invalid');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'env-token-not-ours');
    const { sent, records, llm } = setup(() => jsonResponse(200, API_MESSAGE));

    const result = await llm.structured(REQUEST);

    expect(result).toEqual({ ok: true, value: { answer: 'Добрый день' } });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent[0]?.headers.get('x-api-key')).toBe(API_KEY);
    expect(sent[0]?.headers.has('authorization')).toBe(false);
    expect(records[0]).toMatchObject({ input: 15, output: 30, cacheRead: 0, cacheWrite: 6000 });
  });

  it('тело запроса: кэш на блоке знаний, формат json_schema и effort, без temperature, top_p, top_k и prefill', async () => {
    const { sent, llm } = setup(() => jsonResponse(200, API_MESSAGE));

    await llm.structured(REQUEST);

    const body = sent[0]?.body ?? {};
    expect(Object.keys(body).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'output_config',
      'system',
    ]);
    expect(body).toMatchObject({
      system: [
        { type: 'text', text: 'ЗНАНИЯ', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'ИНСТРУКЦИЯ' },
      ],
      messages: [{ role: 'user', content: 'Здравствуйте' }],
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: { type: 'object', required: ['answer'] } },
      },
    });
  });

  it.each([
    [429, 'rate_limit_error', 'rate_limited'],
    [529, 'overloaded_error', 'unavailable'],
    [500, 'api_error', 'unavailable'],
  ] as const)(
    'HTTP %i (%s) => %s без повторов SDK: ровно один запрос',
    async (status, errorType, failure) => {
      const { sent, records, llm } = setup(() =>
        jsonResponse(status, { type: 'error', error: { type: errorType, message: 'x' } }),
      );

      const result = await llm.structured(REQUEST);

      expect(result).toEqual({ ok: false, failure });
      expect(sent).toHaveLength(1);
      expect(records).toEqual([expect.objectContaining({ ok: false, input: 0, output: 0 })]);
    },
  );

  it('без фабрики создаёт настоящий SDK; заблокированная сеть => unavailable после одной попытки', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const records: TokenUsageEntry[] = [];
    const llm = createAnthropicLlm({
      apiKey: API_KEY,
      budget: openBudget,
      clock: fixedClock,
      tokenLog: createMemoryTokenLog(records),
      logger: createFakeLogger([]),
    });

    const result = await llm.structured(REQUEST);

    expect(result).toEqual({ ok: false, failure: 'unavailable' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(records).toEqual([expect.objectContaining({ ok: false })]);
  });
});
