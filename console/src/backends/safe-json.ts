/** Пределы ответа почты и бота: больше этого консоль не принимает (ответ считается неверным). */
export interface JsonLimits {
  readonly maxDepth: number;
  readonly maxArrayItems: number;
  readonly maxObjectKeys: number;
  readonly maxKeyLength: number;
  /** Текст сайта компании до 20 000 символов: с запасом. */
  readonly maxStringLength: number;
}

export const DEFAULT_JSON_LIMITS: JsonLimits = {
  maxDepth: 16,
  maxArrayItems: 5000,
  maxObjectKeys: 300,
  maxKeyLength: 100,
  maxStringLength: 100_000,
};

/** Ключи, через которые копия объекта могла бы задеть прототип: пропускаются. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

class LimitExceeded extends Error {}

function copyValue(value: unknown, depth: number, limits: JsonLimits): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new LimitExceeded('number');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > limits.maxStringLength) throw new LimitExceeded('string');
    return value;
  }
  if (depth >= limits.maxDepth) throw new LimitExceeded('depth');
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayItems) throw new LimitExceeded('array');
    return Object.freeze(value.map((item: unknown) => copyValue(item, depth + 1, limits)));
  }
  if (typeof value === 'object') return copyObject(value, depth, limits);
  throw new LimitExceeded('type');
}

function copyObject(value: object, depth: number, limits: JsonLimits): object {
  const entries = Object.entries(value);
  if (entries.length > limits.maxObjectKeys) throw new LimitExceeded('keys');
  const copy: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    if (key.length > limits.maxKeyLength) throw new LimitExceeded('key');
    if (FORBIDDEN_KEYS.has(key)) continue;
    copy[key] = copyValue(item, depth + 1, limits);
  }
  return Object.freeze(copy);
}

/**
 * Свежая неизменяемая копия разобранного JSON в пределах limits: только JSON-типы, без ключей __proto__ и
 * constructor. Вышли за предел: null (ответ приложения считается неверным).
 */
export function toSafeJson(value: unknown, limits: JsonLimits = DEFAULT_JSON_LIMITS): unknown {
  try {
    return copyValue(value, 0, limits);
  } catch (error: unknown) {
    if (error instanceof LimitExceeded) return null;
    throw error;
  }
}

/** Разбирает текст ответа как JSON и копирует его в пределах; не JSON или вне пределов: undefined. */
export function parseSafeJson(text: string, limits: JsonLimits = DEFAULT_JSON_LIMITS): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const copy = toSafeJson(parsed, limits);
  return copy === null && parsed !== null ? undefined : copy;
}
