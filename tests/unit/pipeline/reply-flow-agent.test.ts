import { describe, expect, it, vi } from 'vitest';
import { createAgent, type ConversationContext } from '../../../src/agent/agent.js';
import type { Knowledge } from '../../../src/agent/knowledge.js';
import type { ModelsConfig } from '../../../src/config/env.js';
import type { Logger } from '../../../src/domain/ports.js';
import type { ChatId, ClientProfile, ReviewedText } from '../../../src/domain/types.js';
import {
  decideReply,
  requestDraft,
  type ReplyFlowDeps,
  type ReplyVerdict,
} from '../../../src/pipeline/reply-flow.js';
import { scriptedLlm, type LlmScript } from './scripted-llm.js';

// Ход ответа с настоящим агентом (схемы, нормализация, запросы) и поддельной моделью: сети нет.

const CHAT_ID = 7 as ChatId;
const NOW = Date.UTC(2026, 9, 26, 9, 0, 0);
const FIRST = 'Учёт подбираем под задачу. Что вы храните?';
const SECOND = 'Решение подбирает специалист. Что вы хотите учитывать?';
const KNOWLEDGE: Knowledge = { owner: 'Документ', whatsapp: 'Правила', version: 'v1' };
const MODELS: ModelsConfig = {
  reply: 'claude-haiku-5-5',
  review: 'claude-haiku-5-5',
  interest: 'claude-haiku-5-5',
};
const EMPTY_PROFILE: ClientProfile = {
  business: null,
  area: null,
  scope: null,
  itemCount: null,
  has1C: null,
  problem: null,
  specifics: null,
};
const CONTEXT: ConversationContext = {
  chatId: CHAT_ID,
  history: [
    { id: 1, chatId: CHAT_ID, author: 'client', kind: 'text', text: 'Сколько стоит?', tsMs: NOW },
  ],
  profile: EMPTY_PROFILE,
  level: 'cold',
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

async function run(script: LlmScript) {
  const model = scriptedLlm(script);
  const saveAssessment = vi.fn<ReplyFlowDeps['chats']['saveAssessment']>();
  const deps: ReplyFlowDeps = {
    chats: { saveAssessment },
    agent: createAgent({ llm: model.llm, knowledge: KNOWLEDGE, models: MODELS }),
    clock: { now: () => NOW },
    logger,
  };
  const drafted = await requestDraft(deps, CONTEXT);
  const verdict: ReplyVerdict = await decideReply(deps, CONTEXT, drafted);
  return { verdict, model, saveAssessment };
}

describe('pipeline/reply-flow с настоящим агентом', () => {
  it('три вызова разных назначений: черновик и оценка сразу, проверка после; ответ уходит', async () => {
    const { verdict, model, saveAssessment } = await run({ replies: [FIRST] });

    expect(verdict).toEqual({ kind: 'send', text: FIRST as ReviewedText });
    expect(model.purposes()).toEqual(['reply', 'interest', 'review']);
    expect(saveAssessment).toHaveBeenCalledWith(
      CHAT_ID,
      { level: 'cold', profile: EMPTY_PROFILE, reason: 'по разговору' },
      NOW,
    );
  });

  it('проверка не пропустила: второй черновик получает замечание проверки, второй провал даёт check_failed', async () => {
    const { verdict, model } = await run({
      replies: [FIRST, SECOND],
      problems: ['Названа цена, её нет в знаниях'],
    });

    expect(verdict).toEqual({ kind: 'handoff', notice: { reason: 'check_failed' } });
    expect(model.purposes()).toEqual(['reply', 'interest', 'review', 'reply', 'review']);
    const retry = model.requests[3]?.turns.at(-1)?.text ?? '';
    expect(retry).toContain('Названа цена, её нет в знаниях');
    expect(model.requests[4]?.turns.at(-1)?.text).toContain(SECOND);
  });

  it('горячий клиент: передача hot без вызова проверки, текст ответа не уходит', async () => {
    const { verdict, model, saveAssessment } = await run({ replies: [FIRST], level: 'hot' });

    expect(verdict).toEqual({ kind: 'handoff', notice: { reason: 'hot' } });
    expect(model.purposes()).toEqual(['reply', 'interest']);
    expect(saveAssessment).toHaveBeenCalledWith(
      CHAT_ID,
      expect.objectContaining({ level: 'hot' }),
      NOW,
    );
  });

  it('нарушение кода: ревью не зовётся, замечание кода уходит модели во втором запросе', async () => {
    const { verdict, model } = await run({
      replies: ['Учёт — это просто. Что вы храните?', SECOND],
    });

    expect(verdict).toEqual({ kind: 'send', text: SECOND as ReviewedText });
    expect(model.purposes()).toEqual(['reply', 'interest', 'reply', 'review']);
    expect(model.requests[2]?.turns.at(-1)?.text).toContain('тире');
  });
});
