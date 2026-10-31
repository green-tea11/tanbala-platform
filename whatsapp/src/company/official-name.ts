import type { ChatCompanyState } from '../domain/company.js';
import { normalizeName } from './normalize-name.js';

// Вопрос об официальном названии (решение владельца 30.10.2026): проверка новой компании по названию клиента ничего не
// нашла, бот один раз спрашивает «Подскажите, как компания называется официально?», и по ответу идёт вторая, последняя
// в чате проверка. Снова ничего: о компании больше не спрашивают.

/** Признак вопроса об официальном названии в отправленном тексте: слово с этой основой. */
const OFFICIAL_STEM = 'официальн';

/**
 * Проверка новой компании закончилась ничем: 2ГИС не нашёл подходящую карточку (not_in_2gis) или нашлась не та
 * компания (клиент от неё отказался). Другие неудачи (предел, бюджет, сбой, город) не в счёт: вопрос не поможет.
 */
export function researchFoundNothing(state: ChatCompanyState): boolean {
  const { research } = state;
  if (research?.status === 'failed') return research.reason === 'not_in_2gis';
  return research?.status === 'done' && state.rejectedIds.includes(research.companyId);
}

/**
 * Можно один раз спросить официальное название: клиент называл компанию, проверка по нему ничего не нашла
 * (researchFoundNothing), кандидата и подтверждённой компании нет, официальное название ещё не спрашивали.
 */
export function mayAskOfficialName(state: ChatCompanyState): boolean {
  if (state.officialNameAskedAtMs !== null || state.statedName === null) return false;
  if (state.candidate !== null || state.confirmed !== null) return false;
  return researchFoundNothing(state);
}

/**
 * Можно запустить вторую проверку по названию name: официальное название спрашивали, второй проверки ещё не было,
 * первая не идёт, а name после нормализации не то, по которому уже проверяли (клиент назвал новое).
 */
export function mayResearchOfficialName(state: ChatCompanyState, name: string): boolean {
  if (state.officialNameAskedAtMs === null || state.officialResearchStartedAtMs !== null) {
    return false;
  }
  const status = state.research?.status;
  if (status === 'queued' || status === 'running') return false;
  return normalizeName(name) !== state.researchName;
}

/** В отправленном тексте есть вопрос об официальном названии («как компания называется официально»). */
export function asksOfficialName(sentText: string): boolean {
  return normalizeName(sentText)
    .split(' ')
    .some((word) => word.startsWith(OFFICIAL_STEM));
}
