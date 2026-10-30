import { describe, expect, it, vi } from 'vitest';
import type { ConversationContext } from '../../../src/agent/agent.js';
import type { Logger } from '../../../src/domain/ports.js';
import type {
  ChatId,
  ClientProfile,
  LlmResult,
  RejectedDraft,
  ReplyDraft,
  ReviewResult,
} from '../../../src/domain/types.js';
import { decideReply, requestDraft, type ReplyFlowDeps } from '../../../src/pipeline/reply-flow.js';

// Отклонённые черновики для панели (пункт 7 задания 29.10.2026): каждый черновик, не прошедший проверки кодом или
// проверку вторым вызовом, сохраняется с номером попытки и замечаниями; в лог идут только ID, коды и числа.

const NOW = Date.UTC(2026, 9, 29, 9, 0, 0);
const CHAT_ID = 7 as ChatId;
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
  items: null,
  packaging: null,
  material: null,
  city: null,
  premises: null,
  turnover: null,
  currentTracking: null,
  monthlyIntake: null,
  passages: null,
  shelfRecount: null,
  inferred: [],
};
const CONTEXT: ConversationContext = {
  chatId: CHAT_ID,
  history: [
    {
      id: 1,
      chatId: CHAT_ID,
      author: 'client',
      kind: 'text',
      text: 'Около 3000 позиций. Так сколько примерно?',
      tsMs: NOW,
    },
  ],
  profile: EMPTY_PROFILE,
};

/** Черновик с ценой: его отклоняет проверка кодом. */
const PRICED = 'Внедрение стоит 500 000 тенге. Что вы храните?';
/** Черновик без нарушений для кода: его судит проверка вторым вызовом. */
const CLEAN = 'Учёт подбираем под задачу. Что вы храните?';
const REVIEW_REMARK = 'Утверждение о Tanbala, которого нет в документах: уберите его.';

interface LogEntry {
  readonly context: unknown;
  readonly message: string | undefined;
}

function loggerOf(logs: LogEntry[]): Logger {
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
  return logger;
}

function setup(drafts: readonly string[], reviews: readonly LlmResult<ReviewResult>[]) {
  const logs: LogEntry[] = [];
  const saved: RejectedDraft[] = [];
  const draftQueue = [...drafts];
  const reviewQueue = [...reviews];
  const next = <T>(queue: T[]): T => {
    const item = queue.length > 1 ? queue.shift() : queue[0];
    if (item === undefined) throw new Error('нет ответа');
    return item;
  };
  const deps: ReplyFlowDeps = {
    chats: { saveAssessment: () => undefined },
    agent: {
      draftReply: () =>
        Promise.resolve<LlmResult<ReplyDraft>>({
          ok: true,
          value: { outcome: 'answer', text: next(draftQueue) },
        }),
      reviewDraft: () => Promise.resolve(next(reviewQueue)),
      assessInterest: () => Promise.resolve({ ok: false, failure: 'unavailable' }),
    },
    clock: { now: () => NOW },
    logger: loggerOf(logs),
    rejectedDrafts: {
      add: vi.fn((entry: RejectedDraft) => {
        saved.push(entry);
      }),
    },
  };
  return { deps, logs, saved };
}

async function run(deps: ReplyFlowDeps) {
  const drafted = await requestDraft(deps, CONTEXT);
  return decideReply(deps, CONTEXT, drafted);
}

const REVIEW_OK: LlmResult<ReviewResult> = { ok: true, value: { ok: true } };

describe('pipeline/reply-flow: отклонённые черновики сохраняются для панели', () => {
  it('проверка кодом: черновик, попытка 1, источник code, замечания кода; повтор прошёл и не сохраняется', async () => {
    const { deps, saved } = setup([PRICED, CLEAN], [REVIEW_OK]);

    const verdict = await run(deps);

    expect(verdict).toEqual({ kind: 'send', text: CLEAN });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      chatId: CHAT_ID,
      attempt: 1,
      source: 'code',
      draft: PRICED,
      atMs: NOW,
    });
    expect(saved[0]?.remarks.length).toBeGreaterThan(0);
    expect(saved[0]?.remarks.join(' ')).toContain('цена');
  });

  it('проверка вторым вызовом: источник review и её замечания; обе попытки с номерами', async () => {
    const problems: LlmResult<ReviewResult> = {
      ok: true,
      value: { ok: false, problems: [REVIEW_REMARK] },
    };
    const { deps, saved } = setup([CLEAN, CLEAN], [problems]);

    await run(deps);

    expect(saved.map(({ attempt, source, remarks }) => ({ attempt, source, remarks }))).toEqual([
      { attempt: 1, source: 'review', remarks: [REVIEW_REMARK] },
      { attempt: 2, source: 'review', remarks: [REVIEW_REMARK] },
    ]);
  });

  it('прошедший черновик не сохраняется', async () => {
    const { deps, saved } = setup([CLEAN], [REVIEW_OK]);

    await run(deps);

    expect(saved).toEqual([]);
  });

  it('в лог не попадают ни черновик, ни замечания: только ID чата, попытка, коды и числа', async () => {
    const problems: LlmResult<ReviewResult> = {
      ok: true,
      value: { ok: false, problems: [REVIEW_REMARK] },
    };
    const { deps, logs, saved } = setup([PRICED, CLEAN], [problems]);

    await run(deps);

    expect(saved).toHaveLength(2);
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain('500 000');
    expect(dump).not.toContain('Что вы храните');
    expect(dump).not.toContain('Утверждение о Tanbala');
    expect(dump).not.toContain('цена:');
  });

  it('сбой записи черновика не ломает ответ: предупреждение без текста', async () => {
    const { deps, logs } = setup([PRICED, CLEAN], [REVIEW_OK]);
    const failing: ReplyFlowDeps = {
      ...deps,
      rejectedDrafts: {
        add: () => {
          throw new Error('база занята');
        },
      },
    };

    const verdict = await run(failing);

    expect(verdict).toEqual({ kind: 'send', text: CLEAN });
    expect(JSON.stringify(logs)).not.toContain('500 000');
    expect(logs.some((entry) => entry.message?.includes('Отклонённый черновик не сохранён'))).toBe(
      true,
    );
  });

  it('без хранилища черновиков ход идёт как раньше', async () => {
    const { deps } = setup([PRICED, CLEAN], [REVIEW_OK]);
    const withoutStore: ReplyFlowDeps = {
      chats: deps.chats,
      agent: deps.agent,
      clock: deps.clock,
      logger: deps.logger,
    };

    const verdict = await run(withoutStore);

    expect(verdict).toEqual({ kind: 'send', text: CLEAN });
  });
});
