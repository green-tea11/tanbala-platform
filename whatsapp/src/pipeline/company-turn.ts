import type { ConversationContext } from '../agent/agent.js';
import type {
  CompanyMention,
  CompanyPrompt,
  CompanyService,
  CompanyTurn,
} from '../domain/company.js';
import type { ClientProfile, InterestAssessment, LlmResult, ProfileFact } from '../domain/types.js';
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
 * 01.11.2026). Компания подтверждена => её город и рубрика дополняют выжимку (withCompanyFacts): и выжимку до хода, и
 * выжимку оценки, которая сохранится. Подтверждённые боли и название нужны и уведомлению менеджеру, если ход
 * закончится передачей. Исключение черновика уходит наружу.
 */
export async function draftWithCompany(
  deps: CompanyDraftDeps,
  base: ConversationContext,
  turn: CompanyTurn,
): Promise<CompanyDrafted> {
  const assessed = await requestAssessment(deps, { ...base, company: turn.prompt });
  const prompt = await deps.company.applyAssessment(base.chatId, mentionOf(assessed));
  const assessment = withCompanyAssessment(assessed, prompt);
  const answered: ConversationContext = {
    ...base,
    company: prompt,
    profile: withCompanyFacts(base.profile, prompt),
  };
  const draft = await draftAfterAssessment(deps, answered, assessment);
  return { context: answered, drafted: { draft, assessment } };
}

/** Что оценка интереса узнала о компании; сбой оценки или поля нет => null. */
function mentionOf(assessment: LlmResult<InterestAssessment>): CompanyMention | null {
  return assessment.ok ? (assessment.value.company ?? null) : null;
}

/** Выжимка оценки с данными подтверждённой компании (withCompanyFacts); сбой оценки как есть. */
function withCompanyAssessment(
  assessment: LlmResult<InterestAssessment>,
  prompt: CompanyPrompt,
): LlmResult<InterestAssessment> {
  if (!assessment.ok) return assessment;
  const profile = withCompanyFacts(assessment.value.profile, prompt);
  return profile === assessment.value.profile
    ? assessment
    : { ok: true, value: { ...assessment.value, profile } };
}

function isBlank(value: string | null): boolean {
  return value === null || value.trim() === '';
}

/**
 * Что подтверждённая компания даёт выжимке (пункт 5 задания 01.11.2026, ревью H1): город карточки в пустой город и
 * рубрику в пустой бизнес, оба с пометкой «вероятно» (inferred). Иначе этап, недостающее для расчёта и финал ждали бы
 * город, который уже известен, а бот спрашивал бы его снова. Слова клиента главнее: заполненное поле не меняется.
 * Компания не подтверждена или добавить нечего => та же выжимка.
 */
export function withCompanyFacts(profile: ClientProfile, prompt: CompanyPrompt): ClientProfile {
  if (prompt.kind !== 'confirmed') return profile;
  const city = isBlank(profile.city) && !isBlank(prompt.city) ? prompt.city : null;
  const business = isBlank(profile.business) && !isBlank(prompt.rubric) ? prompt.rubric : null;
  if (city === null && business === null) return profile;
  const added: readonly ProfileFact[] = [
    ...(business === null ? [] : (['business'] as const)),
    ...(city === null ? [] : (['city'] as const)),
  ];
  return {
    ...profile,
    ...(business === null ? {} : { business }),
    ...(city === null ? {} : { city }),
    inferred: [...profile.inferred.filter((field) => !added.includes(field)), ...added],
  };
}
