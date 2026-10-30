/** Чей запрос: чтение (опросы страниц) или действие человека. */
export type SlotKind = 'read' | 'action';

/**
 * Не больше maxActive запросов к приложению сразу; очередь до maxQueued. Часть мест (reservedForActions) чтению
 * недоступна: зависшие опросы не займут все места, и «Ответить» или «Одобрить» уйдёт сразу.
 */
export interface Semaphore {
  /**
   * Занимает место. true — место получено (вызвать release ровно один раз); false — очередь полна или срок по
   * signal вышел, пока ждали (место не занято, release не нужен).
   */
  acquire(signal: AbortSignal, kind?: SlotKind): Promise<boolean>;
  release(): void;
}

interface Waiter {
  grant(): void;
}

/**
 * maxActive мест: действия занимают любое, чтения — не больше maxActive − reservedForActions (но хотя бы одно).
 * Освободившееся место сначала получает ждущее действие, потом ждущее чтение, если для чтений есть место.
 */
export function createSemaphore(
  maxActive: number,
  maxQueued: number,
  reservedForActions = 1,
): Semaphore {
  const readLimit = Math.max(1, maxActive - reservedForActions);
  let active = 0;
  const queues: Record<SlotKind, Waiter[]> = { action: [], read: [] };
  const limitOf = (kind: SlotKind): number => (kind === 'action' ? maxActive : readLimit);
  const queued = (): number => queues.action.length + queues.read.length;

  const pump = (): void => {
    for (const kind of ['action', 'read'] as const) {
      const queue = queues[kind];
      while (queue.length > 0 && active < limitOf(kind)) {
        const next = queue.shift();
        if (next === undefined) break;
        active += 1;
        next.grant();
      }
    }
  };

  return {
    acquire(signal, kind = 'read') {
      if (signal.aborted) return Promise.resolve(false);
      if (active < limitOf(kind) && queues[kind].length === 0) {
        active += 1;
        return Promise.resolve(true);
      }
      if (queued() >= maxQueued) return Promise.resolve(false);
      const queue = queues[kind];
      return new Promise<boolean>((resolve) => {
        const onAbort = (): void => {
          const index = queue.indexOf(waiter);
          if (index < 0) return;
          queue.splice(index, 1);
          resolve(false);
        };
        const waiter: Waiter = {
          grant: () => {
            signal.removeEventListener('abort', onAbort);
            resolve(true);
          },
        };
        signal.addEventListener('abort', onAbort, { once: true });
        queue.push(waiter);
      });
    },
    release() {
      active -= 1;
      pump();
    },
  };
}
