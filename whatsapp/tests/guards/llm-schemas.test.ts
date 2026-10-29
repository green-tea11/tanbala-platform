import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { logoSchema, replyDraftSchema } from '../../src/agent/agent.js';
import { interestSchema } from '../../src/agent/interest.js';
import { reviewSchema } from '../../src/agent/review.js';

// API отклоняет схему структурированного ответа (400 invalid_request_error), если в ней больше 16 параметров
// с union-типами (anyOf или массив type, например nullable). 29.10.2026 так сломалась оценка интереса: 17 nullable.
const MAX_UNION_PARAMS = 16;

function unionParams(node: unknown): number {
  if (node === null || typeof node !== 'object') return 0;
  if (Array.isArray(node)) return node.reduce((sum: number, item) => sum + unionParams(item), 0);
  const record = node as Record<string, unknown>;
  const own = Array.isArray(record['anyOf']) || Array.isArray(record['type']) ? 1 : 0;
  return own + Object.values(record).reduce((sum: number, value) => sum + unionParams(value), 0);
}

const SCHEMAS: Record<string, z.ZodType> = {
  reply: replyDraftSchema,
  review: reviewSchema,
  interest: interestSchema,
  logo: logoSchema,
};

describe('схемы вызовов Claude в пределах API', () => {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    it(`${name}: не больше ${MAX_UNION_PARAMS} параметров с union-типами`, () => {
      const format = zodOutputFormat(schema);
      expect(unionParams(format.schema)).toBeLessThanOrEqual(MAX_UNION_PARAMS);
    });
  }

  it('оценка интереса: невыясненное текстовое поле пустая строка, nullable только has1C', () => {
    expect(unionParams(zodOutputFormat(interestSchema).schema)).toBe(1);
  });
});
