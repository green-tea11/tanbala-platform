import type { HandoffReason, InterestLevel } from '../domain/types.js';

/** Уровни интереса от холодного к горячему, как в CHECK таблиц chats и handoffs. */
export const LEVELS: readonly InterestLevel[] = ['cold', 'warm', 'hot'];

/** Причины передачи, как в CHECK таблицы handoffs. */
export const HANDOFF_REASONS: readonly HandoffReason[] = [
  'hot',
  'no_answer',
  'check_failed',
  'asked_human',
  'complaint',
  'human_took_over',
  'llm_error',
  'limit',
];

/**
 * Проверяет число из запроса (limit, offset): целое не меньше нуля. Без проверки отрицательный LIMIT в SQLite
 * означал бы «без лимита», а NaN молча стал бы NULL.
 */
export function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name}: ожидается целое число не меньше нуля`);
  }
}

/**
 * Значение колонки, закреплённой CHECK, из известного набора. Другое значение значит, что строка испорчена:
 * догадываться нельзя, поэтому явная ошибка с описанием, где именно.
 */
export function oneOf<T extends string>(allowed: readonly T[], value: string, problem: string): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`${problem}: строка испорчена`);
  return found;
}
