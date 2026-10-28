import type { ConversationContext } from '../agent/agent.js';
import type { CompanyMention, CompanyService, CompanyTurn } from '../domain/company.js';
import type { InterestAssessment, LlmResult } from '../domain/types.js';
import { requestAssessment, requestDraft, type Drafted, type ReplyFlowDeps } from './reply-flow.js';

/** Что нужно черновику с данными о компании: агент, лог и сервис компании (src/company). */
export interface CompanyDraftDeps extends Pick<ReplyFlowDeps, 'agent' | 'logger'> {
  readonly company: Pick<CompanyService, 'applyAssessment'>;
}

/** Черновик и оценка интереса вместе с контекстом, с которым писался черновик. */
export interface CompanyDrafted {
  /** С ним же идёт проверка (pipeline/reply-flow.decideReply): она судит с теми же данными о компании. */
  readonly context: ConversationContext;
  readonly drafted: Drafted;
}

/**
 * Черновик и оценка интереса с блоком о компании (CompanyTurn из prepare). Бот в прошлом ответе спросил «Вы из
 * компании X?» (awaitingAnswer): сначала оценка интереса (сбой как в requestDraft), её итог уходит в
 * company.applyAssessment, и черновик пишется уже с обновлённым блоком: ответ на «да» видит справку. Иначе черновик
 * и оценка идут параллельно (requestDraft), затем applyAssessment: подтверждённые боли и название нужны уведомлению
 * менеджеру, если ход закончится передачей. Исключение черновика уходит наружу, как в requestDraft.
 */
export async function draftWithCompany(
  deps: CompanyDraftDeps,
  base: ConversationContext,
  turn: CompanyTurn,
): Promise<CompanyDrafted> {
  const context: ConversationContext = { ...base, company: turn.prompt };
  if (!turn.awaitingAnswer) {
    const drafted = await requestDraft(deps, context);
    await deps.company.applyAssessment(base.chatId, mentionOf(drafted.assessment));
    return { context, drafted };
  }
  const assessment = await requestAssessment(deps, context);
  const prompt = await deps.company.applyAssessment(base.chatId, mentionOf(assessment));
  const answered: ConversationContext = { ...base, company: prompt };
  const draft = await deps.agent.draftReply(answered);
  return { context: answered, drafted: { draft, assessment } };
}

/** Что оценка интереса узнала о компании; сбой оценки или поля нет => null. */
function mentionOf(assessment: LlmResult<InterestAssessment>): CompanyMention | null {
  return assessment.ok ? (assessment.value.company ?? null) : null;
}
