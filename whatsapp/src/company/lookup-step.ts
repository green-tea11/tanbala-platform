import type {
  CandidateSource,
  CompanyCandidate,
  CompanyId,
  CompanyLookupQuery,
} from '../domain/company.js';
import type { ChatId } from '../domain/types.js';
import { isTransientFailure } from './api-failures.js';
import type { CompanyEnv } from './env.js';
import { logFailure } from './log.js';
import { normalizeName } from './normalize-name.js';
import { MIN_PROFILE_NAME_SCORE, pickCandidate } from './pick-candidate.js';

/**
 * Итог одного шага поиска. found: выбран кандидат. none: подходящей компании нет, в том числе после постоянного сбоя
 * (bad_request: запрос не примут и при повторе; rate_limited и budget_exhausted поиск по контракту не отдаёт), шаг
 * считается пройденным. retry: временный сбой (см. isTransientFailure), шаг нужно повторить на следующей пачке.
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
    return isTransientFailure(result.failure) ? { kind: 'retry' } : { kind: 'none' };
  }
  const candidate =
    step === 'profile_name'
      ? pickCandidate(result.value, rejectedIds, MIN_PROFILE_NAME_SCORE)
      : pickCandidate(result.value, rejectedIds);
  return candidate === null ? { kind: 'none' } : { kind: 'found', candidate };
}

/**
 * Названия для поиска по словам клиента по порядку: само название, затем его варианты (statedAliases). Пустые после
 * нормализации и повторы (после нормализации: регистр, кавычки, формы собственности не в счёт) пропускаются.
 */
export function statedNames(name: string, aliases: readonly string[]): readonly string[] {
  const all = [name, ...aliases];
  const keys = all.map(normalizeName);
  return all.filter((_item, index) => {
    const key = keys[index] ?? '';
    return key !== '' && keys.indexOf(key) === index;
  });
}

/**
 * Шаг г: поиск по названию клиента, затем по каждому варианту по очереди (statedNames). Первая находка или временный
 * сбой (retry) останавливает поиск; ни по одному ничего: none.
 */
export async function lookupStatedNames(
  env: CompanyEnv,
  chatId: ChatId,
  names: readonly string[],
  rejectedIds: readonly CompanyId[],
): Promise<LookupOutcome> {
  for (const name of names) {
    const outcome = await lookupCompany(env, chatId, 'message', { by: 'name', name }, rejectedIds);
    if (outcome.kind !== 'none') return outcome;
  }
  return { kind: 'none' };
}
