import type { ConversationContext } from '../agent/agent.js';
import type { CompanyMention, CompanyService, CompanyTurn } from '../domain/company.js';
import type { InterestAssessment, LlmResult } from '../domain/types.js';
import {
  draftAfterAssessment,
  requestAssessment,
  type Drafted,
  type ReplyFlowDeps,
} from './reply-flow.js';

/** Что нужно черновику с данными о компании: агент, лог и сервис компании (src/company). */
export interface CompanyDraftDeps extends Pick<ReplyFlowDeps, 'agent' | 'logger'> {
  readonly company: Pick<CompanyService, 'applyAssessment'>;
}

/** Черновик и оценка интереса вместе с контекстом, с которым писался черновик. */
export interface CompanyDrafted {
  /**
   * С ним же идёт проверка (pipeline/reply-flow.decideReply): она судит с теми же данными о компании. Выжимка в нём
   * до этого хода: свежую из оценки decideReply подставляет сам, как подставил её черновику.
   */
  readonly context: ConversationContext;
  readonly drafted: Drafted;
}

/**
 * Черновик и оценка интереса с блоком о компании (CompanyTurn из prepare). Сначала оценка интереса (сбой как в
 * requestAssessment), её итог уходит в company.applyAssessment, и черновик пишется уже с обновлённым блоком и свежей
 * выжимкой (pipeline/reply-flow.draftAfterAssessment): ответ на «да» видит справку, названная клиентом компания не
 * спрашивается снова, этап и недостающее для расчёта учитывают последнее сообщение клиента (пункт 1 задания
 * 01.11.2026). Подтверждённые боли и название нужны и уведомлению менеджеру, если ход закончится передачей.
 * Исключение черновика уходит наружу.
 */
export async function draftWithCompany(
  deps: CompanyDraftDeps,
  base: ConversationContext,
  turn: CompanyTurn,
): Promise<CompanyDrafted> {
  const assessment = await requestAssessment(deps, { ...base, company: turn.prompt });
  const prompt = await deps.company.applyAssessment(base.chatId, mentionOf(assessment));
  const answered: ConversationContext = { ...base, company: prompt };
  const draft = await draftAfterAssessment(deps, answered, assessment);
  return { context: answered, drafted: { draft, assessment } };
}

/** Что оценка интереса узнала о компании; сбой оценки или поля нет => null. */
function mentionOf(assessment: LlmResult<InterestAssessment>): CompanyMention | null {
  return assessment.ok ? (assessment.value.company ?? null) : null;
}
