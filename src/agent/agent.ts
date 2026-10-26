import { z } from 'zod';
import type { ModelsConfig } from '../config/env.js';
import type { LlmClient, SystemBlock } from '../domain/ports.js';
import type {
  ChatId,
  ClientProfile,
  InterestAssessment,
  InterestLevel,
  LlmPurpose,
  LlmResult,
  ReplyDraft,
  ReviewResult,
  StoredMessage,
} from '../domain/types.js';
import { interestCallData, interestSchema, normalizeInterest } from './interest.js';
import type { Knowledge } from './knowledge.js';
import { profileText } from './profile.js';
import { buildSystem, buildTurns } from './prompts.js';
import {
  EMPTY_DRAFT_REVIEW,
  normalizeReview,
  reviewCallData,
  reviewSchema,
  type DraftKind,
} from './review.js';

export type { DraftKind } from './review.js';

/** Что агент знает о разговоре. */
export interface ConversationContext {
  readonly chatId: ChatId;
  readonly history: readonly StoredMessage[];
  /** Текущая выжимка о клиенте. */
  readonly profile: ClientProfile;
  /**
   * Уровень интереса, который хранится у чата сейчас (Chat.level). Его видит оценка интереса в данных вызова;
   * конвейер передаёт chat.level. Не передан => оценка идёт без текущего уровня.
   */
  readonly level?: InterestLevel;
}

/**
 * Три отдельных вызова LLM из плана: ответ, проверка черновика, оценка интереса.
 * Сбой любого вызова приходит как LlmResult с ok: false и ведёт к передаче специалисту.
 * Решение о передаче чата принимает вызов ответа (исходы hot, no_answer, asked_human, complaint); оценка
 * интереса только хранит уровень и выжимку.
 */
export interface Agent {
  /**
   * Черновик ответа строго по файлам знаний. feedback: замечания проверки для повторной попытки. Исход answer
   * оставляет чат у бота; hot, no_answer, asked_human и complaint передают его специалисту, и у первых трёх text
   * (ответ на то, что есть в знаниях, и фраза о передаче) может быть непустым.
   */
  draftReply(
    context: ConversationContext,
    feedback?: readonly string[],
  ): Promise<LlmResult<ReplyDraft>>;
  /**
   * Проверка текста черновика: нет ли фактов не из знаний, обещаний цен, скидок, сроков или объёмов работ.
   * Результат нормализован: ok true только без замечаний, ok false всегда с замечанием. Пустой черновик не проходит.
   * kind: 'answer' (по умолчанию) для обычного ответа; 'handoff' для сообщения о передаче чата специалисту
   * (hot, no_answer, asked_human): проверяющему сказано, что фраза «передал вопрос специалисту, он вам напишет»
   * допустима, а обещания времени и цены по-прежнему нет.
   */
  reviewDraft(
    context: ConversationContext,
    draftText: string,
    kind?: DraftKind,
  ): Promise<LlmResult<ReviewResult>>;
  /** Уровень интереса и обновлённая выжимка для менеджера: известное раньше сохраняется, если клиент не поправил. */
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

/**
 * Ответ, проверка и оценка короткие (две или три фразы, несколько полей), но размышления Haiku 5.5 и Sonnet 5.5
 * входят в max_tokens: запас, чтобы не получить truncated.
 */
const MAX_TOKENS = 4096;

const INVALID_OUTPUT = { ok: false, failure: 'invalid_output' } as const;

/**
 * Схема ответа модели: плоский объект, все поля обязательны (structured outputs вместо запрещённого prefill).
 * Без transform: вход и выход совпадают. В ReplyDraft её переводит normalizeReplyDraft.
 */
const replyDraftSchema = z.object({
  outcome: z
    .enum(['answer', 'hot', 'no_answer', 'asked_human', 'complaint'])
    .describe('Исход: answer, hot, no_answer, asked_human или complaint.'),
  text: z
    .string()
    .describe(
      'Текст сообщения клиенту при answer, hot, no_answer и asked_human; при complaint пустая строка.',
    ),
  stopRequested: z
    .boolean()
    .describe('true только при complaint, если клиент просит больше не писать; иначе false.'),
});

type RawReplyDraft = z.infer<typeof replyDraftSchema>;

/**
 * Противоречивый ответ модели нормализуется здесь один раз: text берётся у answer, hot, no_answer и asked_human,
 * stopRequested только у complaint. answer без текста => invalid_output, не угадывать (fail-closed). У hot, no_answer
 * и asked_human пустой text допустим: чат всё равно уходит менеджеру, клиенту пишется фиксированная фраза.
 */
function normalizeReplyDraft(raw: RawReplyDraft): LlmResult<ReplyDraft> {
  switch (raw.outcome) {
    case 'answer': {
      const text = raw.text.trim();
      return text === '' ? INVALID_OUTPUT : { ok: true, value: { outcome: 'answer', text } };
    }
    case 'complaint':
      return { ok: true, value: { outcome: 'complaint', stopRequested: raw.stopRequested } };
    case 'hot':
    case 'no_answer':
    case 'asked_human':
      return { ok: true, value: { outcome: raw.outcome, text: raw.text.trim() } };
  }
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

/** Один вызов LLM: что в нём общее для трёх назначений (история, лимит токенов, чат) и что своё (модель, инструкция). */
type Ask = <T>(
  purpose: LlmPurpose,
  schema: z.ZodType<T, T>,
  context: ConversationContext,
  callData: string | null,
) => Promise<LlmResult<T>>;

/**
 * system строится один раз на назначение: блок знаний у трёх вызовов один и тот же (кэш общий), после него
 * инструкция вызова. Модель берётся из конфига по назначению.
 */
function createAsk(deps: AgentDeps): Ask {
  const systems: Readonly<Record<LlmPurpose, readonly SystemBlock[]>> = {
    reply: buildSystem(deps.knowledge, 'reply'),
    review: buildSystem(deps.knowledge, 'review'),
    interest: buildSystem(deps.knowledge, 'interest'),
  };
  return (purpose, schema, context, callData) =>
    deps.llm.structured({
      purpose,
      model: deps.models[purpose],
      system: systems[purpose],
      turns: buildTurns(context.history, HISTORY_MESSAGES, callData),
      schema,
      maxTokens: MAX_TOKENS,
      chatId: context.chatId,
    });
}

/**
 * Создаёт агента поверх LlmClient. Модели из config/models.json: ответ на Sonnet, проверка и оценка интереса на Haiku.
 * Все вызовы: system = buildSystem(knowledge, purpose) (знания с кэшем, затем инструкция вызова без кэша; блок
 * знаний у трёх вызовов один и тот же, поэтому кэш общий); turns = buildTurns(history, HISTORY_MESSAGES, данные
 * вызова): данные в последней реплике user в блоке «данные». Сбой LLM возвращается как есть, значением.
 * draftReply: модель models.reply, данные вызова: текущая выжимка и замечания проверки (feedback); схема
 * replyDraftSchema, ответ нормализуется в ReplyDraft.
 * reviewDraft: модель models.review, данные вызова: текст черновика (не репликой assistant); схема reviewSchema,
 * противоречия снимает normalizeReview. Пустой черновик не проходит и LLM не вызывает.
 * assessInterest: модель models.interest, данные вызова: текущий уровень и выжимка; схема interestSchema,
 * normalizeInterest чистит поля и сохраняет известное раньше.
 */
export function createAgent(deps: AgentDeps): Agent {
  const ask = createAsk(deps);
  return {
    async draftReply(
      context: ConversationContext,
      feedback: readonly string[] = [],
    ): Promise<LlmResult<ReplyDraft>> {
      const callData = replyCallData(context.profile, feedback);
      const result = await ask('reply', replyDraftSchema, context, callData);
      return result.ok ? normalizeReplyDraft(result.value) : result;
    },
    async reviewDraft(
      context: ConversationContext,
      draftText: string,
      kind: DraftKind = 'answer',
    ): Promise<LlmResult<ReviewResult>> {
      if (draftText.trim() === '') {
        return { ok: true, value: EMPTY_DRAFT_REVIEW };
      }
      const result = await ask('review', reviewSchema, context, reviewCallData(draftText, kind));
      return result.ok ? { ok: true, value: normalizeReview(result.value) } : result;
    },
    async assessInterest(context: ConversationContext): Promise<LlmResult<InterestAssessment>> {
      const callData = interestCallData(context.profile, context.level);
      const result = await ask('interest', interestSchema, context, callData);
      return result.ok
        ? { ok: true, value: normalizeInterest(result.value, context.profile) }
        : result;
    },
  };
}
