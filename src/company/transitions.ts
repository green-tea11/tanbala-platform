import type {
  CandidateSource,
  ChatCandidate,
  ChatCompanyState,
  CompanyBrief,
  CompanyCandidate,
  CompanyMention,
  ResearchState,
} from '../domain/company.js';
import type { BusinessProfileResult } from '../domain/ports.js';
import { clipText } from './clip-text.js';
import { domainFromProfile } from './profile-domain.js';

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
 * Итог запроса бизнес-профиля (шаг а): вид аккаунта и домен компании из сайтов и почты. Запрос не удался: вид
 * unknown (второй раз профиль не запрашивается), домена нет.
 */
export function withProfile(
  state: ChatCompanyState,
  profile: BusinessProfileResult,
): ChatCompanyState {
  switch (profile.kind) {
    case 'business':
      return { ...state, profileKind: 'business', profileDomain: domainFromProfile(profile) };
    case 'personal':
      return { ...state, profileKind: 'personal', profileDomain: null };
    case 'failed':
      return { ...state, profileKind: 'unknown', profileDomain: null };
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

/** Клиент сказал «нет, это не мы»: ID в отклонённые (без повтора), кандидат сброшен. */
export function rejectCandidate(state: ChatCompanyState): ChatCompanyState {
  const { candidate } = state;
  if (candidate === null) return state;
  const rejectedIds = state.rejectedIds.includes(candidate.id)
    ? state.rejectedIds
    : [...state.rejectedIds, candidate.id];
  return { ...state, candidate: null, rejectedIds };
}

/** Бот спросил «Вы из компании X?»: время вопроса и ожидание ответа. Спрошенного кандидата не трогает. */
export function markCandidateAsked(state: ChatCompanyState, nowMs: number): ChatCompanyState {
  const { candidate } = state;
  if (candidate === null || candidate.askedAtMs !== null) return state;
  return { ...state, candidate: { ...candidate, askedAtMs: nowMs, awaitingAnswer: true } };
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
