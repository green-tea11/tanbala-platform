import { setTimeout as delay } from 'node:timers/promises';
import type { Clock } from '../domain/ports.js';

/**
 * Системные часы для рабочего режима. В тестах вместо них фейковые часы.
 * now: Date.now, мс UTC. sleep: setTimeout из node:timers/promises с передачей signal: остановка прерывает
 * паузу, и промис отклоняется с AbortError (name 'AbortError'), поэтому код после паузы не выполняется.
 */
export function createSystemClock(): Clock {
  return {
    now: (): number => Date.now(),
    sleep: async (ms: number, signal?: AbortSignal): Promise<void> => {
      await delay(ms, undefined, { signal });
    },
  };
}
