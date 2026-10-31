import type { ChatCandidate, ChatCompanyState } from '../domain/company.js';
import type { ChatId } from '../domain/types.js';
import type { CompanyEnv } from './env.js';
import { MIN_CONFIRM_SIMILARITY, nameSimilarity, sameCity } from './name-match.js';
import { confirmCandidate } from './transitions.js';

/**
 * Кандидат найден по словам клиента уверенно (решение владельца 30.10.2026): источник шаг г (message) или проверка
 * новой компании (research); название карточки похоже на название клиента или один из его вариантов не меньше чем на
 * 0.9 (MIN_CONFIRM_SIMILARITY); город карточки тот же, что назвал клиент. Клиент город не называл: шаг г ищет по всей
 * базе почты, поэтому достаточно названия; проверка новой компании шла в городе по умолчанию, поэтому нужен вопрос.
 */
export function foundByClientWords(state: ChatCompanyState, candidate: ChatCandidate): boolean {
  const { statedName, statedCity, statedAliases } = state;
  if (candidate.source !== 'message' && candidate.source !== 'research') return false;
  if (statedName === null) return false;
  const names = [statedName, ...statedAliases];
  const similar = names.some(
    (name) => nameSimilarity(name, candidate.name) >= MIN_CONFIRM_SIMILARITY,
  );
  if (!similar) return false;
  if (statedCity === null) return candidate.source === 'message';
  return sameCity(candidate.city, statedCity);
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
