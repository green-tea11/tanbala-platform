import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { describe, expect, it } from 'vitest';
import { createAgent, type ConversationContext } from '../../../src/agent/agent.js';
import type { Knowledge } from '../../../src/agent/knowledge.js';
import { buildSystem } from '../../../src/agent/prompts.js';
import type { LlmClient, StructuredRequest } from '../../../src/domain/ports.js';
import type {
  ChatId,
  ClientProfile,
  LlmResult,
  ReplyDraft,
  StoredMessage,
} from '../../../src/domain/types.js';
import { NotImplementedError } from '../../../src/shared/todo.js';

const KNOWLEDGE: Knowledge = {
  owner: '# Tanbala: что должен знать агент\n',
  whatsapp: '# Tanbala в WhatsApp\n',
  version: 'v1',
};
const MODELS = {
  reply: 'claude-haiku-5-5',
  review: 'claude-review-model',
  interest: 'claude-interest-model',
} as const;
const CHAT_ID = 11 as ChatId;
const BASE_TS = Date.UTC(2026, 9, 26, 6, 0, 0);

const EMPTY_PROFILE: ClientProfile = {
  business: null,
  area: null,
  scope: null,
  itemCount: null,
  has1C: null,
  problem: null,
  specifics: null,
};

function history(count: number): StoredMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    chatId: CHAT_ID,
    author: index % 2 === 0 ? 'client' : 'bot',
    kind: 'text',
    text: `сообщение ${index + 1}`,
    tsMs: BASE_TS + index * 1000,
  }));
}

function context(overrides: Partial<ConversationContext> = {}): ConversationContext {
  return {
    chatId: CHAT_ID,
    history: [
      {
        id: 1,
        chatId: CHAT_ID,
        author: 'client',
        kind: 'text',
        text: 'Здравствуйте, сколько стоит учёт?',
        tsMs: BASE_TS,
      },
    ],
    profile: EMPTY_PROFILE,
    ...overrides,
  };
}

/** LlmClient, который запоминает запрос и отвечает заданным значением (как будто прошло схему). */
function fakeLlm(answer: LlmResult<unknown>) {
  const requests: StructuredRequest<unknown>[] = [];
  const llm: LlmClient = {
    structured: <T>(request: StructuredRequest<T>): Promise<LlmResult<T>> => {
      requests.push(request);
      return Promise.resolve(answer as LlmResult<T>);
    },
  };
  return { requests, llm };
}

async function draft(
  answer: LlmResult<unknown>,
  ctx: ConversationContext = context(),
  feedback?: readonly string[],
) {
  const { requests, llm } = fakeLlm(answer);
  const agent = createAgent({ llm, knowledge: KNOWLEDGE, models: MODELS });
  const result = await agent.draftReply(ctx, feedback);
  const request = requests[0];
  if (request === undefined) {
    throw new Error('LLM не вызван');
  }
  return { result, request };
}

const ANSWER = {
  outcome: 'answer',
  text: 'Цена зависит от задачи. Какой у вас бизнес?',
  stopRequested: false,
} as const;

describe('createAgent: draftReply, запрос', () => {
  it('вызов ответа: модель reply, знания с кэшем и инструкция ответа, чат и запас токенов на размышления', async () => {
    const { request } = await draft({ ok: true, value: ANSWER });

    expect(request.purpose).toBe('reply');
    expect(request.model).toBe(MODELS.reply);
    expect(request.chatId).toBe(CHAT_ID);
    expect(request.system).toEqual(buildSystem(KNOWLEDGE, 'reply'));
    expect(request.maxTokens).toBeGreaterThanOrEqual(1024);
  });

  it('реплики: история клиента, в последней реплике user данные: выжимка и замечания проверки', async () => {
    const profile: ClientProfile = {
      ...EMPTY_PROFILE,
      business: 'магазин одежды',
      area: '300 м2',
      has1C: true,
    };

    const { request } = await draft({ ok: true, value: ANSWER }, context({ profile }), [
      'В ответе названа цена',
      '  ',
    ]);

    const last = request.turns.at(-1);
    expect(last?.role).toBe('user');
    expect(last?.text.startsWith('Здравствуйте, сколько стоит учёт?')).toBe(true);
    expect(last?.text).toContain('<данные>');
    expect(last?.text).toMatch(/Бизнес: магазин одежды/);
    expect(last?.text).toMatch(/Площадь: 300 м2/);
    expect(last?.text).toMatch(/1С: есть/);
    expect(last?.text).not.toMatch(/Задача|не выяснили/);
    expect(last?.text).toContain('В ответе названа цена');
  });

  it('выжимка пустая (до этапа 4) и замечаний нет: блока данных нет, последняя реплика слова клиента', async () => {
    const { request } = await draft({ ok: true, value: ANSWER });

    expect(request.turns.at(-1)).toEqual({
      role: 'user',
      text: 'Здравствуйте, сколько стоит учёт?',
    });
  });

  it('выжимка пустая, есть замечания: в данных только замечания', async () => {
    const { request } = await draft({ ok: true, value: ANSWER }, context(), ['Слишком длинно']);

    const last = request.turns.at(-1)?.text ?? '';
    expect(last).toContain('Слишком длинно');
    expect(last).not.toMatch(/выжимка|не выяснили/);
  });

  it('без замечаний в данных только выжимка', async () => {
    const profile: ClientProfile = { ...EMPTY_PROFILE, has1C: false };

    const { request } = await draft({ ok: true, value: ANSWER }, context({ profile }));

    expect(request.turns.at(-1)?.text).toMatch(/1С: нет/);
    expect(request.turns.at(-1)?.text).not.toMatch(/Замечания/);
  });

  it('в промпт уходят только последние сообщения истории', async () => {
    // Выжимка не пустая: данные вызова идут отдельной репликой user, последнее сообщение бота остаётся в окне.
    const profile: ClientProfile = { ...EMPTY_PROFILE, business: 'склад' };
    const { request } = await draft(
      { ok: true, value: ANSWER },
      context({ history: history(80), profile }),
    );

    const prompt = request.turns.map(({ text }) => text).join('\n');
    expect(prompt).toMatch(/сообщение 79(?!\d)/);
    expect(prompt).toMatch(/сообщение 80(?!\d)/);
    expect(prompt).not.toMatch(/сообщение 1(?!\d)/);
    expect(prompt).not.toMatch(/сообщение 2(?!\d)/);
  });

  it('схема ответа: плоский объект для structured outputs, все поля обязательны', async () => {
    const { request } = await draft({ ok: true, value: ANSWER });

    expect(zodOutputFormat(request.schema).schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'text', 'stopRequested'],
    });
    expect(request.schema.safeParse(ANSWER).success).toBe(true);
    expect(
      request.schema.safeParse({ outcome: 'hot', text: '', stopRequested: false }).success,
    ).toBe(false);
    expect(request.schema.safeParse({ outcome: 'answer', text: 'Да' }).success).toBe(false);
  });
});

describe('createAgent: draftReply, нормализация ответа модели', () => {
  it.each([
    [ANSWER, { outcome: 'answer', text: 'Цена зависит от задачи. Какой у вас бизнес?' }],
    [
      { outcome: 'answer', text: '  Добрый день.  ', stopRequested: false },
      { outcome: 'answer', text: 'Добрый день.' },
    ],
    [{ outcome: 'no_answer', text: 'лишний текст', stopRequested: true }, { outcome: 'no_answer' }],
    [{ outcome: 'asked_human', text: '', stopRequested: false }, { outcome: 'asked_human' }],
    [
      { outcome: 'complaint', text: '', stopRequested: true },
      { outcome: 'complaint', stopRequested: true },
    ],
    [
      { outcome: 'complaint', text: 'Извините', stopRequested: false },
      { outcome: 'complaint', stopRequested: false },
    ],
  ] as const)('%j => %j', async (raw, expected: ReplyDraft) => {
    const { result } = await draft({ ok: true, value: raw });

    expect(result).toEqual({ ok: true, value: expected });
  });

  it.each(['', '   \n'])(
    'answer с пустым текстом %j => invalid_output, не угадывать',
    async (text) => {
      const { result } = await draft({
        ok: true,
        value: { outcome: 'answer', text, stopRequested: false },
      });

      expect(result).toEqual({ ok: false, failure: 'invalid_output' });
    },
  );

  it.each([
    { ok: false, failure: 'unavailable' },
    { ok: false, failure: 'refusal' },
    { ok: false, failure: 'budget_exceeded', scope: 'chat' },
  ] as const)('сбой LLM %j возвращается как есть', async (failure) => {
    const { result } = await draft(failure);

    expect(result).toEqual(failure);
  });
});

describe('createAgent: этап 4', () => {
  it('проверка черновика и оценка интереса пока заготовки', () => {
    const { llm } = fakeLlm({ ok: false, failure: 'disabled' });
    const agent = createAgent({ llm, knowledge: KNOWLEDGE, models: MODELS });

    expect(() => agent.reviewDraft(context(), 'черновик')).toThrow(NotImplementedError);
    expect(() => agent.assessInterest(context())).toThrow(NotImplementedError);
  });
});
