import { describe, expect, it } from 'vitest';
import type { ConversationContext } from '../../../src/agent/agent.js';
import type { CompanyPrompt } from '../../../src/domain/company.js';
import type { Logger } from '../../../src/domain/ports.js';
import type {
  ChatId,
  ChatProgress,
  ClientProfile,
  LlmResult,
  ReplyDraft,
  ReviewResult,
  StoredMessage,
  TurnSignals,
} from '../../../src/domain/types.js';
import { decideReply, requestDraft, type ReplyFlowDeps } from '../../../src/pipeline/reply-flow.js';
import {
  INTRO_BUSINESS_QUESTION,
  questionText,
  REACTIONS,
} from '../../../src/pipeline/safe-questions.js';

// Два провала проверок (пункт 2 задания 29.10.2026): чат не уходит менеджеру, клиенту уходит фиксированный безопасный
// вопрос (с 30.10.2026 один открытый по этапу и первому недостающему для расчёта), не тот, что бот уже задавал.
// check_failed только когда спросить нечего.

const NOW = Date.UTC(2026, 9, 29, 9, 0, 0);
const CHAT_ID = 1 as ChatId;
/** Черновик с ценой: проверка кодом его не пропускает. */
const PRICED = 'Внедрение стоит 500 000 тенге. Что вы храните?';
const CLEAN = 'Учёт подбираем под задачу. Что вы храните?';

const EMPTY: ClientProfile = {
  business: null,
  items: null,
  packaging: null,
  material: null,
  city: null,
  premises: null,
  area: null,
  scope: null,
  itemCount: null,
  turnover: null,
  currentTracking: null,
  monthlyIntake: null,
  passages: null,
  shelfRecount: null,
  has1C: null,
  oneCName: null,
  problem: null,
  specifics: null,
  problemAgreed: false,
  inferred: [],
};

const EVERYTHING: ClientProfile = {
  ...EMPTY,
  business: 'дистрибуция',
  items: 'запчасти',
  packaging: 'коробки',
  material: 'металл',
  city: 'Алматы',
  premises: 'склад',
  area: '5000 м²',
  itemCount: 'около 3000',
  monthlyIntake: 'около 200',
  turnover: 'каждый день',
  passages: 'один вход',
  currentTracking: 'Excel',
  problem: 'пересорт',
  has1C: true,
  oneCName: 'УТ 11',
};

/** Бот в чате ещё не писал: перед готовым вопросом приветствие (пункт 3 задания 01.11.2026). */
function greeted(question: string): string {
  return `${REACTIONS.greeting} ${question}`;
}

/** Бот уже на этапе деталей: безопасный вопрос о недостающем для расчёта. */
const ON_DETAILS: ChatProgress = { priceAsks: 0, refused: false, lastStage: 'details' };

interface Case {
  readonly drafts?: readonly string[];
  readonly problems?: readonly string[];
  /** Итоги проверки по вызовам (последний повторяется); есть поле => problems не читается. */
  readonly reviews?: readonly ReviewResult[];
  readonly profile?: ClientProfile;
  readonly signals?: TurnSignals;
  readonly lastBot?: string;
  /** Кто написал lastBot; по умолчанию бот. */
  readonly lastAuthor?: 'bot' | 'human_phone' | 'human_panel';
  readonly company?: CompanyPrompt;
  readonly companyName?: string | null;
  readonly progress?: ChatProgress;
}

function run(c: Case) {
  const logs: { context: unknown; message: string | undefined }[] = [];
  const log = (context: Readonly<Record<string, unknown>>, message?: string): void => {
    logs.push({ context, message });
  };
  const logger: Logger = {
    level: 'info',
    trace: log,
    debug: log,
    info: log,
    warn: log,
    error: log,
    fatal: log,
    silent: log,
    child: () => logger,
  };
  const drafts = [...(c.drafts ?? [PRICED])];
  let reviews = 0;
  const deps: ReplyFlowDeps = {
    chats: { saveAssessment: () => undefined },
    agent: {
      draftReply: () => {
        const text = drafts.length > 1 ? drafts.shift() : drafts[0];
        return Promise.resolve<LlmResult<ReplyDraft>>({
          ok: true,
          value: { outcome: 'answer', text: text ?? CLEAN },
        });
      },
      reviewDraft: () => {
        reviews += 1;
        const problems = c.problems ?? [];
        const scripted = c.reviews?.[Math.min(reviews, c.reviews.length) - 1];
        return Promise.resolve<LlmResult<ReviewResult>>({
          ok: true,
          value: scripted ?? (problems.length === 0 ? { ok: true } : { ok: false, problems }),
        });
      },
      assessInterest: () =>
        Promise.resolve({
          ok: true,
          value: {
            level: 'warm',
            profile: c.profile ?? EMPTY,
            reason: 'по разговору',
            signals: c.signals ?? { priceAsked: false, refused: false },
          },
        }),
    },
    clock: { now: () => NOW },
    logger,
  };
  const history: StoredMessage[] = [
    { id: 1, chatId: CHAT_ID, author: 'client', kind: 'text', text: 'Здравствуйте', tsMs: NOW - 3 },
    ...(c.lastBot === undefined
      ? []
      : [
          {
            id: 2,
            chatId: CHAT_ID,
            author: c.lastAuthor ?? ('bot' as const),
            kind: 'text' as const,
            text: c.lastBot,
            tsMs: NOW - 2,
          },
        ]),
    { id: 3, chatId: CHAT_ID, author: 'client', kind: 'text', text: 'Так сколько?', tsMs: NOW - 1 },
  ];
  const context: ConversationContext = {
    chatId: CHAT_ID,
    history,
    profile: EMPTY,
    ...(c.company === undefined ? {} : { company: c.company }),
    ...(c.companyName === undefined ? {} : { companyName: c.companyName }),
    ...(c.progress === undefined ? {} : { progress: c.progress }),
  };
  return (async () => {
    const drafted = await requestDraft(deps, context);
    const verdict = await decideReply(deps, context, drafted);
    return { verdict, logs, reviews: () => reviews };
  })();
}

describe('pipeline/reply-flow: два провала проверок дают безопасный вопрос, а не передачу', () => {
  it('проверка кодом дважды: вопрос знакомства (бизнес неизвестен), чат у бота', async () => {
    const r = await run({ drafts: [PRICED, PRICED] });

    expect(r.verdict).toEqual({ kind: 'send', text: greeted(INTRO_BUSINESS_QUESTION) });
  });

  it('ревью дважды: тот же безопасный вопрос; сам вопрос второй раз не проверяется', async () => {
    const r = await run({ drafts: [CLEAN, CLEAN], problems: ['Утверждение не из документов'] });

    expect(r.verdict).toEqual({ kind: 'send', text: greeted(INTRO_BUSINESS_QUESTION) });
    expect(r.reviews()).toBe(2);
  });

  it('бизнес известен, бот ещё не был на крючке: вопрос, знает ли клиент RFID', async () => {
    const r = await run({ profile: { ...EMPTY, business: 'склад' } });

    expect(r.verdict).toEqual({ kind: 'send', text: greeted(questionText('hook', false)) });
  });

  it('прошлым сообщением бот спросил, что на хранении: этот вопрос второй раз не задаётся', async () => {
    const r = await run({
      lastBot: 'Расскажите, что у вас лежит на хранении и в каком виде?',
      profile: { ...EMPTY, business: 'склад' },
      progress: ON_DETAILS,
    });

    // Бизнес клиент назвал в этом ходе: реакция о расчёте.
    expect(r.verdict).toEqual({
      kind: 'send',
      text: `${REACTIONS.newData} ${questionText('itemCount', false)}`,
    });
  });

  it('клиент спросил цену: перед вопросом фраза об ориентире, сигналы хода записываются', async () => {
    const signals = { priceAsked: true, refused: false };
    const r = await run({
      signals,
      profile: { ...EMPTY, business: 'склад', itemCount: 'около 3000', has1C: true },
      progress: ON_DETAILS,
    });

    expect(r.verdict).toEqual({ kind: 'send', text: questionText('items', true), signals });
  });

  it('о компании можно спросить: вопрос знакомства отмечается как вопрос о названии', async () => {
    const r = await run({ company: { kind: 'unknown', askName: true } });

    expect(r.verdict).toEqual({
      kind: 'send',
      text: greeted(questionText('intro', false)),
      companyQuestion: 'name',
    });
  });

  it('спросить нечего (всё выяснено), чат уже передавался: передача check_failed', async () => {
    const r = await run({
      profile: EVERYTHING,
      progress: { priceAsks: 0, refused: false, handedOff: true, lastStage: 'details' },
    });

    expect(r.verdict).toEqual({ kind: 'handoff', notice: { reason: 'check_failed' } });
  });

  it('клиент спрашивает цену при понятной задаче: код передаёт чат сразу, черновик не проверяется (решение владельца 30.10.2026)', async () => {
    const r = await run({
      profile: { ...EVERYTHING, problemAgreed: true },
      signals: { priceAsked: true, refused: false },
      companyName: 'ТОО Склад',
      progress: { priceAsks: 0, refused: false, handedOff: true },
    });

    expect(r.verdict).toEqual({
      kind: 'handoff',
      notice: { reason: 'hot', aboutPrice: true },
      detail: expect.stringMatching(/^Спрашивает цену, сроки или договор/) as unknown,
    });
  });

  it.each([
    [
      'писал только менеджер с телефона',
      { lastBot: 'Добрый день, это Алия.', lastAuthor: 'human_phone' },
    ],
    ['писал только менеджер из панели', { lastBot: 'Добрый день.', lastAuthor: 'human_panel' }],
    ['бот отвечал раньше окна истории', { progress: ON_DETAILS }],
  ] as const)('%s: не приветствие, а «Спасибо!»', async (_name, c) => {
    const r = await run(c);

    expect(r.verdict).toEqual({
      kind: 'send',
      text: `${REACTIONS.thanks} ${INTRO_BUSINESS_QUESTION}`,
    });
  });

  it('бот уже писал, нового для расчёта нет: реакция «Спасибо!» перед вопросом', async () => {
    const r = await run({
      lastBot: 'Расскажите, что у вас лежит на хранении и в каком виде?',
      progress: ON_DETAILS,
    });

    expect(r.verdict).toEqual({
      kind: 'send',
      text: `${REACTIONS.thanks} ${INTRO_BUSINESS_QUESTION}`,
    });
  });

  it('в лог код вопроса, без текста черновика и вопроса', async () => {
    const r = await run({});

    const dump = JSON.stringify(r.logs);
    expect(dump).toContain('"question":"intro"');
    expect(dump).not.toContain('500 000');
    expect(dump).not.toContain('Расскажите');
  });
});

describe('pipeline/reply-flow: второй черновик с замечанием проверки (03.11.2026: только неправда, цена, обещания)', () => {
  const FACT: ReviewResult = {
    ok: false,
    problems: ['«Расхождения видны сразу» нет в знаниях'],
  };
  const SECOND = 'Остатки в 1С часто расходятся с полками. Сколько нового приходит за месяц?';

  it('оба черновика с замечанием => не уходит ни один: готовый вопрос с реакцией', async () => {
    const r = await run({ drafts: [CLEAN, SECOND], reviews: [FACT, FACT] });

    expect(r.verdict).toEqual({ kind: 'send', text: greeted(INTRO_BUSINESS_QUESTION) });
    expect(r.reviews()).toBe(2);
  });

  it('второй не прошёл проверки кодом => до проверки не доходит и не уходит', async () => {
    const r = await run({ drafts: [CLEAN, PRICED], reviews: [FACT] });

    expect(r.verdict).toEqual({ kind: 'send', text: greeted(INTRO_BUSINESS_QUESTION) });
    expect(r.reviews()).toBe(1);
  });
});
