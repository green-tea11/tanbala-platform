import { describe, expect, it, vi } from 'vitest';
import type { ConversationContext } from '../../../src/agent/agent.js';
import { ESTIMATE_LATER } from '../../../src/agent/stage.js';
import { normalizeDraft, runCodeChecks } from '../../../src/checks/code-checks.js';
import type { Logger } from '../../../src/domain/ports.js';
import type {
  ChatId,
  ChatProgress,
  ClientProfile,
  InterestAssessment,
  LlmResult,
  PhoneDigits,
  ReplyDraft,
  ReviewedText,
  StoredMessage,
  TurnSignals,
} from '../../../src/domain/types.js';
import { HANDOFF_TEXT, HOT_PRICE_HANDOFF_TEXT } from '../../../src/messaging/outbox.js';
import {
  decideReply,
  requestDraft,
  type ReplyFlowDeps,
  type ReplyVerdict,
} from '../../../src/pipeline/reply-flow.js';
import { questionText } from '../../../src/pipeline/safe-questions.js';
import { EMPTY_PROFILE } from '../agent/fakes.js';

// Когда код передаёт чат (решение владельца 30.10.2026): а) финал, модель вернула hot и для расчёта известно всё; б) клиент
// спрашивает цену, сроки или договор, а задача понятна; в) третий вопрос цены; г) два ухода от вопросов подряд. Ранний
// hot: один повтор с замечанием, второй провал даёт безопасный вопрос. Агент поддельный, проверки кодом настоящие.

const NOW = Date.UTC(2026, 9, 30, 9, 0, 0);
const CHAT_ID = 1 as ChatId;
const CLIENT_TEXT = 'Запчасти, около 3000 позиций. Сколько это стоит?';

/** Клиент рассказал о задаче, но что на хранении и сколько, неизвестно: задача не понятна. */
const VAGUE: ClientProfile = {
  ...EMPTY_PROFILE,
  business: 'склад',
  has1C: true,
  problemAgreed: true,
};

/** Задача понятна: известно, что на хранении и сколько; для расчёта не хватает нового в месяц, проходов и города. */
const TASK: ClientProfile = { ...VAGUE, items: 'запчасти', itemCount: 'около 3000' };

/** Для расчёта известно всё. */
const READY: ClientProfile = {
  ...TASK,
  monthlyIntake: '200 в месяц',
  passages: 'один вход',
  city: 'Алматы',
};

const FINAL_TEXT = `Склад запчастей в Алматы, около 3000 позиций, 200 новых в месяц, один вход. ${HOT_PRICE_HANDOFF_TEXT}`;
const ANSWER =
  'Интеграцию с вашей 1С делает наш сотрудник. Расскажите, сколько нового товара приходит к вам за месяц?';
const PRICE_ANSWER = `Интеграцию с вашей 1С делает наш сотрудник. ${ESTIMATE_LATER} Расскажите, что у вас лежит на хранении?`;

const PRICE: TurnSignals = { priceAsked: true, refused: false };
const NOTHING: TurnSignals = { priceAsked: false, refused: false };
const REFUSED: TurnSignals = { priceAsked: false, refused: true };

/** Причина своими словами с цитатой клиента (пункт 3 решения владельца 30.10.2026); точные тексты в своём разделе. */
const DETAIL = expect.stringContaining('Клиент: «') as unknown as string;

const PRICE_HANDOFF: ReplyVerdict = {
  kind: 'handoff',
  notice: { reason: 'hot', aboutPrice: true },
  detail: DETAIL,
};
const REFUSED_HANDOFF: ReplyVerdict = {
  kind: 'handoff',
  notice: { reason: 'hot' },
  detail: DETAIL,
};

interface Case {
  readonly drafts: readonly LlmResult<ReplyDraft>[];
  readonly profile?: ClientProfile;
  readonly signals?: TurnSignals;
  /** Сбой оценки интереса вместо ответа. */
  readonly assessmentFails?: boolean;
  readonly progress?: ChatProgress;
  readonly problems?: readonly string[];
  readonly history?: readonly StoredMessage[];
  readonly note?: string;
}

function hot(text: string = FINAL_TEXT, aboutPrice = false): LlmResult<ReplyDraft> {
  return { ok: true, value: { outcome: 'hot', text, ...(aboutPrice ? { aboutPrice } : {}) } };
}

function answer(text: string = ANSWER, aboutPrice = false): LlmResult<ReplyDraft> {
  return { ok: true, value: { outcome: 'answer', text, ...(aboutPrice ? { aboutPrice } : {}) } };
}

function client(id: number, text: string): StoredMessage {
  return { id, chatId: CHAT_ID, author: 'client', kind: 'text', text, tsMs: NOW + id };
}

function bot(id: number, text: string): StoredMessage {
  return { id, chatId: CHAT_ID, author: 'bot', kind: 'text', text, tsMs: NOW + id };
}

function setup(c: Case) {
  const calls: string[] = [];
  const saved: InterestAssessment[] = [];
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
            profile: c.profile ?? READY,
            reason: 'по разговору',
            signals: c.signals ?? NOTHING,
          },
        };
  const draftReply = vi.fn<ReplyFlowDeps['agent']['draftReply']>((_context, feedback) => {
    calls.push(feedback === undefined ? 'draft' : 'draft:retry');
    const next = drafts.length > 1 ? drafts.shift() : drafts[0];
    return Promise.resolve(next ?? answer());
  });
  const reviewDraft = vi.fn<ReplyFlowDeps['agent']['reviewDraft']>(() => {
    calls.push('review');
    const problems = c.problems ?? [];
    return Promise.resolve({
      ok: true,
      value: problems.length === 0 ? { ok: true } : { ok: false, problems },
    });
  });
  const deps: ReplyFlowDeps = {
    chats: {
      saveAssessment: (_chatId, assessment) => {
        calls.push('save');
        saved.push(assessment);
      },
    },
    agent: {
      draftReply,
      reviewDraft,
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
    history: c.history ?? [client(1, CLIENT_TEXT)],
    // Выжимка до этого хода: решение о передаче код принимает по выжимке после оценки этого хода.
    profile: c.assessmentFails === true ? (c.profile ?? READY) : EMPTY_PROFILE,
    ...(c.progress === undefined ? {} : { progress: c.progress }),
    ...(c.note === undefined ? {} : { note: { text: c.note, atMs: NOW } }),
  };
  return { calls, saved, logs, draftReply, reviewDraft, deps, context };
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

function withText(text: string): ReplyVerdict {
  return { kind: 'handoff', notice: { reason: 'hot' }, text: text as ReviewedText, detail: DETAIL };
}

function progress(patch: Partial<ChatProgress>): ChatProgress {
  return { priceAsks: 0, refused: false, ...patch };
}

describe('фразы передачи владельца проходят проверки кодом (решение 30.10.2026)', () => {
  it.each([
    ['фраза о решении и ориентире', HOT_PRICE_HANDOFF_TEXT, false],
    ['она же на ходу с вопросом цены', HOT_PRICE_HANDOFF_TEXT, true],
    ['финал со сводкой задачи', FINAL_TEXT, false],
    ['уходы от вопросов', HANDOFF_TEXT, false],
  ])('%s', (_name, text, priceTurn) => {
    expect(HOT_PRICE_HANDOFF_TEXT).toBe('Я уточню у коллеги решение и ориентир под вашу задачу.');
    expect(
      runCodeChecks(normalizeDraft(text), {
        ownPhone: '' as PhoneDigits,
        clientText: CLIENT_TEXT,
        priceTurn,
      }),
    ).toEqual([]);
  });
});

describe('а) финал: модель вернула hot, для расчёта известно всё', () => {
  it('hot со сводкой задачи: передача с текстом модели, проверка как сообщения о передаче, уровень hot', async () => {
    const r = await run({ drafts: [hot()] });

    expect(r.verdict).toEqual(withText(FINAL_TEXT));
    expect(r.calls).toEqual(['draft', 'assess', 'save', 'review', 'save']);
    expect(r.reviewDraft).toHaveBeenCalledWith(expect.anything(), FINAL_TEXT, 'handoff');
  });

  it('клиент только что назвал последнее недостающее: решает выжимка после оценки этого хода', async () => {
    const r = await run({ drafts: [hot()], profile: READY });

    expect(r.verdict).toMatchObject({ kind: 'handoff', notice: { reason: 'hot' } });
    expect(r.context.profile).toBe(EMPTY_PROFILE);
  });

  it('hot без текста: фраза «Я уточню у коллеги решение и ориентир под вашу задачу.»', async () => {
    const r = await run({ drafts: [hot('')] });

    expect(r.verdict).toEqual(withText(HOT_PRICE_HANDOFF_TEXT));
  });

  it('модель ответила answer, хотя всё известно: ответ уходит, финал объявляет модель', async () => {
    const r = await run({ drafts: [answer()] });

    expect(r.verdict).toEqual(sentWith(ANSWER));
  });
});

describe('а) ранний hot: для расчёта известно не всё, вопроса цены нет', () => {
  it('один повтор с замечанием, чего не хватает для финала; повтор answer уходит, чат у бота', async () => {
    const r = await run({ drafts: [hot(), answer()], profile: TASK });

    expect(r.verdict).toEqual(sentWith(ANSWER));
    // Текст hot не проверяется: он не уйдёт. Проверяется только повтор.
    expect(r.calls).toEqual(['draft', 'assess', 'save', 'draft:retry', 'review']);
    expect(r.draftReply.mock.calls[1]?.[1]).toEqual([
      'Для финала не хватает: сколько нового приходит в месяц, сколько проходов нужно учитывать, город. Задай один открытый вопрос о недостающем.',
    ]);
  });

  it('повтор снова hot: безопасный вопрос о первом недостающем, без фразы об ориентире', async () => {
    const r = await run({ drafts: [hot(), hot()], profile: TASK });

    expect(r.verdict).toEqual(sentWith(questionText('monthlyIntake', false)));
    expect(r.calls).toEqual(['draft', 'assess', 'save', 'draft:retry']);
  });

  it('повтор не получился (сбой LLM): тот же безопасный вопрос, а не передача', async () => {
    const r = await run({ drafts: [hot(), { ok: false, failure: 'unavailable' }], profile: TASK });

    expect(r.verdict).toEqual(sentWith(questionText('monthlyIntake', false)));
  });

  it('повтор не прошёл проверку: безопасный вопрос вместо check_failed', async () => {
    const r = await run({ drafts: [hot(), answer()], profile: TASK, problems: ['Назван срок'] });

    expect(r.verdict).toEqual(sentWith(questionText('monthlyIntake', false)));
  });

  it('о чём бот уже спрашивал, безопасный вопрос не повторяет', async () => {
    const asked = questionText('monthlyIntake', false);
    const r = await run({
      drafts: [hot(), hot()],
      profile: TASK,
      history: [bot(1, asked), client(2, 'Не знаю')],
    });

    expect(r.verdict).toEqual(sentWith(questionText('passages', false)));
  });

  it('в лог только ID чата, попытка, коды недостающего и числа, без текста', async () => {
    const r = await run({ drafts: [hot(), answer()], profile: TASK });

    expect(r.logs).toContainEqual({
      level: 'info',
      context: {
        chatId: CHAT_ID,
        attempt: 1,
        missing: ['monthlyIntake', 'passages', 'city'],
        priceAsks: 0,
        aboutPrice: false,
      },
    });
    expect(JSON.stringify(r.logs)).not.toMatch(/запчаст|Алматы/);
  });

  it('живой тест 30.10: на пятом сообщении модель вернула hot, а нового в месяц и проходов нет: вопрос, а не передача', async () => {
    const fifth: ClientProfile = {
      ...EMPTY_PROFILE,
      business: 'банк',
      items: 'товар на складе',
      itemCount: '10 тыс',
      has1C: true,
      city: 'Алматы',
    };
    const r = await run({
      drafts: [hot('Я уточню у коллеги решение и ориентир под вашу задачу.'), answer()],
      profile: fifth,
    });

    expect(r.verdict).toEqual(sentWith(ANSWER));
    expect(r.draftReply.mock.calls[1]?.[1]?.[0]).toMatch(
      /^Для финала не хватает: сколько нового приходит в месяц, сколько проходов нужно учитывать\./,
    );
  });
});

describe('б) вопрос цены, сроков или договора', () => {
  it('задача понятна, модель вернула hot: передача с текстом модели', async () => {
    const text = `Интеграцию с вашей 1С делает наш сотрудник. ${HOT_PRICE_HANDOFF_TEXT}`;
    const r = await run({ drafts: [hot(text, true)], profile: TASK, signals: PRICE });

    expect(r.verdict).toEqual(withText(text));
  });

  it('задача понятна, модель ответила answer: код передаёт чат сам, фраза о решении и ориентире без проверки', async () => {
    const r = await run({ drafts: [answer(PRICE_ANSWER)], profile: TASK, signals: PRICE });

    expect(r.verdict).toEqual(PRICE_HANDOFF);
    expect(r.calls).toEqual(['draft', 'assess', 'save', 'save']);
    expect(r.logs).toContainEqual({
      level: 'info',
      context: { chatId: CHAT_ID, hot: 'price', priceAsks: 1, refusedStreak: 0 },
    });
  });

  it('задача понятна, hot без текста и без aboutPrice (вопрос цены видит оценка): фраза о решении и ориентире', async () => {
    const r = await run({ drafts: [hot('')], profile: TASK, signals: PRICE });

    expect(r.verdict).toEqual(PRICE_HANDOFF);
  });

  it('задача не понятна, модель вернула hot: повтор с замечанием о фразе об ориентире и первом недостающем', async () => {
    const r = await run({
      drafts: [hot(HOT_PRICE_HANDOFF_TEXT, true), answer(PRICE_ANSWER)],
      profile: VAGUE,
      signals: PRICE,
    });

    expect(r.verdict).toEqual(sentWith(PRICE_ANSWER, { signals: PRICE }));
    expect(r.draftReply.mock.calls[1]?.[1]).toEqual([
      'Цену, сроки и договор называет коллега. Ответь «Ориентир коллега назовёт, когда поймём вашу задачу.» и задай один открытый вопрос о недостающем: что лежит на хранении.',
    ]);
  });

  it('задача не понятна, повтор снова hot: безопасный вопрос с фразой об ориентире', async () => {
    const r = await run({ drafts: [hot('', true), hot('', true)], profile: VAGUE, signals: PRICE });

    expect(r.verdict).toEqual(sentWith(questionText('items', true), { signals: PRICE }));
  });

  it.each<[string, ClientProfile]>([
    ['клиент не согласился с трудностью', { ...TASK, problemAgreed: false }],
    ['неизвестно сколько', { ...TASK, itemCount: null }],
  ])('%s: ответ на вопрос цены уходит, чат у бота', async (_name, profile) => {
    const r = await run({ drafts: [answer(PRICE_ANSWER)], profile, signals: PRICE });

    expect(r.verdict).toEqual(sentWith(PRICE_ANSWER, { signals: PRICE }));
  });

  it('при заметке для бота замечание напоминает ответить ориентиром из неё', async () => {
    const r = await run({
      drafts: [hot('', true), answer(PRICE_ANSWER)],
      profile: VAGUE,
      signals: PRICE,
      note: 'Ориентир от 1 500 000 тенге',
    });

    expect(r.draftReply.mock.calls[1]?.[1]?.[0]).toMatch(
      /Если в указании коллеги есть ориентир цены, ответь им ровно как там написано\.$/u,
    );
  });
});

describe('в) третий вопрос цены (было четыре)', () => {
  it('третий вопрос, задача не понятна, модель ответила answer: код передаёт чат с фразой о решении и ориентире', async () => {
    const r = await run({
      drafts: [answer(PRICE_ANSWER)],
      profile: VAGUE,
      signals: PRICE,
      progress: progress({ priceAsks: 2 }),
    });

    expect(r.verdict).toEqual(PRICE_HANDOFF);
    expect(r.logs).toContainEqual({
      level: 'info',
      context: { chatId: CHAT_ID, hot: 'price_third', priceAsks: 3, refusedStreak: 0 },
    });
  });

  it('третий вопрос, модель вернула hot: передача принимается', async () => {
    const r = await run({
      drafts: [hot(HOT_PRICE_HANDOFF_TEXT, true)],
      profile: VAGUE,
      signals: PRICE,
      progress: progress({ priceAsks: 2 }),
    });

    expect(r.verdict).toEqual(withText(HOT_PRICE_HANDOFF_TEXT));
  });

  it('второй вопрос цены без понятной задачи: ещё нет', async () => {
    const r = await run({
      drafts: [answer(PRICE_ANSWER)],
      profile: VAGUE,
      signals: PRICE,
      progress: progress({ priceAsks: 1 }),
    });

    expect(r.verdict).toEqual(sentWith(PRICE_ANSWER, { signals: PRICE }));
  });

  it('оценка не получилась: решает aboutPrice ответа, третий вопрос передаёт', async () => {
    const r = await run({
      drafts: [answer(PRICE_ANSWER, true)],
      profile: VAGUE,
      assessmentFails: true,
      progress: progress({ priceAsks: 2 }),
    });

    expect(r.verdict).toEqual(PRICE_HANDOFF);
  });

  it('оценка говорит, что цену не спрашивали: aboutPrice ответа не засчитывается', async () => {
    const r = await run({
      drafts: [answer(ANSWER, true)],
      profile: VAGUE,
      signals: NOTHING,
      progress: progress({ priceAsks: 2 }),
    });

    expect(r.verdict).toEqual(sentWith(ANSWER));
  });
});

describe('заметка для бота с суммой-ценой: вопрос цены чат не передаёт', () => {
  const NOTE_TEXT = 'Ориентир от 1 500 000 тенге, нужен выезд';
  const WITH_PRICE =
    'Коллега подсказал ориентир от 1 500 000 тенге. Точнее скажем после выезда к вам.';
  const RETURNED = progress({ handedOff: true });

  it('задача понятна: цена ровно как в заметке проходит проверки и уходит', async () => {
    const r = await run({
      drafts: [answer(WITH_PRICE)],
      profile: TASK,
      signals: PRICE,
      note: NOTE_TEXT,
      progress: RETURNED,
    });

    expect(r.verdict).toEqual(sentWith(WITH_PRICE, { signals: PRICE }));
    expect(r.calls).toEqual(['draft', 'assess', 'save', 'review']);
  });

  it('третий вопрос цены: тоже ответ суммой из заметки', async () => {
    const r = await run({
      drafts: [answer(WITH_PRICE)],
      profile: VAGUE,
      signals: PRICE,
      note: NOTE_TEXT,
      progress: { ...RETURNED, priceAsks: 2 },
    });

    expect(r.verdict).toMatchObject({ kind: 'send', text: WITH_PRICE });
  });

  it('цена не как в заметке: повтор с замечанием сверить с указанием', async () => {
    const r = await run({
      drafts: [
        answer('Коллега подсказал ориентир от 1 млн тенге. Точнее скажем после выезда.'),
        answer(WITH_PRICE),
      ],
      profile: TASK,
      signals: PRICE,
      note: NOTE_TEXT,
      progress: RETURNED,
    });

    expect(r.verdict).toEqual(sentWith(WITH_PRICE, { signals: PRICE }));
    expect(r.draftReply.mock.calls[1]?.[1]?.join(' ')).toContain('цена не как в указании коллеги');
  });

  it('заметка-задание без суммы: вопрос цены при понятной задаче передаёт, как без заметки', async () => {
    const r = await run({
      drafts: [answer(PRICE_ANSWER)],
      profile: TASK,
      signals: PRICE,
      note: 'Узнай число вещей и какая 1С',
      progress: RETURNED,
    });

    expect(r.verdict).toEqual(PRICE_HANDOFF);
  });

  it('без заметки бот цену не называет: та же цена нарушение, повтор', async () => {
    const r = await run({
      drafts: [answer(WITH_PRICE), answer(PRICE_ANSWER)],
      profile: VAGUE,
      signals: PRICE,
    });

    expect(r.verdict).toEqual(sentWith(PRICE_ANSWER, { signals: PRICE }));
    expect(r.draftReply.mock.calls[1]?.[1]?.join(' ')).toMatch(/цена: /);
  });
});

describe('г) клиент два хода подряд уходит от вопросов', () => {
  const STREAK = progress({ refusedStreak: 1 });
  const DODGE = 'Это неважно. Просто расскажите, как это работает';
  const DRAFT =
    'Метку клеят на товар, а антенны на входе и выходе сами отмечают, что пришло и что ушло. Расскажите, что у вас лежит на хранении?';

  it('второй уход подряд, модель ответила answer: код передаёт чат с «Уточню у коллеги и вернусь к вам.»', async () => {
    const r = await run({
      drafts: [answer(DRAFT)],
      profile: VAGUE,
      signals: REFUSED,
      progress: STREAK,
      history: [bot(1, 'Расскажите, что у вас лежит на хранении?'), client(2, 'Не скажу')],
    });

    expect(r.verdict).toEqual(REFUSED_HANDOFF);
    expect(r.calls).toEqual(['draft', 'assess', 'save', 'save']);
    expect(r.logs).toContainEqual({
      level: 'info',
      context: { chatId: CHAT_ID, hot: 'refused', priceAsks: 0, refusedStreak: 2 },
    });
  });

  it('клиент при этом что-то спросил: ответ из черновика и фраза передачи, проверка как сообщения о передаче', async () => {
    const r = await run({
      drafts: [answer(DRAFT)],
      profile: VAGUE,
      signals: REFUSED,
      progress: STREAK,
      history: [bot(1, 'Расскажите, что у вас на хранении?'), client(2, DODGE)],
    });

    const text =
      'Метку клеят на товар, а антенны на входе и выходе сами отмечают, что пришло и что ушло. Уточню у коллеги и вернусь к вам.';
    expect(r.verdict).toEqual(withText(text));
    expect(r.reviewDraft).toHaveBeenCalledWith(expect.anything(), text, 'handoff');
    expect(r.calls.filter((call) => call.startsWith('draft'))).toEqual(['draft']);
  });

  it('ответ из черновика не прошёл проверку: только фраза передачи, без повтора', async () => {
    const r = await run({
      drafts: [answer(DRAFT)],
      profile: VAGUE,
      signals: REFUSED,
      progress: STREAK,
      history: [bot(1, 'Расскажите, что у вас на хранении?'), client(2, DODGE)],
      problems: ['Утверждение не из документов'],
    });

    expect(r.verdict).toEqual(REFUSED_HANDOFF);
    expect(r.calls.filter((call) => call.startsWith('draft'))).toEqual(['draft']);
  });

  it('уход и вопрос цены без понятной задачи: фраза «Уточню у коллеги и вернусь к вам.», ответа из черновика нет', async () => {
    const r = await run({
      drafts: [answer(PRICE_ANSWER)],
      profile: VAGUE,
      signals: { priceAsked: true, refused: true },
      progress: STREAK,
    });

    expect(r.verdict).toEqual(REFUSED_HANDOFF);
  });

  it('модель сама вернула hot без текста: та же фраза', async () => {
    const r = await run({ drafts: [hot('')], profile: VAGUE, signals: REFUSED, progress: STREAK });

    expect(r.verdict).toEqual(REFUSED_HANDOFF);
  });

  it('первый уход: ответ уходит, отказ записывается после отправки', async () => {
    const r = await run({ drafts: [answer(DRAFT)], profile: VAGUE, signals: REFUSED });

    expect(r.verdict).toEqual(sentWith(DRAFT, { signals: REFUSED }));
  });

  it('уход был прошлым ходом, а сейчас клиент ответил: ответ уходит с сигналами, они обнулят счёт', async () => {
    const r = await run({
      drafts: [answer(DRAFT)],
      profile: VAGUE,
      signals: NOTHING,
      progress: STREAK,
    });

    expect(r.verdict).toEqual(sentWith(DRAFT, { signals: NOTHING }));
  });
});

describe('д) просьба о человеке, жалоба и нет ответа передают сразу', () => {
  it.each<[string, LlmResult<ReplyDraft>]>([
    ['просьба о человеке', { ok: true, value: { outcome: 'asked_human', text: '' } }],
    ['жалоба', { ok: true, value: { outcome: 'complaint', stopRequested: false } }],
    ['нет ответа', { ok: true, value: { outcome: 'no_answer', text: '' } }],
  ])('%s без понятной задачи: передача без повтора', async (_name, draft) => {
    const r = await run({ drafts: [draft], profile: VAGUE });

    expect(r.verdict).toMatchObject({ kind: 'handoff' });
    expect(r.calls).not.toContain('draft:retry');
  });
});

describe('причина передачи своими словами с цитатой клиента (пункт 3)', () => {
  const QUOTE = `Клиент: «${CLIENT_TEXT}»`;

  it.each<[string, Case, string]>([
    ['а) финал', { drafts: [hot()] }, 'Всё для расчёта известно, клиент готов к расчёту.'],
    [
      'б) цена при понятной задаче',
      { drafts: [answer(PRICE_ANSWER)], profile: TASK, signals: PRICE },
      'Спрашивает цену, сроки или договор, задача понятна.',
    ],
    [
      'в) третий вопрос цены',
      {
        drafts: [answer(PRICE_ANSWER)],
        profile: VAGUE,
        signals: PRICE,
        progress: progress({ priceAsks: 2 }),
      },
      'Третий раз спрашивает цену.',
    ],
    [
      'г) два ухода от вопросов подряд',
      {
        drafts: [answer()],
        profile: VAGUE,
        signals: REFUSED,
        progress: progress({ refusedStreak: 1 }),
      },
      'Дважды подряд уходит от вопросов.',
    ],
  ])('%s: уровень hot, причина в чате и в вердикте', async (_name, c, words) => {
    const r = await run(c);

    const reason = `${words} ${QUOTE}`;
    expect(r.verdict).toMatchObject({ kind: 'handoff', detail: reason });
    expect(r.saved.at(-1)).toEqual({ level: 'hot', profile: c.profile ?? READY, reason });
  });

  it.each<[string, LlmResult<ReplyDraft>, string]>([
    [
      'просьба о человеке',
      { ok: true, value: { outcome: 'asked_human', text: '' } },
      'Просит живого человека.',
    ],
    ['жалоба', { ok: true, value: { outcome: 'complaint', stopRequested: false } }, 'Жалуется.'],
    [
      'нет ответа',
      { ok: true, value: { outcome: 'no_answer', text: '' } },
      'Ответа нет в документах.',
    ],
  ])('%s: уровень из оценки, причина своими словами', async (_name, draft, words) => {
    const r = await run({ drafts: [draft], profile: VAGUE });

    const reason = `${words} ${QUOTE}`;
    expect(r.verdict).toMatchObject({ detail: reason });
    expect(r.saved.at(-1)).toEqual({ level: 'warm', profile: VAGUE, reason });
  });

  it('прежней заготовки «спрашивает цену» больше нет: живой тест 30.10, клиент цену не спрашивал', async () => {
    const r = await run({
      drafts: [hot()],
      history: [client(1, 'Алматы, да у нас есть 1c система')],
    });

    expect(r.saved.at(-1)?.reason).toBe(
      'Всё для расчёта известно, клиент готов к расчёту. Клиент: «Алматы, да у нас есть 1c система»',
    );
    expect(JSON.stringify(r.saved)).not.toMatch(/спрашивает цену, сроки или договор\./u);
  });

  it('в лог причина и слова клиента не попадают', async () => {
    const r = await run({ drafts: [answer(PRICE_ANSWER)], profile: TASK, signals: PRICE });

    expect(JSON.stringify(r.logs)).not.toContain(CLIENT_TEXT);
  });
});

describe('что записать после ответа', () => {
  it('без вопроса цены, отказа и прошлых уходов: сигналов в вердикте нет', async () => {
    const r = await run({ drafts: [answer()], profile: VAGUE });

    expect(r.verdict).toEqual(sentWith(ANSWER));
  });
});

describe('фраза об ориентире только при вопросе цены', () => {
  const QUESTION = 'Расскажите, что у вас лежит на хранении?';

  it('клиент цену не спрашивал: черновик с фразой отклоняет код, повтор с замечанием, уходит повтор', async () => {
    const r = await run({ drafts: [answer(PRICE_ANSWER), answer(QUESTION)], profile: VAGUE });

    expect(r.verdict).toEqual(sentWith(QUESTION));
    expect(r.calls).toEqual(['draft', 'assess', 'save', 'draft:retry', 'review']);
    expect(r.draftReply.mock.calls[1]?.[1]?.join(' ')).toMatch(
      /только когда клиент спрашивает цену/,
    );
  });

  it('оценка не получилась: решает aboutPrice черновика', async () => {
    const asked = await run({
      assessmentFails: true,
      profile: VAGUE,
      drafts: [answer(PRICE_ANSWER, true)],
    });
    const notAsked = await run({
      assessmentFails: true,
      profile: VAGUE,
      drafts: [answer(PRICE_ANSWER), answer(QUESTION)],
    });

    expect(asked.verdict).toEqual(sentWith(PRICE_ANSWER, { signals: PRICE }));
    expect(notAsked.verdict).toEqual(sentWith(QUESTION));
  });
});
