import type { CompanyApiFailure } from '../domain/company.js';

/**
 * Временные сбои внутреннего API, одни для поиска (lookup), справки и подхвата готовой компании после запуска
 * проверки: проект B недоступен (сеть, 5xx, пауза после сбоя), не ответил за 3 с, отказал в доступе (токен
 * поправят), не знает адрес (404: другая версия проекта B) или ответил не по контракту. Запрос повторяется на
 * следующей пачке и попыток не тратит. Постоянные (bad_request, rate_limited, budget_exhausted): повтор того же
 * запроса не поможет, попытка тратится. Запуск проверки новой компании решает сам (research.ts): он неидемпотентный.
 */
const TRANSIENT_FAILURES: ReadonlySet<CompanyApiFailure> = new Set([
  'unavailable',
  'timeout',
  'unauthorized',
  'not_found',
  'invalid_response',
]);

/** Сбой поиска временный: шаг не засчитывается и повторится на следующей пачке. */
export function isTransientFailure(failure: CompanyApiFailure): boolean {
  return TRANSIENT_FAILURES.has(failure);
}

/**
 * Сбой справки временный: неудача не считается (briefFailures, adoptFailures). Те же временные сбои, кроме
 * not_found: ID компании дал сам проект B (поиск или проверка), и 404 по нему значит, что компании там больше нет
 * (удалили или слили с другой). Это постоянно: попытка тратится, и после трёх справку больше не запрашивают, а не
 * спрашивают на каждой пачке без конца.
 */
export function isTransientBriefFailure(failure: CompanyApiFailure): boolean {
  return failure !== 'not_found' && isTransientFailure(failure);
}
