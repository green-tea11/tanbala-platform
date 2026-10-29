import { describe, expect, it, vi, type Mock } from 'vitest';
import type { ConversationContext } from '../../../src/agent/agent.js';
import type { CompanyPrompt } from '../../../src/domain/company.js';
import type { Logger } from '../../../src/domain/ports.js';
import type {
  ChatId,
  ClientProfile,
  InterestAssessment,
  InterestLevel,
  LlmResult,
  ReplyDraft,
  ReplyHandoffOutcome,
  ReviewedText,
  ReviewResult,
  StoredMessage,
} from '../../../src/domain/types.js';
import {
  decideReply,
  requestAssessment,
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
const HANDOFF_TEXT = 'Да, интеграцию с вашей 1С проводим. Уточню у коллеги и вернусь к вам.';
const SECOND_HANDOFF_TEXT = 'Интеграцию проводим. Уточню у коллеги и вернусь к вам.';
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

/** Исход передачи (hot, no_answer, asked_human), у которого модель написала сообщение клиенту. */
function handoffDraft(
  outcome: ReplyHandoffOutcome,
  text: string = HANDOFF_TEXT,
): LlmResult<ReplyDraft> {
  return { ok: true, value: { outcome, text } };
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

/** Передача, при которой клиенту уходит проверенный текст модели вместо фиксированной фразы. */
function handedOffWithText(reason: ReplyHandoffOutcome, text: string = HANDOFF_TEXT): ReplyVerdict {
  return { kind: 'handoff', notice: { reason }, text: text as ReviewedText };
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

  it('оценка интереса: брошена не ошибка, а строка: в лог идёт только тип значения', async () => {
    const h = setup();
    const thrown: unknown = 'номер 77000000001';
    h.assessInterest.mockImplementation(() => {
      throw thrown;
    });

    const drafted = await requestDraft(h.deps, contextOf());

    expect(drafted.assessment).toEqual(UNAVAILABLE);
    expect(logsOf(h, 'warn')).toEqual([{ chatId: CHAT_ID, errorName: 'string' }]);
    expect(JSON.stringify(h.logs)).not.toContain('77000000001');
  });

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
    expect(h.reviewDraft).toHaveBeenCalledWith(context, ANSWER, 'answer');
    expect(h.saveAssessment).toHaveBeenCalledWith(CHAT_ID, assessed('cold').value, NOW);
  });

  it('невидимые символы убираются до проверок: ревью и клиент получают один и тот же текст', async () => {
    const dirty = 'Учёт\u200B подбираем под\u00AD задачу. Что вы храните?';
    const h = setup({ drafts: [answerDraft(dirty)] });

    const verdict = await flow(h);

    expect(verdict).toEqual(sent(ANSWER));
    expect(h.reviewDraft).toHaveBeenCalledWith(expect.anything(), ANSWER, 'answer');
  });

  it('стоп-слово, спрятанное невидимым символом, ловится после нормализации', async () => {
    const hidden = 'Это бес\u00ADплатно для вас. Что вы храните?';
    const h = setup({ drafts: [answerDraft(hidden), answerDraft()] });

    const verdict = await flow(h);

    expect(verdict).toEqual(sent());
    expect(h.draftReply).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.arrayContaining([expect.stringContaining('стоп-слово')]),
    );
  });

  it('сообщения клиента без текста (картинка) в истории не мешают проверкам кодом', async () => {
    const h = setup();
    const context = contextOf('Вот фото');
    const withPicture: ConversationContext = {
      ...context,
      history: [
        ...context.history,
        { id: 2, chatId: CHAT_ID, author: 'client', kind: 'other', text: null, tsMs: NOW + 1 },
      ],
    };

    await expect(flow(h, withPicture)).resolves.toEqual(sent());
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
    expect(h.reviewDraft).toHaveBeenLastCalledWith(expect.anything(), SECOND_ANSWER, 'answer');
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

  it('в повторе модель передала вопрос коллеге: передача по новому исходу', async () => {
    const h = setup({
      drafts: [answerDraft(), outcomeDraft({ outcome: 'no_answer', text: '' })],
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

describe('pipeline/reply-flow: передача без текста модели (фиксированная фраза)', () => {
  it.each<[string, Exclude<ReplyDraft, { outcome: 'answer' }>, ReplyVerdict]>([
    [
      'нет ответа, текста нет',
      { outcome: 'no_answer', text: '' },
      handedOff({ reason: 'no_answer' }),
    ],
    [
      'просит человека, текста нет',
      { outcome: 'asked_human', text: '' },
      handedOff({ reason: 'asked_human' }),
    ],
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

  it.each(['hot', 'no_answer', 'asked_human'] as const)(
    '%s: текст из одних невидимых символов это нет текста, ревью не зовётся',
    async (outcome) => {
      const h = setup({ drafts: [handoffDraft(outcome, '​­')] });

      const verdict = await flow(h);

      expect(verdict).toEqual(handedOff({ reason: outcome }));
      expect(h.reviewDraft).not.toHaveBeenCalled();
      expect(h.draftReply).toHaveBeenCalledTimes(1);
    },
  );

  it('горячий клиент без текста: фиксированная фраза hot, проверок нет, уровень hot записан в чат', async () => {
    const h = setup({ drafts: [handoffDraft('hot', '')], assessment: assessed('warm') });

    const verdict = await flow(h);

    expect(verdict).toEqual(handedOff({ reason: 'hot' }));
    expect(h.calls).toEqual(['draft', 'assess', 'save', 'save']);
    expect(h.saveAssessment).toHaveBeenLastCalledWith(
      CHAT_ID,
      expect.objectContaining({ level: 'hot' }),
      NOW,
    );
  });
});

describe('pipeline/reply-flow: передачу решает вызов ответа, а не оценка интереса', () => {
  it('оценка интереса hot, а черновик answer: передачи нет, ответ идёт по проверкам и уходит', async () => {
    const h = setup({ assessment: assessed('hot') });

    const verdict = await flow(h);

    expect(verdict).toEqual(sent());
    expect(h.calls).toEqual(['draft', 'assess', 'save', 'review']);
    expect(h.reviewDraft).toHaveBeenCalledWith(expect.anything(), ANSWER, 'answer');
    expect(h.saveAssessment).toHaveBeenCalledTimes(1);
    expect(h.saveAssessment).toHaveBeenCalledWith(
      CHAT_ID,
      expect.objectContaining({ level: 'hot' }),
      NOW,
    );
  });

  it('оценка интереса hot и нарушение кода в ответе: повтор с замечанием, как у любого клиента', async () => {
    const h = setup({
      drafts: [answerDraft('Учёт — это просто. Что вы храните?'), answerDraft()],
      assessment: assessed('hot'),
    });

    await expect(flow(h)).resolves.toEqual(sent());
    expect(h.draftReply).toHaveBeenCalledTimes(2);
    expect(h.reviewDraft).toHaveBeenCalledTimes(1);
  });

  it('оценка интереса hot и второй провал ревью ответа: check_failed, а не hot', async () => {
    const h = setup({
      drafts: [answerDraft(), answerDraft(SECOND_ANSWER)],
      reviews: [reviewProblems('первое'), reviewProblems('второе')],
      assessment: assessed('hot'),
    });

    await expect(flow(h)).resolves.toEqual(handedOff({ reason: 'check_failed' }));
  });

  it('клиент не горячий: ревью зовётся как обычно', async () => {
    const h = setup({ assessment: assessed('warm') });

    await expect(flow(h)).resolves.toEqual(sent());
    expect(h.reviewDraft).toHaveBeenCalledTimes(1);
  });
});

describe('pipeline/reply-flow: сообщение о передаче (hot, no_answer, asked_human с текстом)', () => {
  it.each(['hot', 'no_answer', 'asked_human'] as const)(
    '%s: те же проверки, ревью как сообщения о передаче, передача с причиной и этим текстом',
    async (outcome) => {
      const h = setup({ drafts: [handoffDraft(outcome)] });
      const context = contextOf();

      const verdict = await flow(h, context);

      expect(verdict).toEqual(handedOffWithText(outcome));
      expect(h.reviewDraft).toHaveBeenCalledTimes(1);
      expect(h.reviewDraft).toHaveBeenCalledWith(context, HANDOFF_TEXT, 'handoff');
      expect(h.draftReply).toHaveBeenCalledTimes(1);
    },
  );

  it('диалог про 1С: ответ из знаний и фраза о передаче проходят проверки кода и уходят одним текстом', async () => {
    const text =
      'Да, мы проводим интеграцию с вашей 1С, детали решаем по вашей конфигурации. Стоимость зависит от вашей задачи, уточню у коллеги и вернусь к вам.';
    const h = setup({ drafts: [handoffDraft('hot', text)], assessment: assessed('warm') });

    const verdict = await flow(h, contextOf('11 000 м², сколько будет стоить, у нас 1С'));

    expect(verdict).toEqual(handedOffWithText('hot', text));
    expect(h.reviewDraft).toHaveBeenCalledWith(expect.anything(), text, 'handoff');
    expect(h.calls).toEqual(['draft', 'assess', 'save', 'review', 'save']);
  });

  it('невидимые символы убираются до проверок: ревью и клиент получают один и тот же текст', async () => {
    const dirty = 'Да, интеграцию с вашей 1С проводим. Уточню​ у коллеги и вернусь к вам.';
    const h = setup({ drafts: [handoffDraft('hot', dirty)] });

    const verdict = await flow(h);

    expect(verdict).toEqual(handedOffWithText('hot'));
    expect(h.reviewDraft).toHaveBeenCalledWith(expect.anything(), HANDOFF_TEXT, 'handoff');
  });

  it('нарушение кода в сообщении передачи: ревью не зовётся, повтор с описанием, второй текст уходит', async () => {
    const dashed = 'Интеграцию — проводим. Уточню у коллеги и вернусь к вам.';
    const h = setup({
      drafts: [handoffDraft('hot', dashed), handoffDraft('hot', SECOND_HANDOFF_TEXT)],
    });

    const verdict = await flow(h);

    expect(verdict).toEqual(handedOffWithText('hot', SECOND_HANDOFF_TEXT));
    expect(h.calls).toEqual(['draft', 'assess', 'save', 'draft:retry', 'review', 'save']);
    expect(h.draftReply.mock.calls[1]?.[1]?.[0]).toContain('тире');
  });

  it('обещание времени в сообщении передачи ловит код: «ответит сегодня» нельзя, повтор', async () => {
    const promise = 'Коллега вам ответит сегодня.';
    const h = setup({
      drafts: [handoffDraft('asked_human', promise), handoffDraft('asked_human')],
    });

    const verdict = await flow(h);

    expect(verdict).toEqual(handedOffWithText('asked_human'));
    expect(h.draftReply.mock.calls[1]?.[1]?.[0]).toContain('стоп-слово');
  });

  it('ревью не пропустило: повтор с замечаниями проверки, второй текст уходит', async () => {
    const h = setup({
      drafts: [handoffDraft('no_answer'), handoffDraft('no_answer', SECOND_HANDOFF_TEXT)],
      reviews: [reviewProblems('Назван срок, его нет в знаниях'), REVIEW_OK],
    });

    const verdict = await flow(h);

    expect(verdict).toEqual(handedOffWithText('no_answer', SECOND_HANDOFF_TEXT));
    expect(h.draftReply.mock.calls[1]?.[1]).toEqual(['Назван срок, его нет в знаниях']);
    expect(h.reviewDraft).toHaveBeenLastCalledWith(
      expect.anything(),
      SECOND_HANDOFF_TEXT,
      'handoff',
    );
    expect(h.assessInterest).toHaveBeenCalledTimes(1);
  });

  it.each(['hot', 'no_answer', 'asked_human'] as const)(
    '%s: второй провал ревью даёт ту же причину и фиксированную фразу, а не check_failed',
    async (outcome) => {
      const h = setup({
        drafts: [handoffDraft(outcome), handoffDraft(outcome, SECOND_HANDOFF_TEXT)],
        reviews: [reviewProblems('первое'), reviewProblems('второе')],
      });

      const verdict = await flow(h);

      expect(verdict).toEqual(handedOff({ reason: outcome }));
      expect(verdict).not.toHaveProperty('text');
      expect(h.reviewDraft).toHaveBeenCalledTimes(2);
      expect(h.draftReply).toHaveBeenCalledTimes(2);
    },
  );

  it('повтор снова с нарушением кода: та же причина без текста, второго ревью нет', async () => {
    const dashed = handoffDraft('hot', 'Интеграцию — проводим. Уточню у коллеги и вернусь к вам.');
    const h = setup({ drafts: [dashed, dashed] });

    const verdict = await flow(h);

    expect(verdict).toEqual(handedOff({ reason: 'hot' }));
    expect(h.reviewDraft).not.toHaveBeenCalled();
  });

  it('повтор без текста: фиксированная фраза с той же причиной', async () => {
    const h = setup({
      drafts: [handoffDraft('asked_human'), handoffDraft('asked_human', '')],
      reviews: [reviewProblems('нет в знаниях')],
    });

    await expect(flow(h)).resolves.toEqual(handedOff({ reason: 'asked_human' }));
    expect(h.reviewDraft).toHaveBeenCalledTimes(1);
  });

  it('после hot модель в повторе пишет answer: ответ проверяется как обычный и уходит', async () => {
    const h = setup({
      drafts: [handoffDraft('hot'), answerDraft(SECOND_ANSWER)],
      reviews: [reviewProblems('Обещан срок'), REVIEW_OK],
    });

    const verdict = await flow(h);

    expect(verdict).toEqual(sent(SECOND_ANSWER));
    expect(h.reviewDraft).toHaveBeenNthCalledWith(1, expect.anything(), HANDOFF_TEXT, 'handoff');
    expect(h.reviewDraft).toHaveBeenNthCalledWith(2, expect.anything(), SECOND_ANSWER, 'answer');
  });

  it('после answer модель в повторе пишет hot с текстом: он проверяется как сообщение о передаче', async () => {
    const h = setup({
      drafts: [answerDraft(), handoffDraft('hot')],
      reviews: [reviewProblems('Назван срок'), REVIEW_OK],
    });

    const verdict = await flow(h);

    expect(verdict).toEqual(handedOffWithText('hot'));
    expect(h.reviewDraft).toHaveBeenLastCalledWith(expect.anything(), HANDOFF_TEXT, 'handoff');
  });

  it.each([
    'refusal',
    'truncated',
    'invalid_output',
    'rate_limited',
    'unavailable',
    'disabled',
  ] as const)(
    'сбой LLM при проверке (%s): та же причина и фиксированная фраза, предупреждение без текста',
    async (failure) => {
      const h = setup({
        drafts: [handoffDraft('hot')],
        reviews: [{ ok: false, failure }],
      });

      const verdict = await flow(h);

      expect(verdict).toEqual(handedOff({ reason: 'hot' }));
      expect(logsOf(h, 'warn')).toContainEqual({ chatId: CHAT_ID, failure });
      expect(JSON.stringify(h.logs)).not.toContain('интеграцию');
    },
  );

  it('сбой повторного черновика после провала ревью: причина сохраняется, фраза фиксированная', async () => {
    const h = setup({
      drafts: [handoffDraft('asked_human'), UNAVAILABLE],
      reviews: [reviewProblems('нет')],
    });

    await expect(flow(h)).resolves.toEqual(handedOff({ reason: 'asked_human' }));
    expect(logsOf(h, 'warn')).toContainEqual({ chatId: CHAT_ID, failure: 'unavailable' });
  });

  it('лимит на проверке сообщения передачи: limit со scope, причина hot не подменяет лимит', async () => {
    const h = setup({
      drafts: [handoffDraft('hot')],
      reviews: [{ ok: false, failure: 'budget_exceeded', scope: 'chat' }],
    });

    await expect(flow(h)).resolves.toEqual({ kind: 'limit', scope: 'chat' });
    expect(h.saveAssessment).toHaveBeenCalledTimes(1);
  });

  it('лимит на повторном черновике после провала ревью: limit со scope', async () => {
    const h = setup({
      drafts: [handoffDraft('hot'), CHAT_LIMIT],
      reviews: [reviewProblems('нет')],
    });

    await expect(flow(h)).resolves.toEqual({ kind: 'limit', scope: 'chat' });
  });

  it('отказ от текста передачи пишется в лог причиной и ID чата, без текста', async () => {
    const h = setup({
      drafts: [handoffDraft('hot'), handoffDraft('hot')],
      reviews: [reviewProblems('первое'), reviewProblems('второе')],
    });

    await flow(h);

    expect(logsOf(h, 'info')).toContainEqual({ chatId: CHAT_ID, reason: 'hot' });
    expect(JSON.stringify(h.logs)).not.toContain('Уточню у коллеги');
  });
});

describe('pipeline/reply-flow: уровень hot при передаче hot', () => {
  it('оценка интереса ниже hot: после передачи hot в чате записан уровень hot с той же выжимкой', async () => {
    const h = setup({ drafts: [handoffDraft('hot')], assessment: assessed('cold') });

    await flow(h);

    expect(h.saveAssessment).toHaveBeenCalledTimes(2);
    expect(h.saveAssessment).toHaveBeenNthCalledWith(1, CHAT_ID, assessed('cold').value, NOW);
    expect(h.saveAssessment).toHaveBeenNthCalledWith(
      2,
      CHAT_ID,
      {
        level: 'hot',
        profile: assessed('cold').value.profile,
        reason: expect.stringMatching(/\S/) as unknown,
      },
      NOW,
    );
  });

  it('оценка интереса уже hot: вторая запись не нужна', async () => {
    const h = setup({ drafts: [handoffDraft('hot')], assessment: assessed('hot') });

    await flow(h);

    expect(h.saveAssessment).toHaveBeenCalledTimes(1);
  });

  it('оценка интереса не получена: уровень hot записывается с текущей выжимкой чата', async () => {
    const profile: ClientProfile = { ...EMPTY_PROFILE, business: 'склад', has1C: true };
    const h = setup({ drafts: [handoffDraft('hot')], assessment: UNAVAILABLE });

    await flow(h, { ...contextOf(), profile });

    expect(h.saveAssessment).toHaveBeenCalledTimes(1);
    expect(h.saveAssessment).toHaveBeenCalledWith(
      CHAT_ID,
      { level: 'hot', profile, reason: expect.stringMatching(/\S/) as unknown },
      NOW,
    );
  });

  it('второй провал ревью текста hot: причина всё равно hot, уровень hot записан', async () => {
    const h = setup({
      drafts: [handoffDraft('hot'), handoffDraft('hot', SECOND_HANDOFF_TEXT)],
      reviews: [reviewProblems('первое'), reviewProblems('второе')],
      assessment: assessed('warm'),
    });

    await expect(flow(h)).resolves.toEqual(handedOff({ reason: 'hot' }));
    expect(h.saveAssessment).toHaveBeenLastCalledWith(
      CHAT_ID,
      expect.objectContaining({ level: 'hot' }),
      NOW,
    );
  });

  it.each(['no_answer', 'asked_human'] as const)(
    '%s: уровень не трогается, пишется только оценка интереса',
    async (outcome) => {
      const h = setup({ drafts: [handoffDraft(outcome)], assessment: assessed('warm') });

      await flow(h);

      expect(h.saveAssessment).toHaveBeenCalledTimes(1);
    },
  );

  it('лимит на проверке: передачи hot нет и уровень не повышается', async () => {
    const h = setup({
      drafts: [handoffDraft('hot')],
      reviews: [{ ok: false, failure: 'budget_exceeded', scope: 'global' }],
      assessment: assessed('warm'),
    });

    await flow(h);

    expect(h.saveAssessment).toHaveBeenCalledTimes(1);
  });

  it('ответ answer: уровень не повышается', async () => {
    const h = setup({ assessment: assessed('warm') });

    await flow(h);

    expect(h.saveAssessment).toHaveBeenCalledTimes(1);
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

  it('сбой оценки интереса не мешает ответу: передачу решает вызов ответа, а не оценка', async () => {
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

describe('pipeline/reply-flow: компания клиента', () => {
  function asking(question: 'confirm' | 'name', text: string = ANSWER): LlmResult<ReplyDraft> {
    return { ok: true, value: { outcome: 'answer', text, companyQuestion: question } };
  }

  it('requestAssessment: только оценка интереса с контекстом, без черновика', async () => {
    const h = setup({ assessment: assessed('warm') });
    const context = contextOf('Да, это мы');

    await expect(requestAssessment(h.deps, context)).resolves.toEqual(assessed('warm'));

    expect(h.assessInterest).toHaveBeenCalledWith(context);
    expect(h.draftReply).not.toHaveBeenCalled();
  });

  it.each<[string, () => Promise<never>]>([
    ['исключение', () => Promise.reject(new TypeError('сбой'))],
    [
      'исключение сразу при вызове',
      () => {
        throw new TypeError('сбой');
      },
    ],
  ])('requestAssessment: %s => сбой unavailable и предупреждение', async (_c, fails) => {
    const h = setup();
    h.assessInterest.mockImplementation(fails);

    await expect(requestAssessment(h.deps, contextOf())).resolves.toEqual(UNAVAILABLE);

    expect(logsOf(h, 'warn')).toEqual([{ chatId: CHAT_ID, errorName: 'TypeError' }]);
  });

  it.each(['confirm', 'name'] as const)(
    'вердикт send несёт вопрос о компании %s из черновика answer',
    async (question) => {
      const h = setup({ drafts: [asking(question)] });

      await expect(flow(h)).resolves.toStrictEqual({
        kind: 'send',
        text: ANSWER,
        companyQuestion: question,
      });
    },
  );

  it('черновик без вопроса о компании: в вердикте поля нет', async () => {
    const h = setup();

    await expect(flow(h)).resolves.toStrictEqual({ kind: 'send', text: ANSWER });
  });

  it('после повтора вопрос берётся из того черновика, чей текст уходит', async () => {
    const h = setup({
      drafts: [asking('confirm'), asking('name', SECOND_ANSWER)],
      reviews: [reviewProblems('Назван срок, его нет в знаниях'), REVIEW_OK],
    });

    await expect(flow(h)).resolves.toStrictEqual({
      kind: 'send',
      text: SECOND_ANSWER,
      companyQuestion: 'name',
    });
  });
});

describe('pipeline/reply-flow: hot после вопроса цены (aboutPrice)', () => {
  /** Третий вопрос цены: передача по цене разрешена и без минимума (решение владельца 29.10.2026). */
  const THIRD_ASK: ConversationContext = {
    ...contextOf(),
    progress: { priceAsks: 2, refused: false },
  };

  function priced(
    outcome: ReplyHandoffOutcome,
    text: string,
    aboutPrice: boolean,
  ): LlmResult<ReplyDraft> {
    return { ok: true, value: { outcome, text, aboutPrice } };
  }

  it('hot без текста с aboutPrice: передача hot с фразой о цене', async () => {
    const h = setup({ drafts: [priced('hot', '', true)] });

    await expect(flow(h, THIRD_ASK)).resolves.toStrictEqual(
      handedOff({ reason: 'hot', aboutPrice: true }),
    );
    expect(h.reviewDraft).not.toHaveBeenCalled();
  });

  it('текст hot с aboutPrice дважды не прошёл проверки: фраза о цене', async () => {
    const dashed = priced('hot', 'Интеграцию — проводим. Уточню у коллеги и вернусь к вам.', true);
    const h = setup({ drafts: [dashed, dashed] });

    await expect(flow(h, THIRD_ASK)).resolves.toStrictEqual(
      handedOff({ reason: 'hot', aboutPrice: true }),
    );
  });

  it('проверка текста hot с aboutPrice не получена: фраза о цене', async () => {
    const h = setup({ drafts: [priced('hot', HANDOFF_TEXT, true)], reviews: [UNAVAILABLE] });

    await expect(flow(h, THIRD_ASK)).resolves.toStrictEqual(
      handedOff({ reason: 'hot', aboutPrice: true }),
    );
  });

  it('повтор не получен после провала ревью hot с aboutPrice: фраза о цене', async () => {
    const h = setup({
      drafts: [priced('hot', HANDOFF_TEXT, true), UNAVAILABLE],
      reviews: [reviewProblems('нет')],
    });

    await expect(flow(h, THIRD_ASK)).resolves.toStrictEqual(
      handedOff({ reason: 'hot', aboutPrice: true }),
    );
  });

  it('текст hot с aboutPrice прошёл проверки: уходит текст модели', async () => {
    const h = setup({ drafts: [priced('hot', HANDOFF_TEXT, true)] });

    await expect(flow(h, THIRD_ASK)).resolves.toStrictEqual(handedOffWithText('hot'));
  });

  it.each<[string, LlmResult<ReplyDraft>, ReplyHandoffOutcome]>([
    ['hot с aboutPrice false', priced('hot', '', false), 'hot'],
    ['hot без поля', handoffDraft('hot', ''), 'hot'],
    ['no_answer с aboutPrice', priced('no_answer', '', true), 'no_answer'],
    ['asked_human с aboutPrice', priced('asked_human', '', true), 'asked_human'],
  ])('%s: обычная фраза по причине', async (_case, draft, reason) => {
    const h = setup({ drafts: [draft] });

    await expect(flow(h, THIRD_ASK)).resolves.toStrictEqual(handedOff({ reason }));
  });
});

describe('pipeline/reply-flow: название компании клиента в проверках кодом', () => {
  const NAME = 'ALFA-TRADE.KZ';
  const QUESTION = `Вы из компании ${NAME}, правильно?`;
  const CANDIDATE: CompanyPrompt = { kind: 'candidate', name: NAME, city: null, withCity: false };
  const WITH_NAME: readonly CompanyPrompt[] = [
    CANDIDATE,
    { kind: 'asked', name: NAME, city: null, awaitingAnswer: false },
    { kind: 'confirmed', name: NAME, rubric: null, pains: [], emailed: false },
  ];

  function contextWith(company: CompanyPrompt): ConversationContext {
    return { ...contextOf(), company };
  }

  it.each(WITH_NAME)(
    'блок $kind: название не нарушение, текст идёт на ревью и уходит',
    async (company) => {
      const h = setup({ drafts: [answerDraft(QUESTION)] });

      await expect(flow(h, contextWith(company))).resolves.toEqual(sent(QUESTION));
      expect(h.reviewDraft).toHaveBeenCalledWith(contextWith(company), QUESTION, 'answer');
    },
  );

  it.each<CompanyPrompt>([
    { kind: 'off' },
    { kind: 'unknown', askName: false },
    { kind: 'searching' },
  ])('блок $kind без названия: капслок и ссылка нарушение, повтор', async (company) => {
    const h = setup({ drafts: [answerDraft(QUESTION), answerDraft()] });

    await expect(flow(h, contextWith(company))).resolves.toEqual(sent());
    expect(logsOf(h, 'info')).toContainEqual({
      chatId: CHAT_ID,
      attempt: 1,
      codes: ['link', 'caps'],
    });
  });

  it('без блока о компании: как раньше, название нарушение', async () => {
    const h = setup({ drafts: [answerDraft(QUESTION), answerDraft()] });

    await expect(flow(h)).resolves.toEqual(sent());
    expect(h.draftReply).toHaveBeenCalledTimes(2);
  });

  it('остальной текст проверяется как раньше: тире вне названия нарушение', async () => {
    const dashed = `Вы из компании ${NAME} — правильно?`;
    const h = setup({ drafts: [answerDraft(dashed), answerDraft()] });

    await flow(h, contextWith(CANDIDATE));

    expect(logsOf(h, 'info')).toContainEqual({ chatId: CHAT_ID, attempt: 1, codes: ['dash'] });
  });
});
