import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { describe, expect, it } from 'vitest';
import { createAgent, type ConversationContext } from '../../../src/agent/agent.js';
import { buildSystem } from '../../../src/agent/prompts.js';
import type { ClientProfile, LlmResult, ReplyDraft } from '../../../src/domain/types.js';
import {
  CHAT_ID,
  context,
  EMPTY_PROFILE,
  fakeLlm,
  history,
  KNOWLEDGE,
  MODELS,
  onlyRequest,
} from './fakes.js';

async function draft(
  answer: LlmResult<unknown>,
  ctx: ConversationContext = context(),
  feedback?: readonly string[],
) {
  const { requests, llm } = fakeLlm(answer);
  const agent = createAgent({ llm, knowledge: KNOWLEDGE, models: MODELS });
  const result = await agent.draftReply(ctx, feedback);
  return { result, request: onlyRequest(requests) };
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

  it('выжимка пустая и замечаний нет: блока данных нет, последняя реплика слова клиента', async () => {
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

describe('createAgent: три вызова', () => {
  it('первый блок system (знания с кэшем) одинаков байт в байт у ответа, проверки и оценки интереса', async () => {
    const { requests, llm } = fakeLlm({ ok: false, failure: 'disabled' });
    const agent = createAgent({ llm, knowledge: KNOWLEDGE, models: MODELS });

    await agent.draftReply(context());
    await agent.reviewDraft(context(), 'Какой у вас бизнес?');
    await agent.assessInterest(context());

    expect(requests.map(({ purpose }) => purpose)).toEqual(['reply', 'review', 'interest']);
    const knowledgeBlocks = requests.map(({ system }) => system[0]);
    expect(knowledgeBlocks[0]?.cache).toBe(true);
    expect(knowledgeBlocks[1]).toEqual(knowledgeBlocks[0]);
    expect(knowledgeBlocks[2]).toEqual(knowledgeBlocks[0]);
    expect(knowledgeBlocks[1]?.text).toBe(knowledgeBlocks[0]?.text);
    expect(knowledgeBlocks[2]?.text).toBe(knowledgeBlocks[0]?.text);
  });

  it('после знаний у каждого вызова своя инструкция без кэша', async () => {
    const { requests, llm } = fakeLlm({ ok: false, failure: 'disabled' });
    const agent = createAgent({ llm, knowledge: KNOWLEDGE, models: MODELS });

    await agent.draftReply(context());
    await agent.reviewDraft(context(), 'Какой у вас бизнес?');
    await agent.assessInterest(context());

    expect(requests.every(({ system }) => system.length === 2)).toBe(true);
    expect(requests.every(({ system }) => system[1]?.cache === false)).toBe(true);
    expect(new Set(requests.map(({ system }) => system[1]?.text)).size).toBe(3);
  });
});
