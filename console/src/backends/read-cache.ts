import type { Clock } from '../shared/clock.js';
import type { BackendResult } from './result.js';

const MAX_ENTRIES = 256;

export interface ReadCache {
  /** Результат из кэша (моложе cacheMs), из уже идущего такого же запроса или новый запрос. */
  load(key: string, request: () => Promise<BackendResult>): Promise<BackendResult>;
  /** После действия: кэш пуст, а запросы, начатые до действия, своих ответов в кэш не положат. */
  invalidate(): void;
}

/**
 * Объединение одинаковых одновременных чтений и короткий кэш: главная опрашивается раз в 15 с несколькими
 * вкладками и пользователями, а приложениям достаётся один запрос. Хранится не больше 256 ответов.
 */
export function createReadCache(clock: Clock, cacheMs: number): ReadCache {
  const cache = new Map<string, { readonly at: number; readonly result: BackendResult }>();
  const inflight = new Map<string, Promise<BackendResult>>();
  let generation = 0;

  const fresh = (key: string): BackendResult | null => {
    const entry = cache.get(key);
    if (entry === undefined) return null;
    if (clock.now() - entry.at < cacheMs) return entry.result;
    cache.delete(key);
    return null;
  };

  const remember = (key: string, result: BackendResult, startedGeneration: number): void => {
    if (startedGeneration !== generation) return;
    const nowMs = clock.now();
    // Устаревшие ответы убираются сразу, а не только при повторном таком же запросе.
    for (const [cachedKey, entry] of cache) {
      if (nowMs - entry.at >= cacheMs) cache.delete(cachedKey);
    }
    cache.set(key, { at: nowMs, result });
    while (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
  };

  return {
    load(key, request) {
      const hit = fresh(key);
      if (hit !== null) return Promise.resolve(hit);
      const running = inflight.get(key);
      if (running !== undefined) return running;
      const startedGeneration = generation;
      const pending = request()
        .then((result) => {
          remember(key, result, startedGeneration);
          return result;
        })
        .finally(() => {
          if (inflight.get(key) === pending) inflight.delete(key);
        });
      inflight.set(key, pending);
      return pending;
    },
    invalidate() {
      generation += 1;
      cache.clear();
      inflight.clear();
    },
  };
}
