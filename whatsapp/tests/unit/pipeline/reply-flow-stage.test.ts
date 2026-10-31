import { describe, expect, it, vi } from 'vitest';
import type { ConversationContext } from '../../../src/agent/agent.js';
import type { Logger } from '../../../src/domain/ports.js';
import type {
  ChatId,
  ChatProgress,
  ClientProfile,
  LlmResult,
  ReplyDraft,
  ReviewResult,
} from '../../../src/domain/types.js';
import {
  decideReply,
  requestDraft,
  type ReplyFlowDeps,
  type ReplyVerdict,
} from '../../../src/pipeline/reply-flow.js';

// Этап и рассказанные сильные стороны (30.10.2026): вердикт send несёт отметки черновика, чей текст уходит, только
// если уходит текст модели; повтор уже рассказанного ловит проверка кодом.

const NOW = Date.UTC(2026, 9, 30, 9, 0, 0);
const CHAT_ID = 7 as ChatId;
const ANSWER =
  'Ручной сканер видит сотни меток за секунду. Расскажите, что у вас лежит на хранении?';
const SECOND =
  'Антенны на входе сами отмечают приход. Расскажите, сколько проходов нужно учитывать?';
const HANDOFF_TEXT = 'Да, интеграцию с вашей 1С проводим. Уточню у коллеги и вернусь к вам.';
const EMPTY_PROFILE: ClientProfile = {
  business: null,
  items: null,
  packaging: null,
  material: null,
  city: null,
  premises: null,
  area: null,
  scope: null,
  itemCount: null,
  monthlyIntake: null,
  turnover: null,
  passages: null,
  shelfRecount: null,
  currentTracking: null,
  has1C: null,
  oneCName: null,
  problem: null,
  specifics: null,
  problemAgreed: false,
  inferred: [],
};
const REVIEW_OK: LlmResult<ReviewResult> = { ok: true, value: { ok: true } };
const SILENT: Logger = {
  level: 'silent',
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  silent: () => undefined,
  child: () => SILENT,
};

function draft(value: ReplyDraft): LlmResult<ReplyDraft> {
  return { ok: true, value };
}

function contextOf(progress?: ChatProgress): ConversationContext {
  return {
    chatId: CHAT_ID,
    history: [
      { id: 1, chatId: CHAT_ID, author: 'client', kind: 'text', text: 'Мы банк', tsMs: NOW },
    ],
    profile: { ...EMPTY_PROFILE, business: 'банк' },
    ...(progress === undefined ? {} : { progress }),
  };
}

function setup(
  drafts: readonly LlmResult<ReplyDraft>[],
  reviews: readonly LlmResult<ReviewResult>[] = [REVIEW_OK],
) {
  const calls: string[] = [];
  const queue = [...drafts];
  const reviewQueue = [...reviews];
  const next = <T>(items: T[]): T => {
    const item = items.length > 1 ? items.shift() : items[0];
    if (item === undefined) throw new Error('В тесте нет ответа для вызова');
    return item;
  };
  const feedbacks: (readonly string[] | undefined)[] = [];
  const deps: ReplyFlowDeps = {
    chats: { saveAssessment: vi.fn() },
    agent: {
      draftReply: vi.fn<ReplyFlowDeps['agent']['draftReply']>((_context, feedback) => {
        calls.push(feedback === undefined ? 'draft' : 'draft:retry');
        feedbacks.push(feedback);
        return Promise.resolve(next(queue));
      }),
      reviewDraft: vi.fn(() => {
        calls.push('review');
        return Promise.resolve(next(reviewQueue));
      }),
      assessInterest: vi.fn(() => {
        calls.push('assess');
        return Promise.resolve({ ok: false, failure: 'unavailable' } as const);
      }),
    },
    clock: { now: () => NOW },
    logger: SILENT,
  };
  return { deps, calls, feedbacks };
}

async function flow(
  h: ReturnType<typeof setup>,
  context: ConversationContext = contextOf(),
): Promise<ReplyVerdict> {
  return decideReply(h.deps, context, await requestDraft(h.deps, context));
}

describe('pipeline/reply-flow: отметки отправленного ответа (этап и сильные стороны)', () => {
  it('ответ модели уходит: в вердикте этап и номера сильных сторон этого черновика', async () => {
    const h = setup([draft({ outcome: 'answer', text: ANSWER, stage: 'hook', usedFacts: ['F4'] })]);

    expect(await flow(h)).toEqual({
      kind: 'send',
      text: ANSWER,
      marks: { stage: 'hook', usedFacts: ['F4'] },
    });
  });

  it('черновик без этапа и сильных сторон (подделка): отметок нет', async () => {
    const h = setup([draft({ outcome: 'answer', text: ANSWER })]);

    const verdict = await flow(h);

    expect(verdict).toEqual({ kind: 'send', text: ANSWER });
    expect(verdict).not.toHaveProperty('marks');
  });

  it('этап без сильных сторон: отметка с пустым списком; сильные стороны без этапа: этап null', async () => {
    const staged = await flow(setup([draft({ outcome: 'answer', text: ANSWER, stage: 'intro' })]));
    const facts = await flow(
      setup([draft({ outcome: 'answer', text: ANSWER, usedFacts: ['F1'] })]),
    );

    expect(staged).toMatchObject({ marks: { stage: 'intro', usedFacts: [] } });
    expect(facts).toMatchObject({ marks: { stage: null, usedFacts: ['F1'] } });
  });

  it('первый черновик отклонён проверкой: отметки берутся у повтора, чей текст ушёл', async () => {
    const h = setup(
      [
        draft({ outcome: 'answer', text: ANSWER, stage: 'hook', usedFacts: ['F4'] }),
        draft({ outcome: 'answer', text: SECOND, stage: 'details', usedFacts: ['F3'] }),
      ],
      [{ ok: true, value: { ok: false, problems: ['Назван срок'] } }, REVIEW_OK],
    );

    expect(await flow(h)).toEqual({
      kind: 'send',
      text: SECOND,
      marks: { stage: 'details', usedFacts: ['F3'] },
    });
  });

  it('безопасный вопрос вместо дважды отклонённого черновика: фиксированная фраза без отметок', async () => {
    const dashed = draft({
      outcome: 'answer',
      text: 'Метки — это просто. Что храните?',
      stage: 'explain',
      usedFacts: ['F1'],
    });
    const h = setup([dashed]);

    const verdict = await flow(h);

    expect(verdict.kind).toBe('send');
    expect(verdict).not.toHaveProperty('marks');
  });
});

describe('pipeline/reply-flow: повтор уже рассказанной сильной стороны (30.10.2026, 01.11.2026)', () => {
  it('рассказанная подана снова: проверка кодом, повтор с замечанием, уходит черновик без сильной стороны', async () => {
    const h = setup([
      draft({ outcome: 'answer', text: ANSWER, stage: 'details', usedFacts: ['F4'] }),
      draft({ outcome: 'answer', text: SECOND, stage: 'details' }),
    ]);

    const verdict = await flow(h, contextOf({ priceAsks: 0, refused: false, toldFacts: ['F4'] }));

    expect(h.calls).toEqual(['assess', 'draft', 'draft:retry', 'review']);
    expect(h.feedbacks[1]?.join(' ')).toBe(
      'сильная сторона уже звучала в этом чате: «ручной сканер». Не подавай это снова как новость. Новая сильная сторона не обязательна, без неё тоже хорошо',
    );
    expect(verdict).toEqual({
      kind: 'send',
      text: SECOND,
      marks: { stage: 'details', usedFacts: [] },
    });
  });

  it('сильной стороны нет совсем: проверка кодом её не требует, черновик уходит сразу', async () => {
    const h = setup([draft({ outcome: 'answer', text: ANSWER, stage: 'details' })]);

    const verdict = await flow(
      h,
      contextOf({ priceAsks: 0, refused: false, toldFacts: ['F2', 'F3', 'F4'] }),
    );

    expect(h.calls).toEqual(['assess', 'draft', 'review']);
    expect(verdict).toEqual({
      kind: 'send',
      text: ANSWER,
      marks: { stage: 'details', usedFacts: [] },
    });
  });

  it('сообщение о передаче чата повтор не проверяет: передача идёт как раньше', async () => {
    const h = setup([
      draft({ outcome: 'no_answer', text: HANDOFF_TEXT, stage: 'details', usedFacts: ['F6'] }),
    ]);

    const verdict = await flow(h, contextOf({ priceAsks: 0, refused: false, toldFacts: ['F6'] }));

    expect(h.calls).toEqual(['assess', 'draft', 'review']);
    expect(verdict).toEqual({
      kind: 'handoff',
      notice: { reason: 'no_answer' },
      text: HANDOFF_TEXT,
      detail: expect.stringMatching(/^Ответа нет в документах/) as unknown,
    });
  });
});
