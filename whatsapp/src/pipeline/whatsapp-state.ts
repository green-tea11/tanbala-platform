import type { WhatsAppLinkState, WhatsAppStateSnapshot } from '../domain/console.js';
import type { Clock } from '../domain/ports.js';

/** Последнее состояние сокета по событиям connection.update: пишет адаптер WhatsApp, читает консоль. */
export interface WhatsAppStateTracker {
  /** Новое состояние; то же самое время не сдвигает. */
  update(state: WhatsAppLinkState): void;
  snapshot(): WhatsAppStateSnapshot;
}

/**
 * Наблюдатель за подключением для консоли: только запоминает состояние и время его смены, на работу бота не влияет.
 * До первого события connecting (запуск идёт); остановка адаптера сообщает closed.
 */
export function createWhatsAppStateTracker(clock: Pick<Clock, 'now'>): WhatsAppStateTracker {
  let current: WhatsAppStateSnapshot = { state: 'connecting', sinceMs: clock.now() };
  return {
    update(state: WhatsAppLinkState): void {
      if (state !== current.state) current = { state, sinceMs: clock.now() };
    },
    snapshot: () => current,
  };
}
