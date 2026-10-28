import type {
  CandidateSource,
  ChatCandidate,
  ChatCompanyState,
  CompanyBrief,
  CompanyCandidate,
  CompanyMention,
  CompanyQuestion,
  ResearchState,
} from '../domain/company.js';
import type { BusinessProfileResult } from '../domain/ports.js';
import { clipText } from './clip-text.js';
import { domainFromProfile } from './profile-domain.js';
import { candidateInReply, type ReplyMention } from './reply-mention.js';

/** Длина названия и города со слов клиента: как ограничивает их проект B. */
const MAX_STATED_NAME_CHARS = 200;
const MAX_STATED_CITY_CHARS = 100;

// Переходы состояния определения компании: чистые функции, каждая возвращает новое состояние. Когда менять нечего
// (нет кандидата, вопрос уже задавался), возвращается то же состояние: вызывающий видит, что писать в базу не надо.

/** Идущая проверка новой компании: в очереди или выполняется. */
export type RunningResearch = Extract<ResearchState, { readonly status: 'queued' | 'running' }>;

export function isRunning(research: ResearchState | null): research is RunningResearch {
  return research?.status === 'queued' || research?.status === 'running';
}

/**
 * Итог запроса бизнес-профиля (шаг а): вид аккаунта и домен компании из сайтов и почты, запрос засчитан. Запрос не
 * удался: вид unknown, домена нет (повтор решает prepare).
 */
export function withProfile(
  state: ChatCompanyState,
  profile: BusinessProfileResult,
): ChatCompanyState {
  const counted = { ...state, profileRequests: state.profileRequests + 1 };
  switch (profile.kind) {
    case 'business':
      return { ...counted, profileKind: 'business', profileDomain: domainFromProfile(profile) };
    case 'personal':
      return { ...counted, profileKind: 'personal', profileDomain: null };
    case 'failed':
      return { ...counted, profileKind: 'unknown', profileDomain: null };
  }
}

/** Кандидат из ответа lookup: ещё не спрошен. */
export function candidateFromLookup(
  found: CompanyCandidate,
  source: CandidateSource,
): ChatCandidate {
  return {
    id: found.id,
    name: found.name,
    city: found.city,
    source,
    askedAtMs: null,
    awaitingAnswer: false,
  };
}

/** Кандидат из справки завершённой проверки новой компании (источник research): ещё не спрошен. */
export function candidateFromBrief(brief: CompanyBrief): ChatCandidate {
  return {
    id: brief.id,
    name: brief.name,
    city: brief.city,
    source: 'research',
    askedAtMs: null,
    awaitingAnswer: false,
  };
}

/** Клиент сказал «да»: кандидат становится подтверждённой компанией (справки пока нет), кандидата больше нет. */
export function confirmCandidate(state: ChatCompanyState, nowMs: number): ChatCompanyState {
  const { candidate } = state;
  if (candidate === null) return state;
  return {
    ...state,
    candidate: null,
    confirmed: {
      id: candidate.id,
      name: candidate.name,
      city: candidate.city,
      confirmedAtMs: nowMs,
      brief: null,
      briefAtMs: null,
    },
  };
}

/**
 * Клиент сказал «нет, это не мы»: ID в отклонённые (без повтора), кандидат сброшен. Бесплатные шаги а, б, в и
 * логотип больше не идут (уже записанное время не меняется): дальше один вопрос о названии.
 */
export function rejectCandidate(state: ChatCompanyState, nowMs: number): ChatCompanyState {
  const { candidate } = state;
  if (candidate === null) return state;
  const rejectedIds = state.rejectedIds.includes(candidate.id)
    ? state.rejectedIds
    : [...state.rejectedIds, candidate.id];
  return {
    ...state,
    candidate: null,
    rejectedIds,
    freeStepsAtMs: state.freeStepsAtMs ?? nowMs,
    logoCheckedAtMs: state.logoCheckedAtMs ?? nowMs,
  };
}

/**
 * Бот спросил «Вы из компании X?» (awaitingAnswer true: ждём ответа) или только упомянул кандидата (false): время
 * вопроса записывается, и вопрос больше не задаётся. Спрошенного кандидата не трогает.
 */
export function markCandidateAsked(
  state: ChatCompanyState,
  nowMs: number,
  awaitingAnswer: boolean,
): ChatCompanyState {
  const { candidate } = state;
  if (candidate === null || candidate.askedAtMs !== null) return state;
  return { ...state, candidate: { ...candidate, askedAtMs: nowMs, awaitingAnswer } };
}

/** Как ушедший ответ говорит о ещё не спрошенном кандидате: confirm от модели считается вопросом. */
function replyMention(
  candidate: ChatCandidate | null,
  question: CompanyQuestion,
  sentText: string,
): ReplyMention {
  if (candidate === null || candidate.askedAtMs !== null) return 'none';
  return question === 'confirm' ? 'asked' : candidateInReply(sentText, candidate.name);
}

/**
 * Ответ бота ушёл клиенту. Кандидат ещё не спрошен, а модель отметила вопрос confirm или его название стоит в
 * предложении-вопросе (см. candidateInReply): вопрос задан, ждём ответа. Название только упомянуто: время вопроса
 * без ожидания (вопрос больше не задаётся, а «да» на другой вопрос компанию не подтвердит). Иначе ожидание прошлого
 * вопроса снимается (ответ на пачку ушёл, «да» или «нет» в ней не было). name: время вопроса о названии (его по
 * тексту не угадываем).
 */
export function afterReplySent(
  state: ChatCompanyState,
  question: CompanyQuestion,
  sentText: string,
  nowMs: number,
): ChatCompanyState {
  const mention = replyMention(state.candidate, question, sentText);
  const marked =
    mention === 'none'
      ? stopAwaiting(state)
      : markCandidateAsked(state, nowMs, mention === 'asked');
  return question === 'name' ? markNameAsked(marked, nowMs) : marked;
}

/** Клиент не ответил на вопрос о кандидате: ожидание снимается, и вопрос больше не задаётся. */
export function stopAwaiting(state: ChatCompanyState): ChatCompanyState {
  const { candidate } = state;
  if (candidate === null || !candidate.awaitingAnswer) return state;
  return { ...state, candidate: { ...candidate, awaitingAnswer: false } };
}

/** Бот спросил, из какой компании клиент: время вопроса. Название спрашивается один раз, второй вопрос не пишется. */
export function markNameAsked(state: ChatCompanyState, nowMs: number): ChatCompanyState {
  return state.nameAskedAtMs === null ? { ...state, nameAskedAtMs: nowMs } : state;
}

/** Справка подтверждённой компании и время её получения. Подтверждённой компании нет => состояние то же. */
export function withBrief(
  state: ChatCompanyState,
  brief: CompanyBrief,
  nowMs: number,
): ChatCompanyState {
  const { confirmed } = state;
  if (confirmed === null) return state;
  return { ...state, confirmed: { ...confirmed, brief, briefAtMs: nowMs } };
}

/**
 * Название и город компании со слов клиента: пробелы по краям убираются, название до 200 знаков, город до 100.
 * Пустое значение прежнее не стирает, новое непустое заменяет старое.
 */
export function withStatedCompany(
  state: ChatCompanyState,
  mention: Pick<CompanyMention, 'name' | 'city'>,
): ChatCompanyState {
  const statedName = clipText(mention.name, MAX_STATED_NAME_CHARS) ?? state.statedName;
  const statedCity = clipText(mention.city, MAX_STATED_CITY_CHARS) ?? state.statedCity;
  if (statedName === state.statedName && statedCity === state.statedCity) return state;
  return { ...state, statedName, statedCity };
}
