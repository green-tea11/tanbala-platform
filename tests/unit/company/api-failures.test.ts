import { describe, expect, it } from 'vitest';
import { isTransientBriefFailure, isTransientFailure } from '../../../src/company/api-failures.js';
import type { CompanyApiFailure } from '../../../src/domain/company.js';

// Какие сбои внутреннего API временные (повтор на следующей пачке, попытки не тратятся), а какие постоянные.

const TRANSIENT: readonly CompanyApiFailure[] = [
  'unavailable',
  'timeout',
  'unauthorized',
  'not_found',
  'invalid_response',
];

const PERMANENT: readonly CompanyApiFailure[] = ['bad_request', 'rate_limited', 'budget_exhausted'];

describe('isTransientFailure: поиск (lookup)', () => {
  it.each(TRANSIENT)('%s: временный', (failure) => {
    expect(isTransientFailure(failure)).toBe(true);
  });

  it.each(PERMANENT)('%s: постоянный', (failure) => {
    expect(isTransientFailure(failure)).toBe(false);
  });
});

describe('isTransientBriefFailure: справка подтверждённой или готовой компании', () => {
  it.each(TRANSIENT.filter((failure) => failure !== 'not_found'))('%s: временный', (failure) => {
    expect(isTransientBriefFailure(failure)).toBe(true);
  });

  it.each([...PERMANENT, 'not_found' as const])(
    '%s: постоянный (компании с этим ID в проекте B больше нет)',
    (failure) => {
      expect(isTransientBriefFailure(failure)).toBe(false);
    },
  );
});
