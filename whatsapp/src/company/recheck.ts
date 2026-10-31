import type { ChatCompanyState } from '../domain/company.js';
import type { ChatId } from '../domain/types.js';
import type { CompanyEnv } from './env.js';
import { lookupStatedNames, statedNames } from './lookup-step.js';
import { normalizeName } from './normalize-name.js';
import { candidateFromLookup } from './transitions.js';

/**
 * Клиент назвал компанию, а кандидат уже есть (по профилю, номеру, логотипу, прошлому названию или проверке) и ответа
 * на вопрос о нём не ждём (не спрошен или спрошен без ответа): поиск по названию клиента, один раз на название
 * (lookedUpName). Нашлась другая компания (другой ID): старый кандидат снимается без отклонения (клиент от него не
 * отказывался), предлагается новый с источником message. Ищут по названию клиента, затем по его вариантам. Тот же ID, ничего или неоднозначно: кандидат остаётся,
 * строгое несовпадение названий его не снимает («Magnum» и «Magnum Cash&Carry»). Временный сбой поиска: состояние то
 * же, поиск повторится. Поиска нет, если название клиента после нормализации пустое или совпадает с кандидатом.
 */
export async function recheckCandidate(
  env: CompanyEnv,
  chatId: ChatId,
  state: ChatCompanyState,
): Promise<ChatCompanyState> {
  const { candidate, statedName } = state;
  if (candidate === null || candidate.awaitingAnswer || statedName === null) return state;
  const normalized = normalizeName(statedName);
  if (normalized === '' || normalized === state.lookedUpName) return state;
  if (normalized === normalizeName(candidate.name)) return state;
  const names = statedNames(statedName, state.statedAliases);
  const outcome = await lookupStatedNames(env, chatId, names, state.rejectedIds);
  if (outcome.kind === 'retry') return state;
  const searched = { ...state, lookedUpName: normalized };
  if (outcome.kind === 'none' || outcome.candidate.id === candidate.id) return searched;
  env.logger.info(
    { chatId, step: 'message' },
    'Клиент назвал другую компанию: кандидат заменён найденной по его словам',
  );
  return { ...searched, candidate: candidateFromLookup(outcome.candidate, 'message') };
}
