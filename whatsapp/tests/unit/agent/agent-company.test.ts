import { readFileSync } from 'node:fs';
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
  SILENT_LOGGER,
} from './fakes.js';
import { createFakeLogger, type LogEntry } from '../llm/fakes.js';

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
    agent: createAgent({ llm, knowledge: KNOWLEDGE, models: MODELS, logger: SILENT_LOGGER }),
  };
}

function lastTurn(requests: Parameters<typeof onlyRequest>[0]): string {
  return onlyRequest(requests).turns.at(-1)?.text ?? '';
}

describe('draftReply: компания клиента', () => {
  it('блок о компании идёт в данных вызова после выжимки', async () => {
    const { requests, agent } = agentWith({
      ok: true,
      value: { outcome: 'answer', text: 'Вы из компании Альфа, правильно?', stopRequested: false },
    });

    await agent.draftReply(
      context({ profile: { ...EMPTY_PROFILE, area: '300 м2' }, company: CANDIDATE }),
    );

    const data = lastTurn(requests);
    expect(data.indexOf('Площадь: 300 м2')).toBeLessThan(data.indexOf('«Альфа» (Алматы)'));
    expect(data).toContain('«Вы из компании Альфа, правильно?»');
  });

  it('функция выключена: данных о компании нет, без выжимки и замечаний данных нет совсем', async () => {
    const { requests, agent } = agentWith({
      ok: true,
      value: { outcome: 'answer', text: 'Добрый день.', stopRequested: false },
    });

    await agent.draftReply(context({ company: { kind: 'off' } }));

    expect(lastTurn(requests)).not.toContain('<данные>');
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

describe('draftReply и reviewDraft: боли справки только из раздела 5 документа владельца', () => {
  const OWNER = [
    '# Tanbala: что должен знать агент',
    '',
    '## 4. Что можно учитывать',
    '',
    '- склад, где пересорт при отгрузке;',
    '',
    '## 5. Какие задачи решаем',
    '',
    'Клиент приходит не за технологией, а с проблемой. Типичные:',
    '',
    '- вещи теряются, и никто не знает, где они (например, инструмент между сменами);',
    '- инвентаризация занимает дни и отрывает людей от работы;',
    '- всё считают вручную или сканируют штрихкоды по одному;',
    '- тара уходит к партнёрам и не возвращается.',
    '',
    'Что меняется (говори только это, без цифр):',
    '',
    '- ридер видит сотни меток за секунду, не нужно искать код на каждой вещи;',
    '',
    '## 6. Как это работает простыми словами',
  ].join('\r\n');

  const ANSWER: LlmResult<unknown> = {
    ok: true,
    value: { outcome: 'answer', text: 'Добрый день.', stopRequested: false },
  };

  function confirmed(pains: readonly string[]): CompanyPrompt {
    return { kind: 'confirmed', name: 'Альфа', rubric: 'Склады', pains, emailed: false };
  }

  function ownerAgent(answer: LlmResult<unknown>, owner = OWNER) {
    const { requests, llm } = fakeLlm(answer);
    const logs: LogEntry[] = [];
    const knowledge = { ...KNOWLEDGE, owner };
    const agent = createAgent({ llm, knowledge, models: MODELS, logger: createFakeLogger(logs) });
    return { requests, agent, logs };
  }

  /** Строка о трудностях в данных вызова ответа; нет строки => null. */
  async function painsLine(pains: readonly string[], owner = OWNER): Promise<string | null> {
    const { requests, agent } = ownerAgent(ANSWER, owner);
    await agent.draftReply(context({ company: confirmed(pains) }));
    const line = lastTurn(requests)
      .split('\n')
      .find((item) => item.startsWith('Трудности'));
    return line ?? null;
  }

  it('пункт списка совпадает целиком: без учёта регистра, пробелов по краям, «;» и «.» на конце', async () => {
    const pains = [
      ' Инвентаризация занимает дни и отрывает людей от работы ',
      'ВСЁ СЧИТАЮТ ВРУЧНУЮ ИЛИ СКАНИРУЮТ ШТРИХКОДЫ ПО ОДНОМУ;',
      'тара уходит к партнёрам и не возвращается',
    ];

    const line = await painsLine(pains);

    expect(line).toContain('Инвентаризация занимает дни и отрывает людей от работы');
    expect(line).toContain('ВСЁ СЧИТАЮТ ВРУЧНУЮ ИЛИ СКАНИРУЮТ ШТРИХКОДЫ ПО ОДНОМУ');
    expect(line).toContain('тара уходит к партнёрам и не возвращается');
  });

  it('пункт с пояснением в скобках: совпадает и целиком, и начало до скобки', async () => {
    const full = 'вещи теряются, и никто не знает, где они (например, инструмент между сменами)';
    const head = 'Вещи теряются, и никто не знает, где они.';

    expect(await painsLine([full])).toContain(full);
    expect(await painsLine([head])).toContain(head);
  });

  it.each([
    ['часть пункта', 'инвентаризация занимает дни'],
    ['слово из раздела', 'инвентаризация'],
    ['начало пункта без скобок', 'тара уходит к партнёрам'],
    ['пункт другого раздела', 'склад, где пересорт при отгрузке'],
    [
      'пункт списка «Что меняется»',
      'ридер видит сотни меток за секунду, не нужно искать код на каждой вещи',
    ],
    ['текст абзаца раздела', 'Клиент приходит не за технологией, а с проблемой'],
    ['пункт с лишним в конце', 'инвентаризация занимает дни и отрывает людей от работы, и много'],
    ['пустая строка', '   '],
    ['одни знаки', ';.'],
    ['скобка без начала', '(например, инструмент между сменами)'],
  ])('%s: боль модели не передаётся', async (_case, pain) => {
    expect(await painsLine([pain])).toBeNull();
  });

  it('вызов проверки: те же боли, что у ответа', async () => {
    const { requests, agent } = ownerAgent({ ok: true, value: { ok: true, problems: [] } });
    const company = confirmed(['тара уходит к партнёрам и не возвращается', 'выдуманная боль']);

    await agent.reviewDraft(context({ company }), 'Добрый день.');

    const data = lastTurn(requests);
    expect(data).toContain('тара уходит к партнёрам и не возвращается');
    expect(data).not.toContain('выдуманная боль');
  });

  it('ни одной боли из списка: строки о трудностях нет, рубрика остаётся, блок в контексте не меняется', async () => {
    const { requests, agent } = ownerAgent(ANSWER);
    const company = confirmed(['Выдуманная боль']);
    const ctx = context({ company });

    await agent.draftReply(ctx);

    const data = lastTurn(requests);
    expect(data).toContain('Рубрика: Склады.');
    expect(data).not.toContain('Трудности');
    expect(ctx.company).toBe(company);
  });

  it('раздел найден: в лог при создании агента ничего', () => {
    const { logs } = ownerAgent(ANSWER);

    expect(logs).toEqual([]);
  });

  it.each([
    ['раздела нет', OWNER.replace('## 5. Какие задачи решаем', '## 5. Что болит у клиентов')],
    ['в разделе нет списка', OWNER.replace(/\r\n- (?:вещи|инвентаризация|всё|тара)[^\r]*/gu, '')],
    ['пустой документ', ''],
  ])('%s: боли не передаются, при создании агента одно предупреждение', async (_case, owner) => {
    const { logs } = ownerAgent(ANSWER, owner);

    expect(logs).toEqual([expect.objectContaining({ level: 'warn', context: {} })]);
    expect(logs[0]?.message).toContain('Раздел 5');
    expect(await painsLine(['тара уходит к партнёрам и не возвращается'], owner)).toBeNull();
  });

  it('раздел 5 последний и список до конца документа: пункты проходят, предупреждения нет', async () => {
    const owner = '## 5. Какие задачи решаем\n- тара уходит к партнёрам и не возвращается.';
    const { logs } = ownerAgent(ANSWER, owner);

    expect(logs).toEqual([]);
    expect(await painsLine(['Тара уходит к партнёрам и не возвращается'], owner)).toContain(
      'Тара уходит к партнёрам',
    );
  });

  it('документ владельца из knowledge: все девять пунктов раздела 5 проходят, со знаком на конце и без', async () => {
    const owner = readFileSync(
      new URL('../../../knowledge/tanbala-agent.md', import.meta.url),
      'utf8',
    );
    const items = sectionFiveItems(owner);
    const bare = items.map((item) => item.replace(/[;.]$/u, ''));

    const withSigns = await painsLine(items, owner);
    const withoutSigns = await painsLine(bare, owner);

    expect(items).toHaveLength(9);
    for (const pain of bare) {
      expect(withSigns).toContain(pain);
      expect(withoutSigns).toContain(pain);
    }
  });
});

/** Пункты списка между заголовком раздела 5 и «Что меняется»: разбор теста, независимый от агента. */
function sectionFiveItems(owner: string): string[] {
  const section = owner.split('## 5. Какие задачи решаем')[1]?.split('Что меняется')[0] ?? '';
  return section
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());
}

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
      answer: 'yes',
      pains: ['теряется инструмент', 'долгий пересчёт', 'партии'],
    });
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
