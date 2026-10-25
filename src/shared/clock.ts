import type { Clock } from '../domain/ports.js';
import { notImplemented } from './todo.js';

/**
 * Системные часы для рабочего режима. В тестах вместо них фейковые часы.
 * TODO(этап 2): now через Date.now (мс UTC); sleep через setTimeout из node:timers/promises с передачей signal, чтобы остановка прерывала паузу.
 */
export function createSystemClock(): Clock {
  return notImplemented('этап 2', 'shared/clock.createSystemClock');
}
