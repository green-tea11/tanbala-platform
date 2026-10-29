import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { describe, expect, it } from 'vitest';
import { createAgent } from '../../../src/agent/agent.js';
import {
  interestCallData,
  normalizeInterest,
  type RawInterest,
} from '../../../src/agent/interest.js';
import { buildSystem } from '../../../src/agent/prompts.js';
import type { ClientProfile, LlmResult } from '../../../src/domain/types.js';
import {
  CHAT_ID,
  CLIENT_TEXT,
  context,
  EMPTY_PROFILE,
  fakeLlm,
  KNOWLEDGE,
  MODELS,
  onlyRequest,
  SILENT_LOGGER,
} from './fakes.js';

const NOTHING_NEW: RawInterest = {
  level: 'cold',
  business: null,
  items: null,
  packaging: null,
  material: null,
  city: null,
  premises: null,
  area: null,
  scope: null,
  itemCount: null,
  turnover: null,
  currentTracking: null,
  has1C: null,
  problem: null,
  specifics: null,
  reason: 'Спрашивает в общем',
};

const KNOWN: ClientProfile = {
  business: 'магазин одежды',
  area: '300 м2',
  scope: 'где лежит каждая вещь',
  itemCount: 'около 5000',
  has1C: true,
  oneCName: '1С:Розница',
  problem: 'пересчёт занимает дни',
  specifics: 'два входа',
  problemAgreed: true,
  items: null,
  packaging: null,
  material: null,
  city: null,
  premises: null,
  turnover: null,
  currentTracking: null,
};

const FIELD_NAMES = [
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
  'has1C',
  'problem',
  'specifics',
  'reason',
  'companyName',
  'companyCity',
  'companyAnswer',
  'confirmedPains',
  'oneCName',
  'problemAgreed',
  'priceAsked',
  'refused',
];

/** Поля о компании, которые настоящая схема требует всегда: клиент о компании ничего не сказал. */
const NO_COMPANY = {
  companyName: null,
  companyCity: null,
  companyAnswer: 'none',
  confirmedPains: [],
} as const;

/** Поля минимума и сигналы хода, которые настоящая схема требует всегда: ничего нового. */
const NO_SIGNALS = {
  oneCName: null,
  problemAgreed: false,
  items: null,
  packaging: null,
  material: null,
  city: null,
  premises: null,
  turnover: null,
  currentTracking: null,
  priceAsked: false,
  refused: false,
} as const;

async function assess(answer: LlmResult<unknown>, ctx = context()) {
  const { requests, llm } = fakeLlm(answer);
  const agent = createAgent({ llm, knowledge: KNOWLEDGE, models: MODELS, logger: SILENT_LOGGER });
  const result = await agent.assessInterest(ctx);
  return { result, requests };
}

describe('createAgent: assessInterest, запрос', () => {
  it('вызов оценки: модель interest, знания с кэшем и инструкция оценки, чат и запас токенов на размышления', async () => {
    const { requests } = await assess({ ok: true, value: NOTHING_NEW });
    const request = onlyRequest(requests);

    expect(request.purpose).toBe('interest');
    expect(request.model).toBe(MODELS.interest);
    expect(request.chatId).toBe(CHAT_ID);
    expect(request.system).toEqual(buildSystem(KNOWLEDGE, 'interest'));
    expect(request.maxTokens).toBeGreaterThanOrEqual(1024);
  });

  it('данные вызова: после слов клиента текущий уровень и выжимка', async () => {
    const { requests } = await assess(
      { ok: true, value: NOTHING_NEW },
      context({ profile: KNOWN, level: 'warm' }),
    );

    const { turns } = onlyRequest(requests);
    const last = turns.at(-1);
    expect(turns).toHaveLength(1);
    expect(last?.role).toBe('user');
    expect(last?.text.startsWith(CLIENT_TEXT)).toBe(true);
    expect(last?.text).toContain('<данные>');
    expect(last?.text).toMatch(/warm/);
    expect(last?.text).toMatch(/Бизнес: магазин одежды/);
    expect(last?.text).toMatch(/1С: есть/);
    expect(last?.text.endsWith('</данные>')).toBe(true);
  });

  it('выжимка пустая и уровня нет: данные всё равно есть и говорят, что ничего не выяснено', async () => {
    const { requests } = await assess({ ok: true, value: NOTHING_NEW });

    const last = onlyRequest(requests).turns.at(-1)?.text ?? '';
    expect(last).toContain('<данные>');
    expect(last).toMatch(/ничего/);
    expect(last).not.toMatch(/Уровень/);
  });

  it('схема оценки: плоский объект из двадцати четырёх полей, все обязательны', async () => {
    const { requests } = await assess({ ok: true, value: NOTHING_NEW });
    const { schema } = onlyRequest(requests);

    const json = zodOutputFormat(schema).schema;
    expect(json).toMatchObject({ type: 'object', additionalProperties: false });
    // Описание до nullable: поля идут в anyOf [тип, null] без $ref. В $defs SDK выносит только строку элемента
    // списка confirmedPains (так же у списка замечаний проверки).
    const properties = json['properties'] as Record<string, Record<string, unknown>>;
    expect(JSON.stringify(properties['business'])).not.toContain('$ref');
    expect(JSON.stringify(properties['companyName'])).not.toContain('$ref');
    expect(properties['companyName']).toHaveProperty('anyOf');
    expect([...(json['required'] as string[])].sort()).toEqual([...FIELD_NAMES].sort());
    const full = { ...NOTHING_NEW, ...NO_COMPANY, ...NO_SIGNALS };
    expect(schema.safeParse(full).success).toBe(true);
    expect(schema.safeParse(NOTHING_NEW).success).toBe(false);
    expect(schema.safeParse({ ...NOTHING_NEW, ...NO_COMPANY }).success).toBe(false);
    expect(schema.safeParse({ ...full, ...KNOWN, level: 'hot' }).success).toBe(true);
    expect(schema.safeParse({ ...full, priceAsked: 'да' }).success).toBe(false);
    expect(schema.safeParse({ ...full, problemAgreed: null }).success).toBe(false);
    expect(schema.safeParse({ ...full, level: 'burning' }).success).toBe(false);
    expect(schema.safeParse({ ...full, has1C: 'есть' }).success).toBe(false);
    expect(schema.safeParse({ ...full, business: 5 }).success).toBe(false);
    expect(schema.safeParse({ ...full, reason: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...full, companyAnswer: 'maybe' }).success).toBe(false);
    expect(schema.safeParse({ ...full, confirmedPains: 'теряются вещи' }).success).toBe(false);
  });
});

describe('createAgent: assessInterest, результат', () => {
  it('нормализованная оценка: уровень, выжимка с сохранёнными прежними полями и причина', async () => {
    const { result } = await assess(
      {
        ok: true,
        value: { ...NOTHING_NEW, level: 'hot', business: '  склад  ', reason: ' Спросил цену ' },
      },
      context({ profile: { ...EMPTY_PROFILE, area: '1000 м2' } }),
    );

    expect(result).toEqual({
      ok: true,
      value: {
        level: 'hot',
        profile: { ...EMPTY_PROFILE, business: 'склад', area: '1000 м2' },
        reason: 'Спросил цену',
      },
    });
  });

  it.each([
    { ok: false, failure: 'unavailable' },
    { ok: false, failure: 'refusal' },
    { ok: false, failure: 'truncated' },
    { ok: false, failure: 'invalid_output' },
    { ok: false, failure: 'rate_limited' },
    { ok: false, failure: 'disabled' },
    { ok: false, failure: 'budget_exceeded', scope: 'chat' },
  ] as const)('сбой LLM %j возвращается как есть', async (failure) => {
    const { result } = await assess(failure);

    expect(result).toEqual(failure);
  });
});

describe('normalizeInterest', () => {
  it('значения обрезаются по краям, пустые строки становятся null, перенос строки одним пробелом', () => {
    const raw: RawInterest = {
      ...NOTHING_NEW,
      business: '  магазин\nодежды  ',
      area: '   ',
      scope: '',
      problem: '\n\t',
      reason: ' причина ',
    };

    expect(normalizeInterest(raw, EMPTY_PROFILE)).toEqual({
      level: 'cold',
      profile: { ...EMPTY_PROFILE, business: 'магазин одежды' },
      reason: 'причина',
    });
  });

  it('null и пустое значение от модели не стирают то, что известно раньше', () => {
    const raw: RawInterest = { ...NOTHING_NEW, level: 'warm', area: '  ', has1C: null };

    expect(normalizeInterest(raw, KNOWN).profile).toEqual(KNOWN);
  });

  it('новое значение клиента заменяет известное раньше', () => {
    const raw: RawInterest = {
      ...NOTHING_NEW,
      area: '500 м2',
      itemCount: 'около 8000',
      has1C: false,
    };

    expect(normalizeInterest(raw, KNOWN).profile).toEqual({
      ...KNOWN,
      area: '500 м2',
      itemCount: 'около 8000',
      has1C: false,
    });
  });

  it('has1C false не считается пустым и не заменяется прежним true', () => {
    const profile = normalizeInterest({ ...NOTHING_NEW, has1C: false }, KNOWN).profile;

    expect(profile.has1C).toBe(false);
  });

  it('длина: текстовые поля до 200 знаков, причина до 300', () => {
    const raw: RawInterest = {
      ...NOTHING_NEW,
      business: 'б'.repeat(250),
      specifics: 'с'.repeat(201),
      reason: 'п'.repeat(400),
    };

    const result = normalizeInterest(raw, EMPTY_PROFILE);

    expect(Array.from(result.profile.business ?? '')).toHaveLength(200);
    expect(Array.from(result.profile.specifics ?? '')).toHaveLength(200);
    expect(Array.from(result.reason)).toHaveLength(300);
  });

  it('какая 1С: чистится как текстовое поле и не стирается null; названная 1С значит, что 1С есть', () => {
    const named = normalizeInterest(
      { ...NOTHING_NEW, ...NO_SIGNALS, oneCName: '  1С:Управление\nторговлей ' },
      EMPTY_PROFILE,
    ).profile;
    const kept = normalizeInterest({ ...NOTHING_NEW, ...NO_SIGNALS }, KNOWN).profile;
    const denied = normalizeInterest(
      { ...NOTHING_NEW, ...NO_SIGNALS, has1C: false, oneCName: 'УТ' },
      EMPTY_PROFILE,
    ).profile;

    expect(named).toMatchObject({ oneCName: '1С:Управление торговлей', has1C: true });
    expect(kept.oneCName).toBe('1С:Розница');
    expect(denied.has1C).toBe(false);
  });

  it('согласие, что трудность есть: раз выяснено, не теряется; подделка без поля не меняет прежнее', () => {
    const agreed = normalizeInterest(
      { ...NOTHING_NEW, ...NO_SIGNALS, problemAgreed: true },
      EMPTY_PROFILE,
    );
    const kept = normalizeInterest({ ...NOTHING_NEW, ...NO_SIGNALS }, KNOWN);

    expect(agreed.profile.problemAgreed).toBe(true);
    expect(kept.profile.problemAgreed).toBe(true);
    expect(normalizeInterest(NOTHING_NEW, EMPTY_PROFILE).profile.problemAgreed).toBe(false);
  });

  it('сигналы хода: вопрос цены и отказ отвечать идут отдельно от выжимки; без полей их нет', () => {
    const asked = normalizeInterest(
      { ...NOTHING_NEW, ...NO_SIGNALS, priceAsked: true, refused: true },
      EMPTY_PROFILE,
    );

    expect(asked.signals).toEqual({ priceAsked: true, refused: true });
    expect(normalizeInterest({ ...NOTHING_NEW, ...NO_SIGNALS }, KNOWN).signals).toEqual({
      priceAsked: false,
      refused: false,
    });
    expect(normalizeInterest(NOTHING_NEW, KNOWN)).not.toHaveProperty('signals');
  });

  it('пустая причина остаётся пустой строкой, оценка не теряется', () => {
    const result = normalizeInterest({ ...NOTHING_NEW, level: 'hot', reason: '  ' }, KNOWN);

    expect(result.level).toBe('hot');
    expect(result.reason).toBe('');
  });
});

describe('interestCallData', () => {
  it('уровень и известные поля выжимки', () => {
    const data = interestCallData(KNOWN, 'warm');

    expect(data).toMatch(/warm/);
    expect(data).toMatch(/Бизнес: магазин одежды/);
    expect(data).toMatch(/Особенности: два входа/);
    expect(data).toMatch(/1С: есть, 1С:Розница/);
    expect(data).toMatch(/Клиент согласился, что трудность есть/);
  });

  it('уровня нет: строки про уровень нет', () => {
    expect(interestCallData(KNOWN, undefined)).not.toMatch(/Уровень/);
  });

  it('выжимка пустая: сказано, что ничего не выяснено, а не пустой блок', () => {
    const data = interestCallData(EMPTY_PROFILE, 'cold');

    expect(data).toMatch(/ничего/);
    expect(data).toMatch(/cold/);
    expect(data).not.toMatch(/Бизнес/);
  });
});
