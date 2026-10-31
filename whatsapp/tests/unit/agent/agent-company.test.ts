import { describe, expect, it } from 'vitest';
import { createAgent } from '../../../src/agent/agent.js';
import { normalizeInterest, type RawInterest } from '../../../src/agent/interest.js';
import type { CompanyPrompt } from '../../../src/domain/company.js';
import type { ImageInput } from '../../../src/domain/ports.js';
import type { LlmResult } from '../../../src/domain/types.js';
import {
  CHAT_ID,
  context,
  EMPTY_PROFILE,
  fakeLlm,
  KNOWLEDGE,
  MODELS,
  onlyRequest,
} from './fakes.js';

const CANDIDATE: CompanyPrompt = {
  kind: 'candidate',
  name: 'Альфа',
  city: 'Алматы',
  withCity: false,
};

const RAW: RawInterest = {
  level: 'warm',
  business: null,
  area: null,
  scope: null,
  itemCount: null,
  has1C: null,
  problem: null,
  specifics: null,
  reason: 'Рассказал о задаче',
};

const PHOTO: ImageInput = { data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' };

function agentWith(answer: LlmResult<unknown>) {
  const { requests, llm } = fakeLlm(answer);
  return {
    requests,
    agent: createAgent({ llm, knowledge: KNOWLEDGE, models: MODELS }),
  };
}

function lastTurn(requests: Parameters<typeof onlyRequest>[0]): string {
  return onlyRequest(requests).turns.at(-1)?.text ?? '';
}

describe('draftReply: компания клиента', () => {
  it('блок о компании идёт в данных вызова раньше выжимки: строки системы раньше слов клиента', async () => {
    const { requests, agent } = agentWith({
      ok: true,
      value: { outcome: 'answer', text: 'Вы из компании Альфа, правильно?', stopRequested: false },
    });

    await agent.draftReply(
      context({ profile: { ...EMPTY_PROFILE, area: '300 м2' }, company: CANDIDATE }),
    );

    const data = lastTurn(requests);
    expect(data.indexOf('«Альфа» (Алматы)')).toBeLessThan(data.indexOf('Площадь: 300 м2'));
    expect(data).toContain('«Вы из компании Альфа, правильно?»');
  });

  it('функция выключена: данных о компании нет, без выжимки и замечаний в данных только строки об этапе', async () => {
    const { requests, agent } = agentWith({
      ok: true,
      value: { outcome: 'answer', text: 'Добрый день.', stopRequested: false },
    });

    await agent.draftReply(context({ company: { kind: 'off' } }));

    expect(lastTurn(requests)).toMatch(/Этап по данным системы/);
    expect(lastTurn(requests)).not.toMatch(/компани/i);
  });

  it.each(['confirm', 'name'] as const)(
    'вопрос о компании %s сохраняется в ответе',
    async (question) => {
      const { agent } = agentWith({
        ok: true,
        value: {
          outcome: 'answer',
          text: 'Из какой вы компании?',
          stopRequested: false,
          companyQuestion: question,
        },
      });

      const result = await agent.draftReply(context());

      expect(result).toEqual({
        ok: true,
        value: { outcome: 'answer', text: 'Из какой вы компании?', companyQuestion: question },
      });
    },
  );

  it('none, мусор и отсутствие поля не сохраняются; у передачи поля нет', async () => {
    for (const companyQuestion of ['none', 'phone', undefined]) {
      const { agent } = agentWith({
        ok: true,
        value: { outcome: 'answer', text: 'Да.', stopRequested: false, companyQuestion },
      });
      expect(await agent.draftReply(context())).toEqual({
        ok: true,
        value: { outcome: 'answer', text: 'Да.' },
      });
    }
    const { agent } = agentWith({
      ok: true,
      value: { outcome: 'hot', text: 'Передал.', stopRequested: false, companyQuestion: 'confirm' },
    });
    expect(await agent.draftReply(context())).toEqual({
      ok: true,
      value: { outcome: 'hot', text: 'Передал.' },
    });
  });
});

describe('reviewDraft и assessInterest: компания клиента', () => {
  it('проверка получает, что допустимо о компании, перед черновиком; черновик последним', async () => {
    const { requests, agent } = agentWith({ ok: true, value: { ok: true, problems: [] } });

    await agent.reviewDraft(context({ company: CANDIDATE }), 'Вы из компании Альфа, правильно?');

    const data = lastTurn(requests);
    expect(data).toContain('из компании ли клиент «Альфа» (Алматы), допустим');
    expect(data.indexOf('допустим')).toBeLessThan(data.indexOf('Черновик ответа клиенту'));
    expect(data.trimEnd().endsWith('Вы из компании Альфа, правильно?\n</данные>')).toBe(true);
  });

  it('проверка без компании: данные как раньше', async () => {
    const { requests, agent } = agentWith({ ok: true, value: { ok: true, problems: [] } });

    await agent.reviewDraft(context(), 'Добрый день.');

    expect(lastTurn(requests)).toContain('<данные>\nЧерновик ответа клиенту');
  });

  it('оценка интереса видит, что бот спросил «Вы из компании X?»', async () => {
    const { requests, agent } = agentWith({ ok: true, value: RAW });

    await agent.assessInterest(
      context({ company: { kind: 'asked', name: 'Альфа', city: null, awaitingAnswer: true } }),
    );

    expect(lastTurn(requests)).toContain(
      'Бот спросил клиента, из компании ли он «Альфа». По сообщениям клиента после этого вопроса определи companyAnswer',
    );
  });

  it('оценка интереса без вопроса: companyAnswer none', async () => {
    const { requests, agent } = agentWith({ ok: true, value: RAW });

    await agent.assessInterest(context({ company: CANDIDATE }));

    expect(lastTurn(requests)).toContain(
      'Бот не ждёт ответа на вопрос «Вы из компании X?»: companyAnswer none.',
    );
  });
});

describe('draftReply и reviewDraft: боли справки (решение владельца 30.10.2026)', () => {
  const ANSWER: LlmResult<unknown> = {
    ok: true,
    value: { outcome: 'answer', text: 'Добрый день.', stopRequested: false },
  };

  /** Боли не из раздела 5 документа владельца: с 30.10.2026 они тоже идут модели. */
  const PAINS = [
    'Пересорт при отгрузке',
    'Инвентаризация занимает дни и отрывает людей от работы',
    'Трудно найти дело в архиве',
  ];

  function confirmed(pains: readonly string[]): CompanyPrompt {
    return {
      kind: 'confirmed',
      name: 'Альфа',
      rubric: 'Склады',
      pains,
      emailed: false,
      emailTold: false,
    };
  }

  function painsLineOf(requests: Parameters<typeof onlyRequest>[0]): string | null {
    return (
      lastTurn(requests)
        .split('\n')
        .find((item) => item.startsWith('Трудности')) ?? null
    );
  }

  it('боли справки идут в блок ответа как есть, до трёх, без фильтра по разделу 5; блок в контексте не меняется', async () => {
    const { requests, agent } = agentWith(ANSWER);
    const company = confirmed(PAINS);
    const ctx = context({ company });

    await agent.draftReply(ctx);

    expect(painsLineOf(requests)).toBe(
      `Трудности, которые часто бывают у похожих компаний: ${PAINS.join('; ')}.`,
    );
    expect(ctx.company).toBe(company);
  });

  it('вызов проверки: те же боли, что у ответа', async () => {
    const { requests, agent } = agentWith({ ok: true, value: { ok: true, problems: [] } });

    await agent.reviewDraft(context({ company: confirmed(PAINS) }), 'Добрый день.');

    expect(painsLineOf(requests)).toBe(
      `Трудности, которые часто бывают у похожих компаний: ${PAINS.join('; ')}.`,
    );
  });

  it('документ владельца без раздела 5: боли всё равно передаются', async () => {
    const { requests, llm } = fakeLlm(ANSWER);
    const knowledge = { ...KNOWLEDGE, owner: '# Tanbala' };
    const agent = createAgent({ llm, knowledge, models: MODELS });

    await agent.draftReply(context({ company: confirmed(PAINS.slice(0, 1)) }));

    expect(painsLineOf(requests)).toContain('Пересорт при отгрузке');
  });
});

describe('normalizeInterest: что клиент сказал о компании', () => {
  it('поля о компании чистятся: пусто => null, боли без пустых и не больше трёх', () => {
    const assessment = normalizeInterest(
      {
        ...RAW,
        companyName: '  ТОО\n«Альфа»  ',
        companyCity: '   ',
        companyAnswer: 'yes',
        confirmedPains: [' теряется инструмент ', '', 'долгий пересчёт', 'партии', 'четвёртая'],
      },
      EMPTY_PROFILE,
    );

    expect(assessment.company).toEqual({
      name: 'ТОО «Альфа»',
      city: null,
      aliases: [],
      answer: 'yes',
      pains: ['теряется инструмент', 'долгий пересчёт', 'партии'],
    });
  });

  it('варианты названия чистятся как название: пустые и повторы (без учёта регистра) убраны, до трёх, до 200 знаков', () => {
    const assessment = normalizeInterest(
      {
        ...RAW,
        companyName: 'Тинькофф',
        companyAliases: [
          ' Т-Банк\t',
          'тинькофф',
          '',
          'т-банк',
          'Tinkoff',
          'В'.repeat(250),
          'Пятый',
        ],
      },
      EMPTY_PROFILE,
    );

    expect(assessment.company?.aliases).toEqual(['Т-Банк', 'Tinkoff', 'В'.repeat(200)]);
  });

  it('клиент компанию не называл: вариантов нет, даже если модель их прислала', () => {
    const assessment = normalizeInterest(
      { ...RAW, companyName: '  ', companyAliases: ['Т-Банк'] },
      EMPTY_PROFILE,
    );

    expect(assessment.company).toMatchObject({ name: null, aliases: [] });
  });

  it('название и город обрезаются по пределам API: 200 и 100 знаков', () => {
    const assessment = normalizeInterest(
      { ...RAW, companyName: 'А'.repeat(250), companyCity: 'Б'.repeat(150) },
      EMPTY_PROFILE,
    );

    expect(assessment.company?.name).toHaveLength(200);
    expect(assessment.company?.city).toHaveLength(100);
    expect(assessment.company?.answer).toBe('none');
    expect(assessment.company?.pains).toEqual([]);
  });

  it('ни одного поля о компании (подделка LLM): company нет', () => {
    expect(normalizeInterest(RAW, EMPTY_PROFILE)).not.toHaveProperty('company');
  });
});

describe('readLogo: название компании с фото профиля', () => {
  it('запрос: вызов logo своей модели, без знаний и истории, фото к единственной реплике user', async () => {
    const { requests, agent } = agentWith({ ok: true, value: { companyName: 'Альфа' } });

    await agent.readLogo(CHAT_ID, PHOTO);

    const request = onlyRequest(requests);
    expect(request.purpose).toBe('logo');
    expect(request.model).toBe(MODELS.logo);
    expect(request.chatId).toBe(CHAT_ID);
    expect(request.image).toBe(PHOTO);
    expect(request.system).toHaveLength(1);
    expect(request.system[0]?.cache).toBe(false);
    expect(request.system[0]?.text).not.toContain(KNOWLEDGE.owner.trim());
    expect(request.turns).toEqual([
      {
        role: 'user',
        text: 'Фото профиля клиента в WhatsApp. Какое название компании на нём видно?',
      },
    ]);
    expect(request.schema.safeParse({ companyName: null }).success).toBe(true);
    expect(request.schema.safeParse({}).success).toBe(false);
  });

  it('название чистится; пустое или null => null', async () => {
    const cases: readonly [unknown, string | null][] = [
      ['  Альфа\nЛогистик ', 'Альфа Логистик'],
      ['   ', null],
      [null, null],
    ];
    for (const [companyName, expected] of cases) {
      const { agent } = agentWith({ ok: true, value: { companyName } });
      expect(await agent.readLogo(CHAT_ID, PHOTO)).toEqual({ ok: true, value: expected });
    }
  });

  it('сбой вызова приходит как есть', async () => {
    const { agent } = agentWith({ ok: false, failure: 'budget_exceeded', scope: 'chat' });

    expect(await agent.readLogo(CHAT_ID, PHOTO)).toEqual({
      ok: false,
      failure: 'budget_exceeded',
      scope: 'chat',
    });
  });
});
