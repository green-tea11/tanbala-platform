import type { Clock } from '../domain/ports.js';

/** Срок вышел раньше, чем закончилась работа. */
export const TIMED_OUT = Symbol('timed-out');

/**
 * Работа за ms миллисекунд по часам clock (в тестах фейковые, настоящих пауз нет). Срок вышел: TIMED_OUT, а сигнал
 * отмены уходит в работу, чтобы она остановилась (fetch, чтение потока). Работа успела: её значение, пауза отменяется.
 * Сбой работы поднимается наверх; сбой после срока уже никому не нужен и необработанным отказом не становится.
 * Пауза, которая упала сразу (сломанные часы), считается сроком: безопаснее остановить работу, чем ждать без предела.
 * Работа, бросившая сразу без промиса, тоже сбой: он поднимается наверх, а пауза отменяется.
 */
export async function withDeadline<T>(
  clock: Clock,
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T | typeof TIMED_OUT> {
  const stop = new AbortController();
  const timedOut = (): typeof TIMED_OUT => TIMED_OUT;
  const timer = clock.sleep(ms, stop.signal).then(timedOut, timedOut);
  // Исполнитель промиса превращает синхронное исключение в отказ; работа стартует сразу.
  const running = new Promise<T>((resolve) => {
    resolve(work(stop.signal));
  });
  running.catch(() => undefined);
  try {
    return await Promise.race([running, timer]);
  } finally {
    stop.abort();
  }
}
