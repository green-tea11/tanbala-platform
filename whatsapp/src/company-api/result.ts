import type { CompanyApiFailure, CompanyApiResult } from '../domain/company.js';

// Результат вызова API приходит значением, а не исключением (domain/company.ts: CompanyApiResult).

export function ok<T>(value: T): CompanyApiResult<T> {
  return { ok: true, value };
}

export function fail(failure: CompanyApiFailure): CompanyApiResult<never> {
  return { ok: false, failure };
}
