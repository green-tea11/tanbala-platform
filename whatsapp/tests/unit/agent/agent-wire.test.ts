import { Anthropic, type ClientOptions } from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createAgent } from '../../../src/agent/agent.js';
import type { TokenUsageEntry } from '../../../src/domain/types.js';
import { createAnthropicLlm } from '../../../src/llm/anthropic.js';
import { createFakeLogger, createMemoryTokenLog, fixedClock, openBudget } from '../llm/fakes.js';
import { context, EMPTY_PROFILE, KNOWLEDGE } from './fakes.js';

// Агент с настоящим адаптером Anthropic и SDK, но с поддельным fetch: видно, что именно уйдёт по сети
// (тела трёх вызовов), а сама сеть не трогается.

// Модели как в config/models.json: ответ, проверка и оценка интереса на Sonnet 5.5, логотип на Haiku 5.5.
const REPLY_MODEL = 'claude-sonnet-5-5';
const CHECK_MODEL = 'claude-sonnet-5-5';
const LOGO_MODEL = 'claude-haiku-5-5';
const MODELS = {
  reply: REPLY_MODEL,
  review: CHECK_MODEL,
  interest: CHECK_MODEL,
  logo: LOGO_MODEL,
} as const;

const REPLIES = [
  {
    outcome: 'answer',
    text: 'Какой у вас бизнес?',
    stopRequested: false,
    companyQuestion: 'none',
    aboutPrice: false,
    stage: 'intro',
    usedFacts: ['F7', 'F7'],
  },
  { ok: false, problems: [{ kind: 'fact', text: 'Назван срок внедрения' }] },
  {
    level: 'warm',
    business: 'магазин одежды',
    area: '',
    scope: '',
    itemCount: '',
    has1C: true,
    problem: '',
    specifics: '',
    reason: 'Рассказал о бизнесе',
    companyName: 'ТОО Альфа',
    companyCity: '',
    companyAliases: [],
    companyAnswer: 'none',
    confirmedPains: ['пересчёт занимает дни'],
    oneCName: '',
    problemAgreed: true,
    items: '',
    packaging: '',
    material: '',
    city: '',
    premises: '',
    turnover: '',
    currentTracking: '',
    monthlyIntake: '',
    passages: '',
    shelfRecount: '',
    inferred: [],
    priceAsked: true,
    refused: false,
  },
];

interface SentBody {
  readonly model: string;
  readonly system: readonly Record<string, unknown>[];
  readonly output_config: {
    readonly effort: string;
    readonly format: { readonly schema: unknown };
  };
}

function apiMessage(content: unknown, model: string): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_wire',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: JSON.stringify(content) }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 40,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 7000,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function setup() {
  const sent: SentBody[] = [];
  const records: TokenUsageEntry[] = [];
  const fakeFetch = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as SentBody;
    sent.push(body);
    return Promise.resolve(apiMessage(REPLIES[sent.length - 1], body.model));
  };
  const llm = createAnthropicLlm({
    apiKey: 'test-key-not-real',
    createSdk: (options: ClientOptions) => new Anthropic({ ...options, fetch: fakeFetch }),
    budget: openBudget,
    clock: fixedClock,
    tokenLog: createMemoryTokenLog(records),
    logger: createFakeLogger([]),
  });
  return {
    sent,
    records,
    agent: createAgent({ llm, knowledge: KNOWLEDGE, models: MODELS }),
  };
}

describe('агент с настоящим адаптером Anthropic', () => {
  it('три вызова: блок знаний с точкой кэша в теле запроса один и тот же байт в байт, effort low, свои схемы', async () => {
    const { sent, agent } = setup();

    await agent.draftReply(context());
    await agent.reviewDraft(context(), 'Какой у вас бизнес?');
    await agent.assessInterest(context());

    expect(sent).toHaveLength(3);
    expect(sent.map((body) => body.model)).toEqual([REPLY_MODEL, CHECK_MODEL, CHECK_MODEL]);
    const knowledgeBlocks = sent.map((body) => JSON.stringify(body.system[0]));
    expect(knowledgeBlocks[1]).toBe(knowledgeBlocks[0]);
    expect(knowledgeBlocks[2]).toBe(knowledgeBlocks[0]);
    expect(sent[0]?.system[0]).toMatchObject({ cache_control: { type: 'ephemeral' } });
    expect(sent.map((body) => body.system[1]?.['cache_control'])).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(sent.map((body) => body.output_config.effort)).toEqual(['low', 'low', 'low']);
    expect(sent.map((body) => body.output_config.format.schema)).toEqual([
      expect.objectContaining({
        required: [
          'outcome',
          'text',
          'stopRequested',
          'companyQuestion',
          'aboutPrice',
          'stage',
          'usedFacts',
        ],
      }),
      expect.objectContaining({ required: ['ok', 'problems'] }),
      expect.objectContaining({
        required: [
          'level',
          'business',
          'items',
          'packaging',
          'material',
          'city',
          'premises',
          'area',
          'scope',
          'itemCount',
          'turnover',
          'currentTracking',
          'monthlyIntake',
          'passages',
          'shelfRecount',
          'has1C',
          'problem',
          'specifics',
          'reason',
          'companyName',
          'companyCity',
          'companyAliases',
          'companyAnswer',
          'confirmedPains',
          'oneCName',
          'problemAgreed',
          'priceAsked',
          'refused',
          'inferred',
        ],
      }),
    ]);
  });

  it.each(['temperature', 'top_p', 'top_k', 'thinking'])(
    'в теле запроса нет поля %s ни у одного из трёх вызовов: Haiku 5.5 и Sonnet 5.5 ответили бы 400',
    async (field) => {
      const { sent, agent } = setup();

      await agent.draftReply(context());
      await agent.reviewDraft(context(), 'Какой у вас бизнес?');
      await agent.assessInterest(context());

      expect(sent).toHaveLength(3);
      for (const body of sent) expect(body).not.toHaveProperty(field);
    },
  );

  it('ответы проверки и оценки разбираются по схеме и нормализуются; расход пишется по каждому вызову', async () => {
    const { records, agent } = setup();
    const ctx = context({ profile: { ...EMPTY_PROFILE, area: '300 м2' }, level: 'cold' });

    const drafted = await agent.draftReply(ctx);
    const review = await agent.reviewDraft(ctx, 'Какой у вас бизнес?');
    const interest = await agent.assessInterest(ctx);

    expect(drafted).toEqual({
      ok: true,
      value: { outcome: 'answer', text: 'Какой у вас бизнес?', stage: 'intro', usedFacts: ['F7'] },
    });
    expect(review).toEqual({ ok: true, value: { ok: false, problems: ['Назван срок внедрения'] } });
    expect(interest).toEqual({
      ok: true,
      value: {
        level: 'warm',
        profile: {
          ...EMPTY_PROFILE,
          business: 'магазин одежды',
          area: '300 м2',
          has1C: true,
          problemAgreed: true,
          items: null,
          packaging: null,
          material: null,
          city: null,
          premises: null,
          turnover: null,
          currentTracking: null,
          monthlyIntake: null,
          passages: null,
          shelfRecount: null,
          inferred: [],
        },
        reason: 'Рассказал о бизнесе',
        company: {
          name: 'ТОО Альфа',
          city: null,
          aliases: [],
          answer: 'none',
          pains: ['пересчёт занимает дни'],
        },
        signals: { priceAsked: true, refused: false },
      },
    });
    expect(
      records.map(({ purpose, provider, model, cacheRead }) => ({
        provider,
        purpose,
        model,
        cacheRead,
      })),
    ).toEqual([
      { provider: 'anthropic', purpose: 'reply', model: REPLY_MODEL, cacheRead: 7000 },
      { provider: 'anthropic', purpose: 'review', model: CHECK_MODEL, cacheRead: 7000 },
      { provider: 'anthropic', purpose: 'interest', model: CHECK_MODEL, cacheRead: 7000 },
    ]);
  });
});
