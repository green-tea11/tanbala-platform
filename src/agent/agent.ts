import { z } from 'zod';
import type { ModelsConfig } from '../config/env.js';
import type { LlmClient } from '../domain/ports.js';
import type {
  ChatId,
  ClientProfile,
  InterestAssessment,
  LlmResult,
  ReplyDraft,
  ReviewResult,
  StoredMessage,
} from '../domain/types.js';
import { notImplemented } from '../shared/todo.js';
import type { Knowledge } from './knowledge.js';
import { buildSystem, buildTurns } from './prompts.js';

/** Что агент знает о разговоре. */
export interface ConversationContext {
  readonly chatId: ChatId;
  readonly history: readonly StoredMessage[];
  /** Текущая выжимка о клиенте. */
  readonly profile: ClientProfile;
}

/**
 * Три отдельных вызова LLM из плана: ответ, проверка черновика, оценка интереса.
 * Сбой любого вызова приходит как LlmResult с ok: false и ведёт к передаче специалисту.
 */
export interface Agent {
  /** Черновик ответа строго по файлам знаний. feedback: замечания проверки для повторной попытки. */
  draftReply(
    context: ConversationContext,
    feedback?: readonly string[],
  ): Promise<LlmResult<ReplyDraft>>;
  /** Проверка текста черновика: нет ли фактов не из знаний, обещаний цен, скидок, сроков или объёмов работ. */
  reviewDraft(context: ConversationContext, draftText: string): Promise<LlmResult<ReviewResult>>;
  /** Уровень интереса и обновлённая выжимка для менеджера. */
  assessInterest(context: ConversationContext): Promise<LlmResult<InterestAssessment>>;
}

/** Зависимости агента. */
export interface AgentDeps {
  llm: LlmClient;
  knowledge: Knowledge;
  models: ModelsConfig;
}

/** Сколько последних сообщений истории уходит в промпт: столько же конвейеру достаточно брать из базы. */
export const HISTORY_MESSAGES = 30;

/** Ответ одна или две фразы, но размышления Haiku 5.5 входят в max_tokens: запас, чтобы не получить truncated. */
const REPLY_MAX_TOKENS = 4096;

const INVALID_OUTPUT = { ok: false, failure: 'invalid_output' } as const;

/**
 * Схема ответа модели: плоский объект, все поля обязательны (structured outputs вместо запрещённого prefill).
 * Без transform: вход и выход совпадают. В ReplyDraft её переводит normalizeReplyDraft.
 */
const replyDraftSchema = z.object({
  outcome: z
    .enum(['answer', 'no_answer', 'asked_human', 'complaint'])
    .describe('Исход: answer, no_answer, asked_human или complaint.'),
  text: z
    .string()
    .describe('Текст сообщения клиенту при answer; при других исходах пустая строка.'),
  stopRequested: z
    .boolean()
    .describe('true только при complaint, если клиент просит больше не писать; иначе false.'),
});

type RawReplyDraft = z.infer<typeof replyDraftSchema>;

/**
 * Противоречивый ответ модели нормализуется здесь один раз: text берётся только у answer, stopRequested только
 * у complaint. answer без текста => invalid_output, не угадывать (fail-closed).
 */
function normalizeReplyDraft(raw: RawReplyDraft): LlmResult<ReplyDraft> {
  switch (raw.outcome) {
    case 'answer': {
      const text = raw.text.trim();
      return text === '' ? INVALID_OUTPUT : { ok: true, value: { outcome: 'answer', text } };
    }
    case 'complaint':
      return { ok: true, value: { outcome: 'complaint', stopRequested: raw.stopRequested } };
    case 'no_answer':
    case 'asked_human':
      return { ok: true, value: { outcome: raw.outcome } };
  }
}

function has1CText(has1C: boolean | null): string | null {
  if (has1C === null) {
    return null;
  }
  return has1C ? 'есть' : 'нет';
}

/** Выжимка для данных вызова: только выясненные поля; ничего не выяснили (до этапа 4 всегда так) => null. */
function profileText(profile: ClientProfile): string | null {
  const fields: readonly (readonly [string, string | null])[] = [
    ['Бизнес', profile.business],
    ['Площадь', profile.area],
    ['Что учитывать', profile.scope],
    ['Примерное число вещей', profile.itemCount],
    ['1С', has1CText(profile.has1C)],
    ['Задача', profile.problem],
    ['Особенности', profile.specifics],
  ];
  const known = fields.flatMap(([label, value]) => (value === null ? [] : [`${label}: ${value}`]));
  if (known.length === 0) {
    return null;
  }
  return ['Что клиент уже рассказал о себе (выжимка системы):', ...known].join('\n');
}

/** Данные вызова ответа: выясненное о клиенте и непустые замечания проверки; нет ни того, ни другого => null. */
function replyCallData(profile: ClientProfile, feedback: readonly string[]): string | null {
  const problems = feedback.map((item) => item.trim()).filter((item) => item !== '');
  const numbered = problems.map((item, index) => `${index + 1}. ${item}`);
  const remarks =
    problems.length === 0
      ? null
      : ['Замечания проверки к прошлому черновику, исправь их:', ...numbered].join('\n');
  const parts = [profileText(profile), remarks].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join('\n\n');
}

/**
 * Создаёт агента поверх LlmClient. Модели из config/models.json: по умолчанию Haiku везде.
 * Все вызовы: system = buildSystem(knowledge, purpose) (знания с кэшем, затем инструкция вызова без кэша);
 * turns = buildTurns(history, HISTORY_MESSAGES, данные вызова): данные в последней реплике user в блоке «данные».
 * draftReply: модель models.reply, данные вызова: текущая выжимка и замечания проверки (feedback); схема
 * replyDraftSchema, ответ нормализуется в ReplyDraft. Сбой LLM возвращается как есть.
 * TODO(этап 4): reviewDraft: модель models.review, данные вызова: текст черновика, не репликой assistant; схема ReviewResult.
 * TODO(этап 4): assessInterest: модель models.interest, данные вызова: текущая выжимка; схема InterestAssessment.
 * TODO(этап 4): противоречивый ответ проверки (например, ok: true вместе с замечаниями) нормализовать здесь один раз; ошибка разбора => LlmResult invalid_output, не угадывать (fail-closed).
 */
export function createAgent(deps: AgentDeps): Agent {
  const replySystem = buildSystem(deps.knowledge, 'reply');
  return {
    async draftReply(
      context: ConversationContext,
      feedback: readonly string[] = [],
    ): Promise<LlmResult<ReplyDraft>> {
      const result = await deps.llm.structured<RawReplyDraft>({
        purpose: 'reply',
        model: deps.models.reply,
        system: replySystem,
        turns: buildTurns(
          context.history,
          HISTORY_MESSAGES,
          replyCallData(context.profile, feedback),
        ),
        schema: replyDraftSchema,
        maxTokens: REPLY_MAX_TOKENS,
        chatId: context.chatId,
      });
      return result.ok ? normalizeReplyDraft(result.value) : result;
    },
    reviewDraft: () => notImplemented('этап 4', 'agent/agent.reviewDraft'),
    assessInterest: () => notImplemented('этап 4', 'agent/agent.assessInterest'),
  };
}
