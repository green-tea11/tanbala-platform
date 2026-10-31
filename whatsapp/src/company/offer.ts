import type { ChatCandidate, ChatCompanyState } from '../domain/company.js';
import type { ChatId } from '../domain/types.js';
import type { CompanyEnv } from './env.js';
import { confidentNameMatch, sameCity } from './name-match.js';
import { confirmCandidate } from './transitions.js';

/** Кандидаты по признакам надёжнее слов клиента: их не заменяет без вопроса найденное по названию (ревью этапа 3). */
const STRONG_SOURCES: ReadonlySet<ChatCandidate['source']> = new Set([
  'profile_domain',
  'phone',
  'profile_name',
  'logo',
]);

/**
 * Кандидат найден по словам клиента уверенно (решение владельца 30.10.2026): источник шаг г (message) или проверка
 * новой компании (research); название карточки совпадает с названием, которое написал сам клиент (confidentNameMatch:
 * похожесть от 0.9, те же цифры, короткие названия полностью); город карточки тот же, что назвал клиент. По ревью
 * этапа 3 вопрос остаётся, если клиент город не называл (тёзки в базе почты), если совпал только вариант названия от
 * модели (это догадка, например «Тинькофф» и «Т-Банк») и если найденное заменяет кандидата по номеру, домену, имени
 * профиля или логотипу.
 */
export function foundByClientWords(state: ChatCompanyState, candidate: ChatCandidate): boolean {
  const { statedName, statedCity } = state;
  if (candidate.source !== 'message' && candidate.source !== 'research') return false;
  if (statedName === null || statedCity === null) return false;
  const previous = state.candidate;
  if (previous !== null && previous.id !== candidate.id && STRONG_SOURCES.has(previous.source)) {
    return false;
  }
  return confidentNameMatch(statedName, candidate.name) && sameCity(candidate.city, statedCity);
}

/**
 * Найденная компания по словам клиента: найдена уверенно (foundByClientWords) => сразу подтверждена без вопроса
 * «X, Алматы, верно?» (справку запрашивает ensureBrief), иначе становится кандидатом, о котором бот спросит. В лог
 * только ID чата и шаг.
 */
export function offerFound(
  env: CompanyEnv,
  chatId: ChatId,
  state: ChatCompanyState,
  candidate: ChatCandidate,
): ChatCompanyState {
  const offered = { ...state, candidate };
  if (!foundByClientWords(state, candidate)) return offered;
  env.logger.info(
    { chatId, step: candidate.source },
    'Компания найдена по словам клиента уверенно: подтверждена без вопроса',
  );
  return confirmCandidate(offered, env.clock.now());
}
