import { describe, expect, it, vi, type Mock } from 'vitest';
import type { ConversationContext } from '../../../src/agent/agent.js';
import type { Logger } from '../../../src/domain/ports.js';
import type {
  ChatId,
  ClientProfile,
  InterestAssessment,
  InterestLevel,
  LlmResult,
  ReplyDraft,
  ReviewedText,
  ReviewResult,
  StoredMessage,
} from '../../../src/domain/types.js';
import {
  decideReply,
  requestDraft,
  type Drafted,
  type ReplyFlowDeps,
  type ReplyVerdict,
} from '../../../src/pipeline/reply-flow.js';

// Агент и репозиторий поддельные; шаги пишутся в общий журнал calls, по нему видно порядок.

const NOW = Date.UTC(2026, 9, 26, 9, 0, 0);
const CHAT_ID = 7 as ChatId;
const ANSWER = 'Учёт подбираем под задачу. Что вы храните?';
const SECOND_ANSWER = 'Цена зависит от задачи. Что вы хотите учитывать?';
const EMPTY_PROFILE: ClientProfile = {
  business: null,
  area: null,
  scope: null,
  itemCount: null,
  has1C: null,
  problem: null,
  specifics: null,
};

function historyOf(...clientTexts: readonly string[]): readonly StoredMessage[] {
  return clientTexts.map((text, index) => ({
    id: index + 1,
    chatId: CHAT_ID,
    author: 'client',
    kind: 'text',
    text,
    tsMs: NOW + index,
  }));
}

function contextOf(...clientTexts: readonly string[]): ConversationContext {
  const texts = clientTexts.length === 0 ? ['Сколько стоит?'] : clientTexts;
  return { chatId: CHAT_ID, history: historyOf(...texts), profile: EMPTY_PROFILE };
}

function answerDraft(text: string = ANSWER): LlmResult<ReplyDraft> {
  return { ok: true, value: { outcome: 'answer', text } };
}

function outcomeDraft(draft: Exclude<ReplyDraft, { outcome: 'answer' }>): LlmResult<ReplyDraft> {
  return { ok: true, value: draft };
}

function assessed(level: InterestLevel): { readonly ok: true; readonly value: InterestAssessment } {
  return {
    ok: true,
    value: { level, profile: { ...EMPTY_PROFILE, business: 'склад' }, reason: 'по разговору' },
  };
}

const REVIEW_OK: LlmResult<ReviewResult> = { ok: true, value: { ok: true } };

function reviewProblems(...problems: readonly string[]): LlmResult<ReviewResult> {
  return { ok: true, value: { ok: false, problems } };
}

const UNAVAILABLE = { ok: false, failure: 'unavailable' } as const;
const CHAT_LIMIT = { ok: false, failure: 'budget_exceeded', scope: 'chat' } as const;

interface Options {
  /** Ответы draftReply по порядку вызовов; последний повторяется. */
  readonly drafts?: readonly LlmResult<ReplyDraft>[];
  readonly reviews?: readonly LlmResult<ReviewResult>[];
  readonly assessment?: LlmResult<InterestAssessment>;
}

interface Harness {
  readonly deps: ReplyFlowDeps;
  readonly calls: string[];
  readonly logs: { readonly level: string; readonly context: unknown; readonly message?: string }[];
  readonly draftReply: Mock<ReplyFlowDeps['agent']['draftReply']>;
  readonly reviewDraft: Mock<ReplyFlowDeps['agent']['reviewDraft']>;
  readonly assessInterest: Mock<ReplyFlowDeps['agent']['assessInterest']>;
  readonly saveAssessment: Mock<ReplyFlowDeps['chats']['saveAssessment']>;
}

function createLogger(logs: Harness['logs']): Logger {
  const log =
    (level: string) =>
    (context: Readonly<Record<string, unknown>>, message?: string): void => {
      logs.push(message === undefined ? { level, context } : { level, context, message });
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
  return logger;
}

/** Следующий ответ из очереди; последний остаётся навсегда. */
function nextOf<T>(queue: T[]): T {
  const next = queue.length > 1 ? queue.shift() : queue[0];
  if (next === undefined) throw new Error('В тесте нет ответа для вызова');
  return next;
}

function setup(options: Options = {}): Harness {
  const calls: string[] = [];
  const logs: Harness['logs'] = [];
  const drafts = [...(options.drafts ?? [answerDraft()])];
  const reviews = [...(options.reviews ?? [REVIEW_OK])];
  const draftReply = vi.fn<ReplyFlowDeps['agent']['draftReply']>((_context, feedback) => {
    calls.push(feedback === undefined ? 'draft' : 'draft:retry');
    return Promise.resolve(nextOf(drafts));
  });
  const reviewDraft = vi.fn<ReplyFlowDeps['agent']['reviewDraft']>(() => {
    calls.push('review');
    return Promise.resolve(nextOf(reviews));
  });
  const assessInterest = vi.fn<ReplyFlowDeps['agent']['assessInterest']>(() => {
    calls.push('assess');
    return Promise.resolve(options.assessment ?? assessed('cold'));
  });
  const saveAssessment = vi.fn<ReplyFlowDeps['chats']['saveAssessment']>(() => {
    calls.push('save');
  });
  const deps: ReplyFlowDeps = {
    chats: { saveAssessment },
    agent: { draftReply, reviewDraft, assessInterest },
    clock: { now: () => NOW },
    logger: createLogger(logs),
  };
  return { deps, calls, logs, draftReply, reviewDraft, assessInterest, saveAssessment };
}

/** Весь ход ответа: черновик с оценкой параллельно, затем решение. */
async function flow(h: Harness, context: ConversationContext = contextOf()): Promise<ReplyVerdict> {
  const drafted = await requestDraft(h.deps, context);
  return decideReply(h.deps, context, drafted);
}

function sent(text: string = ANSWER): ReplyVerdict {
  return { kind: 'send', text: text as ReviewedText };
}

function handedOff(notice: Extract<ReplyVerdict, { kind: 'handoff' }>['notice']): ReplyVerdict {
  return { kind: 'handoff', notice };
}

function logsOf(h: Harness, level: string): unknown[] {
  return h.logs.filter((entry) => entry.level === level).map((entry) => entry.context);
}

describe('pipeline/reply-flow: черновик и оценка интереса параллельно', () => {
  it('оба вызова стартуют сразу, до ответа любого из них', async () => {
    const h = setup();

    const pending = requestDraft(h.deps, contextOf());

    expect(h.calls).toEqual(['draft', 'assess']);
    await pending;
  });

  it('вызовы получают контекст разговора, первый черновик без замечаний', async () => {
    const h = setup();
    const context = contextOf('Здравствуйте');

    await requestDraft(h.deps, context);

    expect(h.draftReply).toHaveBeenCalledWith(context);
    expect(h.assessInterest).toHaveBeenCalledWith(context);
  });

  it('итог: ответы обоих вызовов как есть', async () => {
    const h = setup({ drafts: [answerDraft()], assessment: assessed('warm') });

    const drafted = await requestDraft(h.deps, contextOf());

    expect(drafted).toEqual({ draft: answerDraft(), assessment: assessed('warm') });
  });

  it.each<[string, () => Promise<never>]>([
    ['исключение', () => Promise.reject(new TypeError('сбой'))],
    [
      'исключение сразу при вызове (заготовка)',
      () => {
        throw new TypeError('сбой');
      },
    ],
  ])(
    'оценка интереса: %s не мешает черновику, это сбой unavailable и предупреждение',
    async (_c, fails) => {
      const h = setup();
      h.assessInterest.mockImplementation(fails);

      const drafted = await requestDraft(h.deps, contextOf());

      expect(drafted).toEqual({ draft: answerDraft(), assessment: UNAVAILABLE });
      expect(logsOf(h, 'warn')).toEqual([{ chatId: CHAT_ID, errorName: 'TypeError' }]);
    },
  );

  it('черновик отклонился исключением: оно уходит наружу, оценка успевает завершиться', async () => {
    const h = setup();
    const failure = new Error('база недоступна');
    h.draftReply.mockRejectedValue(failure);

    await expect(requestDraft(h.deps, contextOf())).rejects.toBe(failure);

    expect(h.assessInterest).toHaveBeenCalledTimes(1);
  });
});

describe('pipeline/reply-flow: ответ проходит проверки', () => {
  it('проверки кодом, затем ревью того же текста: отправить; звонков API три, оценка сохранена', async () => {
    const h = setup();
    const context = contextOf();

    const verdict = await flow(h, context);

    expect(verdict).toEqual(sent());
    expect(h.calls).toEqual(['draft', 'assess', 'save', 'review']);
    expect(h.reviewDraft).toHaveBeenCalledWith(context, ANSWER);
    expect(h.saveAssessment).toHaveBeenCalledWith(CHAT_ID, assessed('cold').value, NOW);
  });

  it('невидимые символы убираются до проверок: ревью и клиент получают один и тот же текст', async () => {
    const dirty = 'Учёт​ подбираем под­ задачу. Что вы храните?';
    const h = setup({ drafts: [answerDraft(dirty)] });

    const verdict = await flow(h);

    expect(verdict).toEqual(sent(ANSWER));
    expect(h.reviewDraft).toHaveBeenCalledWith(expect.anything(), ANSWER);
  });

  it('стоп-слово, спрятанное невидимым символом, ловится после нормализации', async () => {
    const hidden = 'Это бес­платно для вас. Что вы храните?';
    const h = setup({ drafts: [answerDraft(hidden), answerDraft()] });

    const verdict = await flow(h);

    expect(verdict).toEqual(sent());
    expect(h.draftReply).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.arrayContaining([expect.stringContaining('стоп-слово')]),
    );
  });

  it('технический термин разрешён, если клиент написал его сам; иначе это нарушение', async () => {
    const draft = answerDraft('Метки бывают разные, UHF тоже подойдёт. Что вы храните?');
    const own = setup({ drafts: [draft] });
    const foreign = setup({ drafts: [draft, answerDraft()] });

    await expect(flow(own, contextOf('Нужны ли UHF метки?'))).resolves.toEqual(
      sent('Метки бывают разные, UHF тоже подойдёт. Что вы храните?'),
    );
    await flow(foreign, contextOf('Нужны ли метки?'));

    expect(foreign.draftReply).toHaveBeenCalledTimes(2);
  });

  it('любой номер телефона в ответе запрещён: своего номера у бота в ответах нет', async () => {
    const h = setup({
      drafts: [answerDraft('Напишите на +7 701 234 56 78, мы ответим.'), answerDraft()],
    });

    await flow(h);

    expect(h.draftReply).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.arrayContaining([expect.stringContaining('номер')]),
    );
  });
});

describe('pipeline/reply-flow: повтор с замечаниями', () => {
  it('нарушение кода: ревью не зовётся, повтор с описанием нарушения, второй черновик уходит', async () => {
    const h = setup({ drafts: [answerDraft('Учёт — это просто. Что вы храните?'), answerDraft()] });

    const verdict = await flow(h);

    expect(verdict).toEqual(sent());
    expect(h.calls).toEqual(['draft', 'assess', 'save', 'draft:retry', 'review']);
    const feedback = h.draftReply.mock.calls[1]?.[1] ?? [];
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toContain('тире');
  });

  it('ревью не пропустило: повтор с замечаниями проверки, оценка не запрашивается заново', async () => {
    const h = setup({
      drafts: [answerDraft(), answerDraft(SECOND_ANSWER)],
      reviews: [reviewProblems('Назван срок, его нет в знаниях'), REVIEW_OK],
    });

    const verdict = await flow(h);

    expect(verdict).toEqual(sent(SECOND_ANSWER));
    expect(h.draftReply.mock.calls[1]?.[1]).toEqual(['Назван срок, его нет в знаниях']);
    expect(h.assessInterest).toHaveBeenCalledTimes(1);
    expect(h.reviewDraft).toHaveBeenCalledTimes(2);
    expect(h.reviewDraft).toHaveBeenLastCalledWith(expect.anything(), SECOND_ANSWER);
  });

  it('второй провал ревью: check_failed, третьего черновика нет (всего пять звонков)', async () => {
    const h = setup({
      drafts: [answerDraft(), answerDraft(SECOND_ANSWER)],
      reviews: [reviewProblems('первое'), reviewProblems('второе')],
    });

    const verdict = await flow(h);

    expect(verdict).toEqual(handedOff({ reason: 'check_failed' }));
    expect(h.calls).toEqual(['draft', 'assess', 'save', 'review', 'draft:retry', 'review']);
  });

  it('повтор снова с нарушением кода: check_failed, второго ревью нет', async () => {
    const dashed = answerDraft('Учёт — это просто. Что вы храните?');
    const h = setup({ drafts: [dashed, dashed] });

    const verdict = await flow(h);

    expect(verdict).toEqual(handedOff({ reason: 'check_failed' }));
    expect(h.reviewDraft).not.toHaveBeenCalled();
  });

  it('в повторе модель передала вопрос специалисту: передача по новому исходу', async () => {
    const h = setup({
      drafts: [answerDraft(), outcomeDraft({ outcome: 'no_answer' })],
      reviews: [reviewProblems('нет в знаниях')],
    });

    await expect(flow(h)).resolves.toEqual(handedOff({ reason: 'no_answer' }));
  });

  it.each<[string, LlmResult<ReplyDraft>, ReplyVerdict]>([
    ['сбой', UNAVAILABLE, handedOff({ reason: 'llm_error' })],
    ['лимит', CHAT_LIMIT, { kind: 'limit', scope: 'chat' }],
  ])('повторный черновик: %s', async (_case, retried, expected) => {
    const h = setup({ drafts: [answerDraft(), retried], reviews: [reviewProblems('нет')] });

    await expect(flow(h)).resolves.toEqual(expected);
  });
});

describe('pipeline/reply-flow: передача без ответа клиенту', () => {
  it.each<[string, Exclude<ReplyDraft, { outcome: 'answer' }>, ReplyVerdict]>([
    ['нет ответа', { outcome: 'no_answer' }, handedOff({ reason: 'no_answer' })],
    ['просит человека', { outcome: 'asked_human' }, handedOff({ reason: 'asked_human' })],
    [
      'жалоба',
      { outcome: 'complaint', stopRequested: true },
      handedOff({ reason: 'complaint', stopRequested: true }),
    ],
  ])('%s: проверок нет, оценка сохранена до передачи', async (_case, draft, expected) => {
    const h = setup({ drafts: [outcomeDraft(draft)] });

    const verdict = await flow(h);

    expect(verdict).toEqual(expected);
    expect(h.calls).toEqual(['draft', 'assess', 'save']);
  });

  it('горячий клиент: передача hot, текст ответа не уходит, оценка (уровень hot) сохранена', async () => {
    const h = setup({ assessment: assessed('hot') });

    const verdict = await flow(h);

    expect(verdict).toEqual(handedOff({ reason: 'hot' }));
    expect(h.saveAssessment).toHaveBeenCalledWith(
      CHAT_ID,
      expect.objectContaining({ level: 'hot' }),
      NOW,
    );
  });

  it('горячий клиент и нарушение кода: сразу hot, повтора нет', async () => {
    const h = setup({
      drafts: [answerDraft('Учёт — это просто. Что вы храните?')],
      assessment: assessed('hot'),
    });

    await expect(flow(h)).resolves.toEqual(handedOff({ reason: 'hot' }));
    expect(h.draftReply).toHaveBeenCalledTimes(1);
  });
});

describe('pipeline/reply-flow: сбои LLM и лимиты (fail-closed)', () => {
  it.each([
    'refusal',
    'truncated',
    'invalid_output',
    'rate_limited',
    'unavailable',
    'disabled',
  ] as const)(
    'черновик: сбой %s => передача llm_error, предупреждение без текста',
    async (failure) => {
      const h = setup({ drafts: [{ ok: false, failure }] });

      const verdict = await flow(h);

      expect(verdict).toEqual(handedOff({ reason: 'llm_error' }));
      expect(logsOf(h, 'warn')).toContainEqual({ chatId: CHAT_ID, failure });
      expect(h.reviewDraft).not.toHaveBeenCalled();
    },
  );

  it('проверка черновика не получена: llm_error, текст модели без ревью не уходит', async () => {
    const h = setup({ reviews: [UNAVAILABLE] });

    const verdict = await flow(h);

    expect(verdict).toEqual(handedOff({ reason: 'llm_error' }));
    expect(logsOf(h, 'warn')).toContainEqual({ chatId: CHAT_ID, failure: 'unavailable' });
  });

  it('дневной лимит на черновике: limit со scope, оценка при этом сохраняется', async () => {
    const h = setup({ drafts: [CHAT_LIMIT] });

    const verdict = await flow(h);

    expect(verdict).toEqual({ kind: 'limit', scope: 'chat' });
    expect(h.saveAssessment).toHaveBeenCalledTimes(1);
  });

  it('дневной лимит на проверке: limit со scope', async () => {
    const h = setup({ reviews: [{ ok: false, failure: 'budget_exceeded', scope: 'global' }] });

    await expect(flow(h)).resolves.toEqual({ kind: 'limit', scope: 'global' });
  });

  it('дневной лимит на оценке интереса: limit, черновик не уходит и проверки не зовутся', async () => {
    const h = setup({ assessment: { ok: false, failure: 'budget_exceeded', scope: 'global' } });

    const verdict = await flow(h);

    expect(verdict).toEqual({ kind: 'limit', scope: 'global' });
    expect(h.reviewDraft).not.toHaveBeenCalled();
    expect(h.saveAssessment).not.toHaveBeenCalled();
  });

  it('другой сбой оценки интереса не останавливает ответ: предупреждение и обычная отправка', async () => {
    const h = setup({ assessment: { ok: false, failure: 'invalid_output' } });

    const verdict = await flow(h);

    expect(verdict).toEqual(sent());
    expect(h.saveAssessment).not.toHaveBeenCalled();
    expect(logsOf(h, 'warn')).toContainEqual({ chatId: CHAT_ID, failure: 'invalid_output' });
  });

  it('сбой оценки не прячет горячего клиента: без оценки передачи hot нет, ответ идёт по проверкам', async () => {
    const h = setup({ assessment: UNAVAILABLE });

    await expect(flow(h)).resolves.toEqual(sent());
  });
});

describe('pipeline/reply-flow: логи без текста', () => {
  it('нарушения кода и замечания ревью в логе только числом и видом, без фрагментов текста', async () => {
    const secret = 'УникальнаяФразаКлиента';
    const h = setup({
      drafts: [
        answerDraft(`Учёт — это ${secret}. Что вы храните?`),
        answerDraft(`Срок зависит от ${secret}. Что вы храните?`),
      ],
      reviews: [reviewProblems(`Срок ${secret}`), REVIEW_OK],
    });

    await flow(h, contextOf(secret));

    expect(logsOf(h, 'info')).toContainEqual({ chatId: CHAT_ID, attempt: 1, codes: ['dash'] });
    expect(JSON.stringify(h.logs)).not.toContain(secret);
  });
});

describe('pipeline/reply-flow: форма входных данных', () => {
  it('Drafted не обязателен снаружи: decideReply работает с готовой парой ответов', async () => {
    const h = setup();
    const drafted: Drafted = { draft: answerDraft(), assessment: assessed('warm') };

    await expect(decideReply(h.deps, contextOf(), drafted)).resolves.toEqual(sent());
    expect(h.assessInterest).not.toHaveBeenCalled();
    expect(h.draftReply).not.toHaveBeenCalled();
  });
});
