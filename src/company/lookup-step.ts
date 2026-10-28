import type {
  CandidateSource,
  CompanyCandidate,
  CompanyId,
  CompanyLookupQuery,
} from '../domain/company.js';
import type { ChatId } from '../domain/types.js';
import type { CompanyEnv } from './env.js';
import { logFailure } from './log.js';
import { pickCandidate } from './pick-candidate.js';

/**
 * Итог одного шага поиска. found: выбран кандидат. none: подходящей компании нет, в том числе после отказа 400
 * (bad_request: запрос не примут и при повторе), шаг считается пройденным. retry: ответа по существу нет (API
 * недоступно, не ответило за 3 с, отказало в доступе, не знает адрес, ответило не по контракту или лимитом), шаг
 * нужно повторить на следующей пачке.
 */
export type LookupOutcome =
  | { readonly kind: 'found'; readonly candidate: CompanyCandidate }
  | { readonly kind: 'none' }
  | { readonly kind: 'retry' };

/**
 * Один запрос lookup и выбор кандидата по правилам (pickCandidate). step: откуда ищем, он же в логе вместе с кодом
 * сбоя; сбои API приходят значением и наружу не бросаются.
 */
export async function lookupCompany(
  env: CompanyEnv,
  chatId: ChatId,
  step: CandidateSource,
  query: CompanyLookupQuery,
  rejectedIds: readonly CompanyId[],
): Promise<LookupOutcome> {
  const result = await env.directory.lookup(query);
  if (!result.ok) {
    logFailure(env.logger, chatId, step, result.failure);
    return result.failure === 'bad_request' ? { kind: 'none' } : { kind: 'retry' };
  }
  const candidate = pickCandidate(result.value, rejectedIds);
  return candidate === null ? { kind: 'none' } : { kind: 'found', candidate };
}
