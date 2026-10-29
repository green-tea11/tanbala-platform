import { describe, expect, it } from 'vitest';
import {
  normalizeDraft,
  runCodeChecks,
  type CheckFinding,
} from '../../../src/checks/code-checks.js';
import type {
  PhoneDigits,
  ReplyDraft,
  ReplyHandoffOutcome,
  ReviewedText,
} from '../../../src/domain/types.js';
import {
  decideAction,
  PRICE_QUESTION_TEXTS,
  priceQuestion,
  type Decision,
  type DecisionInput,
  type DraftGate,
  type TextDraft,
} from '../../../src/pipeline/decide.js';

const TEXT = 'Учёт подбираем под задачу. Что вы храните?';
/** Своего номера в ответах у бота нет (как в pipeline/reply-flow.ts). */
const NO_PHONE = '' as PhoneDigits;
const HANDOFF_TEXT =
  'Да, мы проводим интеграцию с вашей 1С. Передал вопрос специалисту, он вам напишет.';
const DASH: CheckFinding = { code: 'dash', detail: 'тире: «—» в «…учёт — это…»' };
const PRICE: CheckFinding = { code: 'price', detail: 'цена: «5 000 тг» в «…стоит 5 000 тг…»' };

const PASSED: DraftGate = { kind: 'reviewed', review: { ok: true } };
const CODE_FAILED: DraftGate = { kind: 'code_failed', findings: [DASH, PRICE] };
const REVIEW_FAILED: DraftGate = {
  kind: 'reviewed',
  review: { ok: false, problems: ['Названа цена, её нет в знаниях', 'Обещан срок'] },
};
const REVIEW_FAILED_NO_PROBLEMS: DraftGate = {
  kind: 'reviewed',
  review: { ok: false, problems: [] },
};

const HANDOFF_OUTCOMES: readonly ReplyHandoffOutcome[] = ['hot', 'no_answer', 'asked_human'];

function withText(draft: TextDraft, gate: DraftGate, attempt: 1 | 2 = 1): DecisionInput {
  return { kind: 'text', draft, gate, attempt };
}

const ANSWER: TextDraft = { outcome: 'answer', text: TEXT };

function handoffText(outcome: ReplyHandoffOutcome): TextDraft {
  return { outcome, text: HANDOFF_TEXT };
}

describe('pipeline/decide: исходы без текста для проверки', () => {
  it.each<[string, Exclude<ReplyDraft, { outcome: 'answer' }>, Decision]>([
    ['горячий клиент без текста', { outcome: 'hot', text: '' }, { kind: 'handoff', reason: 'hot' }],
    [
      'нет ответа в знаниях без текста',
      { outcome: 'no_answer', text: '' },
      { kind: 'handoff', reason: 'no_answer' },
    ],
    [
      'просит человека без текста',
      { outcome: 'asked_human', text: '' },
      { kind: 'handoff', reason: 'asked_human' },
    ],
    [
      'жалоба',
      { outcome: 'complaint', stopRequested: false },
      { kind: 'handoff', reason: 'complaint', stopRequested: false },
    ],
    [
      'жалоба, просит больше не писать',
      { outcome: 'complaint', stopRequested: true },
      { kind: 'handoff', reason: 'complaint', stopRequested: true },
    ],
  ])('%s: передача по своей причине, фиксированная фраза', (_case, draft, expected) => {
    const decision = decideAction({ kind: 'handoff_outcome', draft });

    expect(decision).toEqual(expected);
    expect(decision).not.toHaveProperty('text');
  });

  it.each(HANDOFF_OUTCOMES)(
    '%s: текст, который не прошёл проверку, в решение не попадает',
    (outcome) => {
      const decision = decideAction({
        kind: 'handoff_outcome',
        draft: { outcome, text: HANDOFF_TEXT },
      });

      expect(decision).toEqual({ kind: 'handoff', reason: outcome });
      expect(decision).not.toHaveProperty('text');
    },
  );
});

describe('pipeline/decide: ответ answer', () => {
  it('проверки пройдены: отправить тот же текст', () => {
    expect(decideAction(withText(ANSWER, PASSED))).toEqual({
      kind: 'send',
      text: TEXT as ReviewedText,
    });
  });

  it('проверки пройдены на второй попытке: тоже отправить', () => {
    expect(decideAction(withText(ANSWER, PASSED, 2))).toEqual({
      kind: 'send',
      text: TEXT as ReviewedText,
    });
  });

  it('проверки кодом не пройдены на попытке 1: повтор с описанием нарушений по порядку', () => {
    expect(decideAction(withText(ANSWER, CODE_FAILED))).toEqual({
      kind: 'retry',
      feedback: [DASH.detail, PRICE.detail],
    });
  });

  it('проверка вторым вызовом не пройдена на попытке 1: повтор с замечаниями проверки', () => {
    expect(decideAction(withText(ANSWER, REVIEW_FAILED))).toEqual({
      kind: 'retry',
      feedback: ['Названа цена, её нет в знаниях', 'Обещан срок'],
    });
  });

  it('проверка не пройдена без замечаний: повтор всё равно с непустым замечанием', () => {
    const decision = decideAction(withText(ANSWER, REVIEW_FAILED_NO_PROBLEMS));

    expect(decision.kind).toBe('retry');
    expect(decision.kind === 'retry' && decision.feedback.length).toBe(1);
    expect(decision.kind === 'retry' && decision.feedback[0]?.trim()).not.toBe('');
  });

  it.each<[string, DraftGate]>([
    ['проверки кодом', CODE_FAILED],
    ['проверка вторым вызовом', REVIEW_FAILED],
    ['проверка без замечаний', REVIEW_FAILED_NO_PROBLEMS],
  ])('%s не пройдены на попытке 2: передача check_failed, третьей попытки нет', (_case, gate) => {
    expect(decideAction(withText(ANSWER, gate, 2))).toEqual({
      kind: 'handoff',
      reason: 'check_failed',
    });
  });
});

describe('pipeline/decide: сообщение передачи (hot, no_answer, asked_human с текстом)', () => {
  it.each(HANDOFF_OUTCOMES)(
    '%s, проверки пройдены: передача с этой причиной и этим текстом вместо фиксированной фразы',
    (outcome) => {
      expect(decideAction(withText(handoffText(outcome), PASSED))).toEqual({
        kind: 'handoff',
        reason: outcome,
        text: HANDOFF_TEXT as ReviewedText,
      });
    },
  );

  it.each(HANDOFF_OUTCOMES)(
    '%s, проверки пройдены только со второй попытки: тот же результат',
    (outcome) => {
      expect(decideAction(withText(handoffText(outcome), PASSED, 2))).toEqual({
        kind: 'handoff',
        reason: outcome,
        text: HANDOFF_TEXT as ReviewedText,
      });
    },
  );

  it.each(HANDOFF_OUTCOMES)('%s, нарушения кода на попытке 1: повтор с описанием', (outcome) => {
    expect(decideAction(withText(handoffText(outcome), CODE_FAILED))).toEqual({
      kind: 'retry',
      feedback: [DASH.detail, PRICE.detail],
    });
  });

  it.each(HANDOFF_OUTCOMES)(
    '%s, замечания проверки на попытке 1: повтор с замечаниями',
    (outcome) => {
      expect(decideAction(withText(handoffText(outcome), REVIEW_FAILED))).toEqual({
        kind: 'retry',
        feedback: ['Названа цена, её нет в знаниях', 'Обещан срок'],
      });
    },
  );

  it.each(HANDOFF_OUTCOMES)(
    '%s, провал на попытке 2: та же причина и фиксированная фраза, причина не подменяется на check_failed',
    (outcome) => {
      for (const gate of [CODE_FAILED, REVIEW_FAILED, REVIEW_FAILED_NO_PROBLEMS]) {
        const decision = decideAction(withText(handoffText(outcome), gate, 2));

        expect(decision).toEqual({ kind: 'handoff', reason: outcome });
        expect(decision).not.toHaveProperty('text');
      }
    },
  );
});

describe('pipeline/decide: hot после вопроса цены (aboutPrice)', () => {
  const PRICED: TextDraft = { outcome: 'hot', text: HANDOFF_TEXT, aboutPrice: true };

  it('hot без текста с aboutPrice: передача hot с пометкой, фраза о цене', () => {
    expect(
      decideAction({
        kind: 'handoff_outcome',
        draft: { outcome: 'hot', text: '', aboutPrice: true },
      }),
    ).toEqual({ kind: 'handoff', reason: 'hot', aboutPrice: true });
  });

  it('hot с aboutPrice, провал на попытке 2: пометка остаётся, текста нет', () => {
    const decision = decideAction(withText(PRICED, CODE_FAILED, 2));

    expect(decision).toEqual({ kind: 'handoff', reason: 'hot', aboutPrice: true });
    expect(decision).not.toHaveProperty('text');
  });

  it('hot с aboutPrice, проверки пройдены: уходит текст модели, пометка не нужна', () => {
    expect(decideAction(withText(PRICED, PASSED))).toEqual({
      kind: 'handoff',
      reason: 'hot',
      text: HANDOFF_TEXT as ReviewedText,
    });
  });

  it.each<[string, Extract<ReplyDraft, { outcome: ReplyHandoffOutcome }>]>([
    ['hot с aboutPrice false', { outcome: 'hot', text: '', aboutPrice: false }],
    ['hot без поля (подделка LLM)', { outcome: 'hot', text: '' }],
    ['no_answer с aboutPrice', { outcome: 'no_answer', text: '', aboutPrice: true }],
    ['asked_human с aboutPrice', { outcome: 'asked_human', text: '', aboutPrice: true }],
  ])('%s: пометки нет, обычная фраза по причине', (_case, draft) => {
    const expected = { kind: 'handoff', reason: draft.outcome };

    expect(decideAction({ kind: 'handoff_outcome', draft })).toEqual(expected);
    expect(decideAction({ kind: 'handoff_outcome', draft })).not.toHaveProperty('aboutPrice');
    expect(decideAction(withText(draft, REVIEW_FAILED, 2))).toEqual(expected);
    expect(decideAction(withText(draft, REVIEW_FAILED, 2))).not.toHaveProperty('aboutPrice');
  });
});

describe('pipeline/decide: без проверки текст не уходит', () => {
  const FAILED_GATES: readonly [string, DraftGate][] = [
    ['проверки кодом не пройдены', CODE_FAILED],
    ['проверка вторым вызовом не пройдена', REVIEW_FAILED],
    ['проверка без замечаний не пройдена', REVIEW_FAILED_NO_PROBLEMS],
  ];

  it.each(FAILED_GATES)(
    '%s: ни ответ, ни сообщение передачи не уходят ни на одной попытке',
    (_c, gate) => {
      for (const attempt of [1, 2] as const) {
        for (const draft of [ANSWER, ...HANDOFF_OUTCOMES.map(handoffText)]) {
          const decision = decideAction(withText(draft, gate, attempt));

          expect(decision.kind).not.toBe('send');
          expect(decision).not.toHaveProperty('text');
        }
      }
    },
  );

  it('вход не меняется, ответ не делит массивы с входом', () => {
    const findings: [CheckFinding, ...CheckFinding[]] = [DASH];
    const input = withText(ANSWER, { kind: 'code_failed', findings });
    const before = structuredClone(input);

    const decision = decideAction(input);

    expect(input).toEqual(before);
    expect(decision.kind === 'retry' && decision.feedback).not.toBe(findings);
  });
});

describe('pipeline/decide: фиксированные вопросы о минимуме для передачи по цене', () => {
  const FIELDS = ['scope', 'itemCount', 'has1C', 'company', 'problem'] as const;

  it.each(FIELDS)(
    'вопрос о «%s» проходит проверки кодом: без цен, тире, ссылок, не длиннее трёх фраз',
    (field) => {
      const text = priceQuestion(field);

      expect(text).toBe(PRICE_QUESTION_TEXTS[field]);
      expect(runCodeChecks(normalizeDraft(text), { ownPhone: NO_PHONE, clientText: '' })).toEqual(
        [],
      );
    },
  );

  it.each(FIELDS)(
    'вопрос о «%s»: цена зависит от объёма, один вопрос и зачем он нужен',
    (field) => {
      const text = PRICE_QUESTION_TEXTS[field];

      expect(text.startsWith('Цена сильно зависит от объёма. ')).toBe(true);
      expect(text.split('?')).toHaveLength(2);
      expect(text.endsWith('Это нужно, чтобы коллега сразу назвал ориентир.')).toBe(true);
    },
  );
});
