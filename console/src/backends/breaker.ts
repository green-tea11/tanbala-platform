/** Сколько таймаутов подряд размыкают чтение и на сколько. */
export interface BreakerOptions {
  readonly threshold: number;
  readonly openMs: number;
}

export const DEFAULT_BREAKER: BreakerOptions = { threshold: 3, openMs: 10_000 };

/**
 * Предохранитель чтения у одного приложения: после threshold таймаутов подряд чтения openMs не отправляются и сразу
 * получают «недоступно». Так зависшее приложение не копит опросы в очереди и не держит места, нужные действиям.
 * Действия предохранитель не останавливает. После паузы первое же чтение идёт к приложению: новый таймаут снова
 * размыкает, любой ответ сбрасывает счёт.
 */
export interface ReadBreaker {
  /** Разомкнут ли сейчас: чтение не отправлять. */
  isOpen(nowMs: number): boolean;
  /** Итог обмена (таймаут или нет). true — предохранитель только что разомкнулся (для строки в лог). */
  record(timedOut: boolean, nowMs: number): boolean;
}

export function createReadBreaker(options: BreakerOptions = DEFAULT_BREAKER): ReadBreaker {
  let timeouts = 0;
  let openUntil = -Infinity;
  return {
    isOpen: (nowMs) => nowMs < openUntil,
    record(timedOut, nowMs) {
      if (!timedOut) {
        timeouts = 0;
        return false;
      }
      timeouts += 1;
      if (timeouts < options.threshold) return false;
      openUntil = nowMs + options.openMs;
      return true;
    },
  };
}
