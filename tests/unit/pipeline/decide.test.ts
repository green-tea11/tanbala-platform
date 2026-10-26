import { describe, expect, it } from 'vitest';
import type { CheckFinding } from '../../../src/checks/code-checks.js';
import type {
  ClientProfile,
  InterestAssessment,
  InterestLevel,
  ReplyDraft,
  ReviewedText,
} from '../../../src/domain/types.js';
import {
  decideAction,
  type Decision,
  type DecisionInput,
  type DraftGate,
} from '../../../src/pipeline/decide.js';

const TEXT = 'Учёт подбираем под задачу. Что вы храните?';
const EMPTY_PROFILE: ClientProfile = {
  business: null,
  area: null,
  scope: null,
  itemCount: null,
  has1C: null,
  problem: null,
  specifics: null,
};
const DASH: CheckFinding = { code: 'dash', detail: 'тире: «—» в «…учёт — это…»' };
const PRICE: CheckFinding = { code: 'price', detail: 'цена: «5 000 тг» в «…стоит 5 000 тг…»' };

const PASSED: DraftGate = { kind: 'reviewed', review: { ok: true } };
const CODE_FAILED: DraftGate = { kind: 'code_failed', findings: [DASH, PRICE] };
const REVIEW_FAILED: DraftGate = {
  kind: 'reviewed',
  review: { ok: false, problems: ['Названа цена, её нет в знаниях', 'Обещан срок'] },
};

function assessment(level: InterestLevel): InterestAssessment {
  return { level, profile: EMPTY_PROFILE, reason: 'по разговору' };
}

function answer(
  gate: DraftGate,
  attempt: 1 | 2 = 1,
  assessed: InterestAssessment | null = null,
): DecisionInput {
  return {
    kind: 'answer',
    draft: { outcome: 'answer', text: TEXT },
    gate,
    attempt,
    assessment: assessed,
  };
}

function outcome(
  draft: Exclude<ReplyDraft, { outcome: 'answer' }>,
  level?: InterestLevel,
): DecisionInput {
  return {
    kind: 'handoff_outcome',
    draft,
    assessment: level === undefined ? null : assessment(level),
  };
}

describe('pipeline/decide: исходы без ответа клиенту', () => {
  it.each<[string, Exclude<ReplyDraft, { outcome: 'answer' }>, Decision]>([
    ['нет ответа в знаниях', { outcome: 'no_answer' }, { kind: 'handoff', reason: 'no_answer' }],
    ['просит человека', { outcome: 'asked_human' }, { kind: 'handoff', reason: 'asked_human' }],
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
  ])('%s: передача по своей причине', (_case, draft, expected) => {
    expect(decideAction(outcome(draft))).toEqual(expected);
  });

  it('горячий клиент не подменяет причину: нет ответа остаётся no_answer', () => {
    expect(decideAction(outcome({ outcome: 'no_answer' }, 'hot'))).toEqual({
      kind: 'handoff',
      reason: 'no_answer',
    });
  });
});

describe('pipeline/decide: ответ answer', () => {
  it.each<[string, InterestAssessment | null]>([
    ['оценки нет', null],
    ['холодный', assessment('cold')],
    ['тёплый', assessment('warm')],
  ])('проверки пройдены, клиент не горячий (%s): отправить тот же текст', (_case, assessed) => {
    const decision = decideAction(answer(PASSED, 1, assessed));

    expect(decision).toEqual({ kind: 'send', text: TEXT as ReviewedText });
  });

  it('горячий клиент: передача hot вместо отправки, клиенту одна фраза передачи', () => {
    expect(decideAction(answer(PASSED, 1, assessment('hot')))).toEqual({
      kind: 'handoff',
      reason: 'hot',
    });
  });

  it.each<[string, DraftGate, 1 | 2]>([
    ['проверки кодом не пройдены, попытка 1', CODE_FAILED, 1],
    ['проверка не пройдена, попытка 2', REVIEW_FAILED, 2],
  ])('горячий клиент важнее неудачной проверки (%s): повтора нет, передача hot', (_c, gate, n) => {
    expect(decideAction(answer(gate, n, assessment('hot')))).toEqual({
      kind: 'handoff',
      reason: 'hot',
    });
  });
});

describe('pipeline/decide: повтор и check_failed', () => {
  it('проверки кодом не пройдены на попытке 1: повтор с описанием нарушений по порядку', () => {
    expect(decideAction(answer(CODE_FAILED, 1))).toEqual({
      kind: 'retry',
      feedback: [DASH.detail, PRICE.detail],
    });
  });

  it('проверка вторым вызовом не пройдена на попытке 1: повтор с замечаниями проверки', () => {
    expect(decideAction(answer(REVIEW_FAILED, 1))).toEqual({
      kind: 'retry',
      feedback: ['Названа цена, её нет в знаниях', 'Обещан срок'],
    });
  });

  it('проверка не пройдена без замечаний: повтор всё равно с непустым замечанием', () => {
    const decision = decideAction(
      answer({ kind: 'reviewed', review: { ok: false, problems: [] } }),
    );

    expect(decision.kind).toBe('retry');
    expect(decision.kind === 'retry' && decision.feedback.length).toBe(1);
    expect(decision.kind === 'retry' && decision.feedback[0]?.trim()).not.toBe('');
  });

  it.each<[string, DraftGate]>([
    ['проверки кодом', CODE_FAILED],
    ['проверка вторым вызовом', REVIEW_FAILED],
  ])('%s не пройдены на попытке 2: передача check_failed, третьей попытки нет', (_case, gate) => {
    expect(decideAction(answer(gate, 2))).toEqual({ kind: 'handoff', reason: 'check_failed' });
  });
});

describe('pipeline/decide: без проверки текст не уходит', () => {
  it.each<[string, DraftGate]>([
    ['проверки кодом не пройдены', CODE_FAILED],
    ['проверка вторым вызовом не пройдена', REVIEW_FAILED],
    [
      'проверка без замечаний не пройдена',
      { kind: 'reviewed', review: { ok: false, problems: [] } },
    ],
  ])('%s: ни на одной попытке не send', (_case, gate) => {
    for (const attempt of [1, 2] as const) {
      for (const assessed of [null, assessment('cold'), assessment('warm'), assessment('hot')]) {
        expect(decideAction(answer(gate, attempt, assessed)).kind).not.toBe('send');
      }
    }
  });

  it('вход не меняется, ответ не делит массивы с входом', () => {
    const findings: [CheckFinding, ...CheckFinding[]] = [DASH];
    const input = answer({ kind: 'code_failed', findings });
    const before = structuredClone(input);

    const decision = decideAction(input);

    expect(input).toEqual(before);
    expect(decision.kind === 'retry' && decision.feedback).not.toBe(findings);
  });
});
