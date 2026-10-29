import { describe, expect, it, vi } from 'vitest';
import type { ConversationContext } from '../../../src/agent/agent.js';
import type { CompanyPrompt } from '../../../src/domain/company.js';
import type { Logger } from '../../../src/domain/ports.js';
import type {
  ChatId,
  ChatProgress,
  ClientProfile,
  InterestAssessment,
  LlmResult,
  ReplyDraft,
  ReviewedText,
  TurnSignals,
} from '../../../src/domain/types.js';
import { safeQuestion } from '../../../src/pipeline/safe-questions.js';
import { minimumFallback, priceSituation } from '../../../src/pipeline/price-gate.js';
import {
  decideReply,
  requestDraft,
  type ReplyFlowDeps,
  type ReplyVerdict,
} from '../../../src/pipeline/reply-flow.js';

// Правило минимума перед передачей по цене (решение владельца 29.10.2026) в коде: исход hot из-за вопроса цены, пока
// минимума нет, чат не передаёт. Исключения: четвёртый вопрос цены, отказ отвечать; просьба о человеке и жалоба это
// другие исходы. Агент поддельный, проверки кодом настоящие.

const NOW = Date.UTC(2026, 9, 28, 9, 0, 0);
const CHAT_ID = 1 as ChatId;
const CLIENT_28_10 =
  'У нас склад 5000 квадратов, хотим учитывать ввоз и вывоз товара. Вы интегрируетесь с нашей 1С? И сколько это стоит?';
const HOT_PRICE_TEXT =
  'Да, мы проводим интеграцию с вашей 1С. Цена сильно зависит от объёма. Уточню у коллеги и вернусь к вам.';
const MINIMUM_ANSWER =
  'Да, мы проводим интеграцию с вашей 1С. Ориентир коллега назовёт, когда поймём ваш объект. Какие вещи нужно учитывать?';

const EMPTY: ClientProfile = {
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
  inferred: [],
};

/**
 * Что оценка интереса узнала из сообщения 28.10: склад, ввоз и вывоз, 1С есть; вещей, материала, числа вещей, города
 * и компании нет.
 */
const PROFILE_28_10: ClientProfile = {
  ...EMPTY,
  business: 'склад',
  area: '5000 м²',
  scope: 'ввоз и вывоз',
  has1C: true,
  problemAgreed: true,
  items: null,
  packaging: null,
  material: null,
  city: null,
  premises: 'склад',
  turnover: null,
  currentTracking: null,
  inferred: [],
};

const FULL: ClientProfile = {
  ...PROFILE_28_10,
  items: 'запчасти',
  material: 'металл',
  itemCount: 'около 3000',
  city: 'Алматы',
};

const PRICE_NOW: TurnSignals = { priceAsked: true, refused: false };

interface Case {
  readonly drafts: readonly LlmResult<ReplyDraft>[];
  readonly profile?: ClientProfile;
  readonly signals?: TurnSignals;
  /** Сбой оценки интереса вместо ответа. */
  readonly assessmentFails?: boolean;
  readonly progress?: ChatProgress;
  readonly company?: CompanyPrompt;
  readonly companyName?: string | null;
  readonly problems?: readonly string[];
}

function hot(text: string = HOT_PRICE_TEXT, aboutPrice = true): LlmResult<ReplyDraft> {
  return { ok: true, value: { outcome: 'hot', text, ...(aboutPrice ? { aboutPrice } : {}) } };
}

function answer(text: string = MINIMUM_ANSWER, aboutPrice = false): LlmResult<ReplyDraft> {
  return { ok: true, value: { outcome: 'answer', text, ...(aboutPrice ? { aboutPrice } : {}) } };
}

/** Модель ответила answer и задала ещё один вопрос, хотя клиент отказался отвечать. */
const ANOTHER_QUESTION = 'Понимаю. А сколько примерно вещей нужно учитывать?';
const HOT_PRICE_VERDICT = { kind: 'handoff', notice: { reason: 'hot', aboutPrice: true } };

function setup(c: Case) {
  const calls: string[] = [];
  const logs: { level: string; context: unknown }[] = [];
  const drafts = [...c.drafts];
  const log =
    (level: string) =>
    (context: Readonly<Record<string, unknown>>): void => {
      logs.push({ level, context });
    };
  const logger: Logger = {
    level: 'info',
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    fatal: log('fatal'),
    silent: log('silent'),
    child: () => logger,
  };
  const assessment: LlmResult<InterestAssessment> =
    c.assessmentFails === true
      ? { ok: false, failure: 'unavailable' }
      : {
          ok: true,
          value: {
            level: 'warm',
            profile: c.profile ?? PROFILE_28_10,
            reason: 'по разговору',
            signals: c.signals ?? PRICE_NOW,
          },
        };
  const draftReply = vi.fn<ReplyFlowDeps['agent']['draftReply']>((_context, feedback) => {
    calls.push(feedback === undefined ? 'draft' : 'draft:retry');
    const next = drafts.length > 1 ? drafts.shift() : drafts[0];
    return Promise.resolve(next ?? answer());
  });
  const deps: ReplyFlowDeps = {
    chats: { saveAssessment: () => calls.push('save') },
    agent: {
      draftReply,
      reviewDraft: () => {
        calls.push('review');
        const problems = c.problems ?? [];
        return Promise.resolve({
          ok: true,
          value: problems.length === 0 ? { ok: true } : { ok: false, problems },
        });
      },
      assessInterest: () => {
        calls.push('assess');
        return Promise.resolve(assessment);
      },
    },
    clock: { now: () => NOW },
    logger,
  };
  const context: ConversationContext = {
    chatId: CHAT_ID,
    history: [
      { id: 1, chatId: CHAT_ID, author: 'client', kind: 'text', text: CLIENT_28_10, tsMs: NOW },
    ],
    profile: EMPTY,
    ...(c.progress === undefined ? {} : { progress: c.progress }),
    ...(c.company === undefined ? {} : { company: c.company }),
    ...(c.companyName === undefined ? {} : { companyName: c.companyName }),
  };
  return { calls, logs, draftReply, deps, context };
}

async function run(c: Case) {
  const h = setup(c);
  const drafted = await requestDraft(h.deps, h.context);
  const verdict = await decideReply(h.deps, h.context, drafted);
  return { ...h, verdict };
}

function sentWith(text: string, extra: Partial<Extract<ReplyVerdict, { kind: 'send' }>> = {}) {
  return { kind: 'send', text: text as ReviewedText, ...extra };
}

describe('pipeline/reply-flow: передача по цене без минимума', () => {
  it('диалог 28.10: hot из-за цены без числа вещей не передаёт чат, повтор с замечанием, уходит вопрос', async () => {
    const r = await run({ drafts: [hot(), answer()] });

    expect(r.verdict).toEqual(sentWith(MINIMUM_ANSWER, { signals: PRICE_NOW }));
    // Текст hot не проверяется: он не уйдёт. Проверяется только повтор.
    expect(r.calls).toEqual(['draft', 'assess', 'save', 'draft:retry', 'review']);
    const feedback = r.draftReply.mock.calls[1]?.[1] ?? [];
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toMatch(/Передавать чат рано/);
    expect(feedback[0]).toMatch(/не хватает: какие вещи, материал, примерное число вещей, город\./);
    expect(feedback[0]).toMatch(
      /задай одним блоком вопросы первой группы недостающего: какие вещи клиент хочет учитывать, из какого материала вещи/,
    );
    expect(feedback[0]).toContain('напиши «Ориентир коллега назовёт, когда поймём ваш объект.»');
    expect(feedback[0]).not.toMatch(/чтобы коллега сразу назвал ориентир/);
  });

  it('в лог только ID чата, попытка, коды недостающего и число вопросов цены', async () => {
    const r = await run({ drafts: [hot(), answer()] });

    expect(r.logs).toContainEqual({
      level: 'info',
      context: {
        chatId: CHAT_ID,
        attempt: 1,
        missing: ['items', 'material', 'itemCount', 'city'],
        priceAsks: 1,
      },
    });
    expect(JSON.stringify(r.logs)).not.toContain('склад');
  });

  it('вопрос цены видит только оценка интереса (модель aboutPrice не вернула): всё равно рано', async () => {
    const r = await run({ drafts: [hot(HOT_PRICE_TEXT, false), answer()] });

    expect(r.verdict).toMatchObject({ kind: 'send' });
  });

  it('оценка интереса не получилась: решает aboutPrice модели и выжимка до этого сообщения', async () => {
    const r = await run({ drafts: [hot(), answer()], assessmentFails: true });

    expect(r.verdict).toEqual(sentWith(MINIMUM_ANSWER, { signals: PRICE_NOW }));
  });

  it('повтор снова hot: уходит фиксированный вопрос о первом недостающем, чат у бота', async () => {
    const r = await run({ drafts: [hot(), hot()] });

    expect(r.verdict).toEqual(sentWith(safeQuestion('items', true), { signals: PRICE_NOW }));
    expect(r.calls).toEqual(['draft', 'assess', 'save', 'draft:retry']);
  });

  it('повтор не получился (сбой LLM): тот же фиксированный вопрос, а не передача', async () => {
    const r = await run({ drafts: [hot(), { ok: false, failure: 'unavailable' }] });

    expect(r.verdict).toEqual(sentWith(safeQuestion('items', true), { signals: PRICE_NOW }));
  });

  it('ответ повтора не прошёл проверку: фиксированный вопрос вместо check_failed', async () => {
    const r = await run({ drafts: [hot(), answer()], problems: ['Назван срок'] });

    expect(r.verdict).toEqual(sentWith(safeQuestion('items', true), { signals: PRICE_NOW }));
  });

  it('не хватает только компании: фиксированный вопрос о названии отмечает вопрос о компании', async () => {
    const r = await run({
      drafts: [hot(), hot()],
      profile: FULL,
      company: { kind: 'unknown', askName: true },
    });

    expect(r.verdict).toEqual(
      sentWith(safeQuestion('company', true), { companyQuestion: 'name', signals: PRICE_NOW }),
    );
  });
});

describe('pipeline/reply-flow: когда передача по цене разрешена', () => {
  it('минимум собран (название компании со слов клиента): hot передаёт чат с текстом модели', async () => {
    const r = await run({
      drafts: [hot()],
      profile: FULL,
      company: { kind: 'searching' },
      companyName: 'ТОО Склад',
    });

    expect(r.verdict).toMatchObject({ kind: 'handoff', notice: { reason: 'hot' } });
    expect(r.calls).toEqual(['draft', 'assess', 'save', 'review', 'save']);
  });

  it('компанию спросить нельзя (определение выключено): остальной минимум собран, hot передаёт', async () => {
    const r = await run({ drafts: [hot()], profile: FULL, company: { kind: 'off' } });

    expect(r.verdict).toMatchObject({ kind: 'handoff', notice: { reason: 'hot' } });
  });

  it('третий вопрос цены без минимума: ещё рано (решение 29.10.2026, второй круг)', async () => {
    const r = await run({ drafts: [hot(), answer()], progress: { priceAsks: 2, refused: false } });

    expect(r.verdict).toEqual(sentWith(MINIMUM_ANSWER, { signals: PRICE_NOW }));
  });

  it('четвёртый вопрос цены: hot передаёт без минимума', async () => {
    const r = await run({ drafts: [hot()], progress: { priceAsks: 3, refused: false } });

    expect(r.verdict).toMatchObject({ kind: 'handoff', notice: { reason: 'hot' } });
  });

  it('второй вопрос цены без минимума: ещё рано', async () => {
    const r = await run({ drafts: [hot(), answer()], progress: { priceAsks: 1, refused: false } });

    expect(r.verdict).toEqual(sentWith(MINIMUM_ANSWER, { signals: PRICE_NOW }));
  });

  it('четвёртый вопрос цены, а модель ответила answer: передача hot с фразой о цене, без проверки текста', async () => {
    const r = await run({ drafts: [answer()], progress: { priceAsks: 3, refused: false } });

    expect(r.verdict).toEqual({ kind: 'handoff', notice: { reason: 'hot', aboutPrice: true } });
    expect(r.calls).toEqual(['draft', 'assess', 'save', 'save']);
  });

  it.each<[string, Case]>([
    ['отказ в этом сообщении', { drafts: [hot()], signals: { priceAsked: true, refused: true } }],
    ['отказ раньше', { drafts: [hot()], progress: { priceAsks: 1, refused: true } }],
  ])('%s: hot передаёт без минимума', async (_name, c) => {
    const r = await run(c);

    expect(r.verdict).toMatchObject({ kind: 'handoff', notice: { reason: 'hot' } });
  });

  it('hot без вопроса цены (сроки или договор): правило цены не мешает', async () => {
    const r = await run({
      drafts: [hot('Сроки подбираем под задачу. Уточню у коллеги и вернусь к вам.', false)],
      signals: { priceAsked: false, refused: false },
    });

    expect(r.verdict).toMatchObject({ kind: 'handoff', notice: { reason: 'hot' } });
  });

  it.each<[string, LlmResult<ReplyDraft>]>([
    ['просьба о человеке', { ok: true, value: { outcome: 'asked_human', text: '' } }],
    ['жалоба', { ok: true, value: { outcome: 'complaint', stopRequested: false } }],
  ])('%s без минимума: передача сразу', async (_name, draft) => {
    const r = await run({ drafts: [draft] });

    expect(r.verdict).toMatchObject({ kind: 'handoff' });
    expect(r.calls).not.toContain('draft:retry');
  });
});

describe('pipeline/reply-flow: отказ отвечать передаёт чат кодом (ревью 29.10.2026)', () => {
  it('отказ и вопрос цены сейчас, а модель ответила answer с новым вопросом: передача hot с фразой о цене', async () => {
    const r = await run({
      drafts: [answer(ANOTHER_QUESTION)],
      signals: { priceAsked: true, refused: true },
    });

    expect(r.verdict).toEqual(HOT_PRICE_VERDICT);
    // Текст answer не проверяется: он не уйдёт.
    expect(r.calls).toEqual(['draft', 'assess', 'save', 'save']);
    expect(r.logs).toContainEqual({ level: 'info', context: { chatId: CHAT_ID, priceAsks: 1 } });
  });

  it('отказ сейчас, а цену клиент спрашивал раньше: передача hot с фразой о цене', async () => {
    const r = await run({
      drafts: [answer(ANOTHER_QUESTION)],
      signals: { priceAsked: false, refused: true },
      progress: { priceAsks: 1, refused: false },
    });

    expect(r.verdict).toEqual(HOT_PRICE_VERDICT);
  });

  it('отказ без вопроса цены ни сейчас, ни раньше: ответ уходит, чат у бота', async () => {
    const r = await run({
      drafts: [answer(ANOTHER_QUESTION)],
      signals: { priceAsked: false, refused: true },
    });

    expect(r.verdict).toMatchObject({ kind: 'send' });
  });

  it('отказ был раньше, а сейчас нет: answer не передаёт чат', async () => {
    const r = await run({
      drafts: [answer(ANOTHER_QUESTION)],
      signals: { priceAsked: false, refused: false },
      progress: { priceAsks: 1, refused: true },
    });

    expect(r.verdict).toMatchObject({ kind: 'send' });
  });
});

describe('pipeline/reply-flow: aboutPrice у answer как запасной сигнал (ревью 29.10.2026)', () => {
  it('оценка не получилась, answer с aboutPrice: вопрос цены засчитывается после ответа', async () => {
    const r = await run({ drafts: [answer(MINIMUM_ANSWER, true)], assessmentFails: true });

    expect(r.verdict).toEqual(sentWith(MINIMUM_ANSWER, { signals: PRICE_NOW }));
  });

  it('оценка не получилась, три вопроса цены уже было, answer с aboutPrice: четвёртый, передача', async () => {
    const r = await run({
      drafts: [answer(MINIMUM_ANSWER, true)],
      assessmentFails: true,
      progress: { priceAsks: 3, refused: false },
    });

    expect(r.verdict).toEqual(HOT_PRICE_VERDICT);
  });

  it('оценка есть и говорит, что цену не спрашивали: aboutPrice ответа не засчитывается', async () => {
    const r = await run({
      drafts: [answer('Учёт подбираем под задачу. Что вы храните?', true)],
      signals: { priceAsked: false, refused: false },
      progress: { priceAsks: 2, refused: false },
    });

    expect(r.verdict).toEqual(sentWith('Учёт подбираем под задачу. Что вы храните?'));
  });
});

describe('pipeline/reply-flow: что записать после ответа', () => {
  it('ответ без вопроса цены и отказа: сигналов в вердикте нет', async () => {
    const r = await run({
      drafts: [answer('Учёт подбираем под задачу. Что вы храните?')],
      signals: { priceAsked: false, refused: false },
    });

    expect(r.verdict).toEqual(sentWith('Учёт подбираем под задачу. Что вы храните?'));
  });

  it('отказ отвечать без вопроса цены записывается', async () => {
    const r = await run({
      drafts: [answer('Хорошо, понимаю. Что вы храните?')],
      signals: { priceAsked: false, refused: true },
    });

    expect(r.verdict).toEqual(
      sentWith('Хорошо, понимаю. Что вы храните?', {
        signals: { priceAsked: false, refused: true },
      }),
    );
  });
});

describe('pipeline/price-gate: защитные ветки', () => {
  it('минимум собран, а фиксированный вопрос всё же нужен: вопрос о вещах', () => {
    const situation = priceSituation(
      { chatId: CHAT_ID, history: [], profile: FULL, companyName: 'ТОО Склад' },
      null,
      answer(),
    );

    expect(situation.minimum.missing).toEqual([]);
    expect(minimumFallback(situation).text).toBe(safeQuestion('items', true));
  });
});

describe('pipeline/reply-flow: указание коллеги в проверках кодом', () => {
  const NOTE_TEXT = 'Ориентир от 1 500 000 тенге, нужен выезд';
  const WITH_PRICE =
    'Коллега подсказал ориентир: от 1 500 000 тенге. Точнее скажем после выезда к вам.';

  async function runWith(note: string | null, drafts: readonly LlmResult<ReplyDraft>[]) {
    const h = setup({ drafts, signals: PRICE_NOW, profile: FULL, companyName: 'ТОО Склад' });
    const context: ConversationContext = {
      ...h.context,
      note: note === null ? null : { text: note, atMs: NOW },
    };
    const drafted = await requestDraft(h.deps, context);
    return { ...h, verdict: await decideReply(h.deps, context, drafted) };
  }

  it('заметка с ценой: цена ровно как в заметке проходит проверки и уходит', async () => {
    const r = await runWith(NOTE_TEXT, [answer(WITH_PRICE)]);

    expect(r.verdict).toEqual(sentWith(WITH_PRICE, { signals: PRICE_NOW }));
    expect(r.calls).toEqual(['draft', 'assess', 'save', 'review']);
  });

  it('цена не как в заметке: повтор с замечанием сверить с указанием', async () => {
    const r = await runWith(NOTE_TEXT, [
      answer('Коллега подсказал ориентир: от 1 млн тенге. Точнее скажем после выезда.'),
      answer(WITH_PRICE),
    ]);

    expect(r.verdict).toEqual(sentWith(WITH_PRICE, { signals: PRICE_NOW }));
    expect(r.draftReply.mock.calls[1]?.[1]?.join(' ')).toContain('цена не как в указании коллеги');
  });

  it.each<[string, Partial<Case>]>([
    ['отказ отвечать и вопрос цены', { signals: { priceAsked: true, refused: true } }],
    ['четвёртый вопрос цены', { progress: { priceAsks: 3, refused: false } }],
  ])(
    '%s при заметке с ценой: чат не передаётся, уходит ответ с суммой из заметки (ревью, второй круг)',
    async (_name, extra) => {
      const h = setup({ drafts: [answer(WITH_PRICE)], signals: PRICE_NOW, ...extra });
      const context: ConversationContext = { ...h.context, note: { text: NOTE_TEXT, atMs: NOW } };
      const drafted = await requestDraft(h.deps, context);

      const verdict = await decideReply(h.deps, context, drafted);

      expect(verdict).toMatchObject({ kind: 'send', text: WITH_PRICE });
    },
  );

  it('отказ отвечать при заметке-задании без суммы: передача кодом, как без заметки', async () => {
    const h = setup({
      drafts: [answer('Понимаю. А сколько примерно вещей нужно учитывать?')],
      signals: { priceAsked: true, refused: true },
    });
    const context: ConversationContext = {
      ...h.context,
      note: { text: 'Узнай число вещей и какая 1С', atMs: NOW },
    };
    const drafted = await requestDraft(h.deps, context);

    const verdict = await decideReply(h.deps, context, drafted);

    expect(verdict).toEqual({ kind: 'handoff', notice: { reason: 'hot', aboutPrice: true } });
  });

  it('без заметки бот цену не называет: та же цена нарушение, повтор', async () => {
    const r = await runWith(null, [answer(WITH_PRICE), answer(MINIMUM_ANSWER)]);

    expect(r.verdict).toEqual(sentWith(MINIMUM_ANSWER, { signals: PRICE_NOW }));
    expect(r.draftReply.mock.calls[1]?.[1]?.join(' ')).toMatch(/цена: /);
  });
});

describe('pipeline/reply-flow: ранняя передача при заметке с ориентиром', () => {
  it('замечание повтору напоминает ответить ориентиром из указания коллеги', async () => {
    const h = setup({ drafts: [hot(), answer()] });
    const context: ConversationContext = {
      ...h.context,
      note: { text: 'Ориентир от 1 500 000 тенге', atMs: NOW },
    };
    const drafted = await requestDraft(h.deps, context);

    await decideReply(h.deps, context, drafted);

    expect(h.draftReply.mock.calls[1]?.[1]?.[0]).toMatch(
      /Если в указании коллеги есть ориентир цены, ответь им ровно как там написано/,
    );
  });

  it('без заметки этой строки в замечании нет', async () => {
    const r = await run({ drafts: [hot(), answer()] });

    expect(r.draftReply.mock.calls[1]?.[1]?.[0]).not.toMatch(/указании коллеги/);
  });
});

describe('pipeline/price-gate: фиксированный вопрос не повторяет прошлый вопрос бота', () => {
  it('прошлым сообщением бот спросил о вещах: вопрос о следующем недостающем', () => {
    const situation = priceSituation({ chatId: CHAT_ID, history: [], profile: EMPTY }, null, hot());

    expect(minimumFallback(situation, 'Подскажите, какие вещи нужно учитывать?').text).toBe(
      safeQuestion('material', true),
    );
  });

  it('недостающее только то, о чём уже спросили: вопрос повторяется, а не передача', () => {
    const situation = priceSituation(
      { chatId: CHAT_ID, history: [], profile: { ...FULL, city: null } },
      null,
      hot(),
    );

    expect(minimumFallback(situation, safeQuestion('city', true)).text).toBe(
      safeQuestion('city', true),
    );
  });
});
