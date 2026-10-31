import { describe, expect, it } from 'vitest';
import type { ConversationContext } from '../../../src/agent/agent.js';
import { ESTIMATE_LATER } from '../../../src/agent/stage.js';
import type {
  ChatId,
  ChatProgress,
  ClientProfile,
  InterestAssessment,
  LlmResult,
  ReplyDraft,
  TurnSignals,
} from '../../../src/domain/types.js';
import {
  earlyHotFallback,
  earlyHotRemark,
  hotKindOf,
  PRICE_ASKS_FOR_HANDOFF,
  REFUSALS_FOR_HANDOFF,
  turnSituation,
  type TurnSituation,
} from '../../../src/pipeline/handoff-gate.js';
import { questionText } from '../../../src/pipeline/safe-questions.js';
import { EMPTY_PROFILE } from '../agent/fakes.js';

// Когда код передаёт чат (решение владельца 30.10.2026): финал (для расчёта известно всё), вопрос цены, сроков или
// договора при понятной задаче, третий вопрос цены, два ухода от вопросов подряд. Чистые функции без LLM.

const CHAT_ID = 1 as ChatId;

/** Задача понятна: клиент рассказал о задаче, известно, что на хранении и сколько. */
const TASK: ClientProfile = {
  ...EMPTY_PROFILE,
  business: 'склад запчастей',
  items: 'запчасти',
  itemCount: 'около 3000',
  problemAgreed: true,
};

/** Для расчёта известно всё. */
const ALL: ClientProfile = {
  ...TASK,
  monthlyIntake: '200 в месяц',
  passages: 'один вход',
  has1C: true,
  city: 'Алматы',
};

const ANSWER: LlmResult<ReplyDraft> = { ok: true, value: { outcome: 'answer', text: 'Да.' } };
const PRICE: TurnSignals = { priceAsked: true, refused: false };
const NOTHING: TurnSignals = { priceAsked: false, refused: false };

function assessment(profile: ClientProfile, signals: TurnSignals): InterestAssessment {
  return { level: 'warm', profile, reason: 'по разговору', signals };
}

function context(extra: Partial<ConversationContext> = {}): ConversationContext {
  return { chatId: CHAT_ID, history: [], profile: EMPTY_PROFILE, ...extra };
}

function situation(
  profile: ClientProfile,
  signals: TurnSignals,
  extra: Partial<ConversationContext> = {},
): TurnSituation {
  return turnSituation(context(extra), assessment(profile, signals), ANSWER);
}

function progress(patch: Partial<ChatProgress>): ChatProgress {
  return { priceAsks: 0, refused: false, ...patch };
}

describe('pipeline/handoff-gate: что код знает о ходе', () => {
  it('выжимка и сигналы из оценки этого хода; недостающее для расчёта и понятность задачи по ней', () => {
    const s = situation(TASK, PRICE);

    expect(s.profile).toBe(TASK);
    expect(s.missing).toEqual(['monthlyIntake', 'passages', 'has1C', 'city']);
    expect(s.taskUnderstood).toBe(true);
    expect(s.signals).toEqual(PRICE);
    expect(s.priceAsks).toBe(1);
    expect(s.refusedStreak).toBe(0);
  });

  it('вопросы цены с прошлых ходов и этот; без вопроса цены сейчас счёт не растёт', () => {
    expect(situation(TASK, PRICE, { progress: progress({ priceAsks: 2 }) }).priceAsks).toBe(3);
    expect(situation(TASK, NOTHING, { progress: progress({ priceAsks: 2 }) }).priceAsks).toBe(2);
  });

  it('уходы от вопросов подряд: отказ сейчас продолжает счёт, ход без отказа его обнуляет', () => {
    const refused: TurnSignals = { priceAsked: false, refused: true };
    expect(situation(TASK, refused).refusedStreak).toBe(1);
    expect(
      situation(TASK, refused, { progress: progress({ refusedStreak: 1 }) }).refusedStreak,
    ).toBe(2);
    expect(
      situation(TASK, NOTHING, { progress: progress({ refusedStreak: 1 }) }).refusedStreak,
    ).toBe(0);
  });

  it('оценки нет: выжимка до этого хода, вопрос цены по aboutPrice черновика, отказа нет', () => {
    const hot: LlmResult<ReplyDraft> = {
      ok: true,
      value: { outcome: 'hot', text: '', aboutPrice: true },
    };
    const s = turnSituation(
      context({ profile: TASK, progress: progress({ refusedStreak: 1 }) }),
      null,
      hot,
    );

    expect(s.profile).toBe(TASK);
    expect(s.signals).toEqual(PRICE);
    expect(s.refusedStreak).toBe(0);
  });

  it('у answer решает оценка, aboutPrice черновика только запасной сигнал', () => {
    const priced: LlmResult<ReplyDraft> = {
      ok: true,
      value: { outcome: 'answer', text: 'Да.', aboutPrice: true },
    };

    expect(turnSituation(context(), assessment(TASK, NOTHING), priced).signals.priceAsked).toBe(
      false,
    );
    expect(turnSituation(context(), null, priced).signals.priceAsked).toBe(true);
  });

  it('о компании спросить можно, только если название неизвестно и блок о компании разрешает', () => {
    const askable = { kind: 'unknown', askName: true } as const;
    expect(situation(TASK, NOTHING, { company: askable }).companyAskable).toBe(true);
    expect(
      situation(TASK, NOTHING, { company: askable, companyName: 'ТОО Склад' }).companyAskable,
    ).toBe(false);
    expect(situation(TASK, NOTHING, { company: { kind: 'off' } }).companyAskable).toBe(false);
  });

  it('заметка для бота: есть ли она и есть ли в ней сумма-цена', () => {
    const withPrice = situation(TASK, PRICE, {
      note: { text: 'Ориентир от 1 500 000 тенге', atMs: 1 },
    });
    const task = situation(TASK, PRICE, { note: { text: 'Узнай число вещей', atMs: 1 } });

    expect([withPrice.hasNote, withPrice.notePrice]).toEqual([true, true]);
    expect([task.hasNote, task.notePrice]).toEqual([true, false]);
    expect([situation(TASK, PRICE).hasNote, situation(TASK, PRICE).notePrice]).toEqual([
      false,
      false,
    ]);
  });
});

describe('pipeline/handoff-gate: почему hot передаёт чат', () => {
  it('пороги владельца: третий вопрос цены, два ухода от вопросов подряд', () => {
    expect(PRICE_ASKS_FOR_HANDOFF).toBe(3);
    expect(REFUSALS_FOR_HANDOFF).toBe(2);
  });

  it('финал: для расчёта известно всё, вопроса цены нет', () => {
    expect(hotKindOf(situation(ALL, NOTHING))).toBe('final');
  });

  it('вопрос цены, сроков или договора при понятной задаче', () => {
    expect(hotKindOf(situation(TASK, PRICE))).toBe('price');
    expect(hotKindOf(situation(ALL, PRICE))).toBe('price');
  });

  it('задача не понятна (нет согласия с трудностью, числа или что на хранении): вопрос цены передачи не даёт', () => {
    expect(hotKindOf(situation({ ...TASK, problemAgreed: false }, PRICE))).toBeNull();
    expect(hotKindOf(situation({ ...TASK, itemCount: null }, PRICE))).toBeNull();
    expect(hotKindOf(situation({ ...TASK, items: null }, PRICE))).toBeNull();
  });

  it('третий вопрос цены передаёт и без понятной задачи; второй нет', () => {
    const vague = { ...EMPTY_PROFILE, business: 'банк' };
    expect(hotKindOf(situation(vague, PRICE, { progress: progress({ priceAsks: 2 }) }))).toBe(
      'price_third',
    );
    expect(hotKindOf(situation(vague, PRICE, { progress: progress({ priceAsks: 1 }) }))).toBeNull();
  });

  it('третий вопрос цены считается только на ходу с вопросом цены', () => {
    const vague = { ...EMPTY_PROFILE, business: 'банк' };
    expect(
      hotKindOf(situation(vague, NOTHING, { progress: progress({ priceAsks: 3 }) })),
    ).toBeNull();
  });

  it('два ухода от вопросов подряд; один уход или уход после обычного хода нет', () => {
    const refused: TurnSignals = { priceAsked: false, refused: true };
    const vague = { ...EMPTY_PROFILE, business: 'банк' };
    expect(hotKindOf(situation(vague, refused, { progress: progress({ refusedStreak: 1 }) }))).toBe(
      'refused',
    );
    expect(hotKindOf(situation(vague, refused))).toBeNull();
    expect(
      hotKindOf(situation(vague, NOTHING, { progress: progress({ refusedStreak: 1 }) })),
    ).toBeNull();
  });

  it('порядок: третий вопрос цены, цена при понятной задаче, уходы от вопросов, финал', () => {
    const refused: TurnSignals = { priceAsked: true, refused: true };
    const streak = progress({ priceAsks: 2, refusedStreak: 1 });
    expect(hotKindOf(situation(ALL, refused, { progress: streak }))).toBe('price_third');
    expect(hotKindOf(situation(ALL, refused, { progress: progress({ refusedStreak: 1 }) }))).toBe(
      'price',
    );
    expect(
      hotKindOf(situation(ALL, { priceAsked: false, refused: true }, { progress: streak })),
    ).toBe('refused');
  });

  it('в заметке есть сумма-цена: вопрос цены чат не передаёт (бот отвечает суммой из заметки)', () => {
    const note = { text: 'Ориентир от 1 500 000 тенге', atMs: 1 };
    const third = progress({ priceAsks: 2 });
    expect(hotKindOf(situation(TASK, PRICE, { note }))).toBeNull();
    expect(hotKindOf(situation(TASK, PRICE, { note, progress: third }))).toBeNull();
    expect(hotKindOf(situation(ALL, PRICE, { note }))).toBe('final');
  });
});

describe('pipeline/handoff-gate: ранний hot', () => {
  it('без вопроса цены: чего не хватает для финала и один открытый вопрос', () => {
    expect(earlyHotRemark(situation(TASK, NOTHING))).toBe(
      'Для финала не хватает: сколько нового приходит в месяц, сколько проходов нужно учитывать, есть ли 1С и какая, город. Задай один открытый вопрос о недостающем.',
    );
  });

  it('вопрос цены, задача не понятна: фраза об ориентире и вопрос о первом недостающем для расчёта', () => {
    const vague = { ...EMPTY_PROFILE, business: 'банк' };

    expect(earlyHotRemark(situation(vague, PRICE))).toBe(
      `Цену, сроки и договор называет коллега. Ответь «${ESTIMATE_LATER}» и задай один открытый вопрос о недостающем: что лежит на хранении.`,
    );
  });

  it('при заметке для бота напоминание ответить ориентиром из неё, если он там есть', () => {
    const remark = earlyHotRemark(
      situation({ ...EMPTY_PROFILE, business: 'банк' }, PRICE, {
        note: { text: 'Ориентир от 1 500 000 тенге', atMs: 1 },
      }),
    );

    expect(remark).toMatch(
      / Если в указании коллеги есть ориентир цены, ответь им ровно как там написано\.$/u,
    );
  });

  it('безопасный вопрос: первое недостающее для расчёта, о котором бот ещё не спрашивал; при цене с фразой об ориентире', () => {
    const vague = { ...EMPTY_PROFILE, business: 'банк' };

    expect(earlyHotFallback(situation(vague, PRICE), []).text).toBe(questionText('items', true));
    expect(earlyHotFallback(situation(TASK, NOTHING), []).text).toBe(
      questionText('monthlyIntake', false),
    );
    expect(
      earlyHotFallback(situation(TASK, NOTHING), [questionText('monthlyIntake', false)]).text,
    ).toBe(questionText('passages', false));
  });

  it('бизнес неизвестен, о компании можно спросить: вопрос знакомства с вопросом о названии', () => {
    const s = situation(EMPTY_PROFILE, PRICE, { company: { kind: 'unknown', askName: true } });

    expect(earlyHotFallback(s, [])).toEqual({
      key: 'intro',
      text: questionText('intro', true),
      companyQuestion: 'name',
    });
  });
});
