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

/**
 * Создаёт агента поверх LlmClient. Модели из config/models.json: по умолчанию Haiku везде.
 * TODO(этап 3): все вызовы: system = buildSystem(knowledge, purpose) (знания с кэшем, затем инструкция вызова без кэша); turns = buildTurns(history, N, данные вызова): данные в последней реплике user с пометкой «данные».
 * TODO(этап 3): draftReply: модель models.reply, данные вызова: текущая выжимка и замечания проверки (feedback); схема zod для ReplyDraft (structured outputs вместо запрещённого prefill).
 * TODO(этап 4): reviewDraft: модель models.review, данные вызова: текст черновика, не репликой assistant; схема ReviewResult.
 * TODO(этап 4): assessInterest: модель models.interest, данные вызова: текущая выжимка; схема InterestAssessment.
 * TODO(этап 3): противоречивый ответ модели (например, ok: true вместе с замечаниями) нормализовать здесь один раз; ошибка разбора => LlmResult invalid_output, не угадывать (fail-closed).
 */
export function createAgent(deps: AgentDeps): Agent {
  return notImplemented('этап 3', 'agent/agent.createAgent');
}
