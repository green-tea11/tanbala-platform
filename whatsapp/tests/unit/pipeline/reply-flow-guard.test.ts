import { describe, expect, it, vi } from 'vitest';
import type { ConversationContext } from '../../../src/agent/agent.js';
import type { Logger } from '../../../src/domain/ports.js';
import type { ChatId, ClientProfile, LlmResult, ReplyDraft } from '../../../src/domain/types.js';
import { decideAction } from '../../../src/pipeline/decide.js';
import {
  decideReply,
  requestDraft,
  type ReplyFlowDeps,
  type ReplyVerdict,
} from '../../../src/pipeline/reply-flow.js';

// Защитная ветка конвейера: по правилу decideAction на второй попытке повтора нет. Если бы решение всё же вернуло
// повтор (ошибка в правиле), текст без проверки не должен уйти клиенту. Решение подменено, остальное настоящее.

vi.mock('../../../src/pipeline/decide.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/pipeline/decide.js')>();
  return { ...original, decideAction: vi.fn(original.decideAction) };
});

const CHAT_ID = 7 as ChatId;
const NOW = Date.UTC(2026, 9, 26, 9, 0, 0);
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
const CONTEXT: ConversationContext = {
  chatId: CHAT_ID,
  history: [
    { id: 1, chatId: CHAT_ID, author: 'client', kind: 'text', text: 'Сколько стоит?', tsMs: NOW },
  ],
  profile: EMPTY_PROFILE,
};

const logger: Logger = {
  level: 'info',
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  silent: () => undefined,
  child: () => logger,
};

function depsOf(draft: ReplyDraft): ReplyFlowDeps {
  const drafted: LlmResult<ReplyDraft> = { ok: true, value: draft };
  return {
    chats: { saveAssessment: () => undefined },
    agent: {
      draftReply: () => Promise.resolve(drafted),
      reviewDraft: () => Promise.resolve({ ok: true, value: { ok: true } }),
      assessInterest: () =>
        Promise.resolve({
          ok: true,
          value: { level: 'cold', profile: EMPTY_PROFILE, reason: 'по разговору' },
        }),
    },
    clock: { now: () => NOW },
    logger,
  };
}

async function verdictWithEndlessRetry(draft: ReplyDraft): Promise<ReplyVerdict> {
  vi.mocked(decideAction).mockReturnValue({ kind: 'retry', feedback: ['замечание'] });
  const deps = depsOf(draft);
  const drafted = await requestDraft(deps, CONTEXT);
  return decideReply(deps, CONTEXT, drafted);
}

describe('pipeline/reply-flow: повтор на второй попытке невозможен', () => {
  it('ответ answer: если решение всё же вернуло повтор, итог check_failed, текст не уходит', async () => {
    const verdict = await verdictWithEndlessRetry({
      outcome: 'answer',
      text: 'Учёт подбираем под задачу. Что вы храните?',
    });

    expect(verdict).toEqual({ kind: 'handoff', notice: { reason: 'check_failed' } });
  });

  it('исход передачи: тот же случай оставляет причину и фиксированную фразу, текст не уходит', async () => {
    const verdict = await verdictWithEndlessRetry({
      outcome: 'hot',
      text: 'Уточню у коллеги и вернусь к вам.',
    });

    expect(verdict).toEqual({ kind: 'handoff', notice: { reason: 'hot' } });
    expect(verdict).not.toHaveProperty('text');
  });
});
