import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createAgent, type ConversationContext } from '../../../src/agent/agent.js';
import type { Knowledge } from '../../../src/agent/knowledge.js';
import type { ModelsConfig } from '../../../src/config/env.js';
import type { Logger } from '../../../src/domain/ports.js';
import type { ChatId, ClientProfile, ReviewedText } from '../../../src/domain/types.js';
import { INTRO_BUSINESS_QUESTION } from '../../../src/pipeline/safe-questions.js';
import {
  decideReply,
  requestDraft,
  type ReplyFlowDeps,
  type ReplyVerdict,
} from '../../../src/pipeline/reply-flow.js';
import { scriptedLlm, type LlmScript } from './scripted-llm.js';

// Ход ответа с настоящим агентом (схемы, нормализация, запросы) и поддельной моделью: сети нет.

const CHAT_ID = 7 as ChatId;
const NOW = Date.UTC(2026, 9, 26, 9, 0, 0);
const HOT_TEXT =
  'Да, мы проводим интеграцию с вашей 1С, детали решаем по вашей конфигурации. Стоимость зависит от вашей задачи, уточню у коллеги и вернусь к вам.';
const FIRST = 'Учёт подбираем под задачу. Что вы храните?';
const SECOND = 'Решение подбирает коллега. Что вы хотите учитывать?';
const KNOWLEDGE: Knowledge = {
  owner: 'Документ',
  whatsapp: 'Правила',
  consult: 'Разговор',
  version: 'v1',
};
// Модели из config/models.json: ответ, проверка и оценка интереса на Sonnet.
const MODELS_FILE = JSON.parse(
  readFileSync(new URL('../../../config/models.json', import.meta.url), 'utf8'),
) as Record<string, string>;
const MODELS: ModelsConfig = {
  reply: MODELS_FILE['reply'] ?? '',
  review: MODELS_FILE['review'] ?? '',
  interest: MODELS_FILE['interest'] ?? '',
  logo: MODELS_FILE['logo'] ?? '',
};
const EMPTY_PROFILE: ClientProfile = {
  business: null,
  area: null,
  scope: null,
  itemCount: null,
  has1C: null,
  oneCName: null,
  problem: null,
  specifics: null,
  problemAgreed: false,
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
};
const CONTEXT: ConversationContext = {
  chatId: CHAT_ID,
  history: [
    { id: 1, chatId: CHAT_ID, author: 'client', kind: 'text', text: 'Сколько стоит?', tsMs: NOW },
  ],
  profile: EMPTY_PROFILE,
  level: 'cold',
};

/** Оценка интереса: для расчёта известно всё, исход hot модели принимается как финал (решение владельца 30.10.2026). */
const READY: LlmScript['interests'] = [
  {
    level: 'warm',
    profile: {
      business: 'склад',
      items: 'запчасти',
      itemCount: 'около 3000',
      monthlyIntake: '200 в месяц',
      passages: 'один вход',
      has1C: true,
      city: 'Алматы',
    },
  },
];

const logger: Logger = {
  level: 'info',
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  silent: () => undefined,
  child: () => logger,
};

async function run(script: LlmScript) {
  const model = scriptedLlm(script);
  const saveAssessment = vi.fn<ReplyFlowDeps['chats']['saveAssessment']>();
  const deps: ReplyFlowDeps = {
    chats: { saveAssessment },
    agent: createAgent({ llm: model.llm, knowledge: KNOWLEDGE, models: MODELS }),
    clock: { now: () => NOW },
    logger,
  };
  const drafted = await requestDraft(deps, CONTEXT);
  const verdict: ReplyVerdict = await decideReply(deps, CONTEXT, drafted);
  return { verdict, model, saveAssessment };
}

describe('pipeline/reply-flow с настоящим агентом', () => {
  it('три вызова разных назначений: черновик и оценка сразу, проверка после; ответ уходит', async () => {
    const { verdict, model, saveAssessment } = await run({ replies: [FIRST] });

    expect(verdict).toEqual({
      kind: 'send',
      text: FIRST as ReviewedText,
      marks: { stage: 'details', usedFacts: [] },
    });
    expect(model.purposes()).toEqual(['interest', 'reply', 'review']);
    expect(saveAssessment).toHaveBeenCalledWith(
      CHAT_ID,
      {
        level: 'cold',
        profile: EMPTY_PROFILE,
        reason: 'по разговору',
        company: { name: null, city: null, aliases: [], answer: 'none', pains: [] },
        signals: { priceAsked: false, refused: false },
      },
      NOW,
    );
  });

  it('проверка не пропустила: второй черновик получает замечание проверки, второй провал даёт безопасный вопрос', async () => {
    const { verdict, model } = await run({
      replies: [FIRST, SECOND],
      problems: ['Названа цена, её нет в знаниях'],
    });

    expect(verdict).toEqual({ kind: 'send', text: INTRO_BUSINESS_QUESTION });
    expect(model.purposes()).toEqual(['interest', 'reply', 'review', 'reply', 'review']);
    const retry = model.requests[3]?.turns.at(-1)?.text ?? '';
    expect(retry).toContain('Названа цена, её нет в знаниях');
    expect(model.requests[4]?.turns.at(-1)?.text).toContain(SECOND);
  });

  it('оценка интереса hot, а ответ answer: передачи нет, ответ проходит проверку и уходит', async () => {
    const { verdict, model, saveAssessment } = await run({ replies: [FIRST], level: 'hot' });

    expect(verdict).toEqual({
      kind: 'send',
      text: FIRST as ReviewedText,
      marks: { stage: 'details', usedFacts: [] },
    });
    expect(model.purposes()).toEqual(['interest', 'reply', 'review']);
    expect(saveAssessment).toHaveBeenCalledTimes(1);
  });

  it('горячий клиент по решению вызова ответа: ответ из знаний и фраза о передаче одним текстом, проверка знает, что это сообщение о передаче', async () => {
    const { verdict, model, saveAssessment } = await run({
      replies: [{ outcome: 'hot', text: HOT_TEXT }],
      interests: READY,
    });

    expect(verdict).toEqual({
      kind: 'handoff',
      notice: { reason: 'hot' },
      text: HOT_TEXT as ReviewedText,
      detail: 'Всё для расчёта известно, клиент готов к расчёту. Клиент: «Сколько стоит?»',
    });
    expect(model.purposes()).toEqual(['interest', 'reply', 'review']);
    const review = model.requests[2]?.turns.at(-1)?.text ?? '';
    expect(review).toContain(HOT_TEXT);
    expect(review).toMatch(/сообщения о передаче чата коллеге/);
    expect(saveAssessment).toHaveBeenNthCalledWith(
      2,
      CHAT_ID,
      expect.objectContaining({ level: 'hot' }),
      NOW,
    );
  });

  it('модели вызовов из config/models.json: ответ, проверка и оценка интереса на Sonnet', async () => {
    const { model } = await run({
      replies: [{ outcome: 'hot', text: HOT_TEXT }],
      interests: READY,
    });

    expect(model.requests.map(({ purpose, model: id }) => [purpose, id])).toEqual([
      ['interest', 'claude-sonnet-5-5'],
      ['reply', 'claude-sonnet-5-5'],
      ['review', 'claude-sonnet-5-5'],
    ]);
  });

  it('исход hot без текста в финале: фраза о решении и ориентире, проверки вторым вызовом нет', async () => {
    const { verdict, model } = await run({ replies: [{ outcome: 'hot' }], interests: READY });

    expect(verdict).toEqual({
      kind: 'handoff',
      notice: { reason: 'hot' },
      text: 'Я уточню у коллеги решение и ориентир под вашу задачу.' as ReviewedText,
      detail: expect.stringMatching(/^Всё для расчёта известно/) as unknown,
    });
    expect(model.purposes()).toEqual(['interest', 'reply']);
  });

  it('исход hot без текста после вопроса цены: aboutPrice из ответа модели доходит до повода передачи', async () => {
    // Минимум собран (оценка интереса этого хода): передача по цене разрешена.
    const { verdict } = await run({
      replies: [{ outcome: 'hot', aboutPrice: true }],
      interests: [
        {
          profile: {
            scope: 'ввоз и вывоз',
            itemCount: 'около 3000',
            has1C: true,
            problemAgreed: true,
            items: 'запчасти',
            packaging: null,
            material: 'металл',
            city: 'Алматы',
            premises: 'склад',
            turnover: null,
            currentTracking: null,
            monthlyIntake: null,
            passages: null,
            shelfRecount: null,
            inferred: [],
          },
          priceAsked: true,
        },
      ],
    });

    expect(verdict).toStrictEqual({
      kind: 'handoff',
      notice: { reason: 'hot', aboutPrice: true },
      detail: 'Спрашивает цену, сроки или договор, задача понятна. Клиент: «Сколько стоит?»',
    });
  });

  it('модель отметила вопрос цены, но исход no_answer: обычная фраза без пометки', async () => {
    const { verdict } = await run({ replies: [{ outcome: 'no_answer', aboutPrice: true }] });

    expect(verdict).toStrictEqual({
      kind: 'handoff',
      notice: { reason: 'no_answer' },
      detail: 'Ответа нет в документах. Клиент: «Сколько стоит?»',
    });
  });

  it('проверка не пропустила сообщение передачи дважды: та же причина и фиксированная фраза', async () => {
    const { verdict, model } = await run({
      replies: [
        { outcome: 'asked_human', text: HOT_TEXT },
        { outcome: 'asked_human', text: HOT_TEXT },
      ],
      problems: ['Назван срок'],
    });

    expect(verdict).toEqual({
      kind: 'handoff',
      notice: { reason: 'asked_human' },
      detail: 'Просит живого человека. Клиент: «Сколько стоит?»',
    });
    expect(model.purposes()).toEqual(['interest', 'reply', 'review', 'reply', 'review']);
  });

  it('нарушение кода: ревью не зовётся, замечание кода уходит модели во втором запросе', async () => {
    const { verdict, model } = await run({
      replies: ['Учёт — это просто. Что вы храните?', SECOND],
    });

    expect(verdict).toEqual({
      kind: 'send',
      text: SECOND as ReviewedText,
      marks: { stage: 'details', usedFacts: [] },
    });
    expect(model.purposes()).toEqual(['interest', 'reply', 'reply', 'review']);
    expect(model.requests[2]?.turns.at(-1)?.text).toContain('тире');
  });
});
