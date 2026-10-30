/** Не больше maxActive запросов к приложению сразу; очередь до maxQueued. */
export interface Semaphore {
  /**
   * Занимает место. true — место получено (вызвать release ровно один раз); false — очередь полна или срок по
   * signal вышел, пока ждали (место не занято, release не нужен).
   */
  acquire(signal: AbortSignal): Promise<boolean>;
  release(): void;
}

interface Waiter {
  grant(): void;
}

export function createSemaphore(maxActive: number, maxQueued: number): Semaphore {
  let active = 0;
  const queue: Waiter[] = [];
  return {
    acquire(signal) {
      if (signal.aborted) return Promise.resolve(false);
      if (active < maxActive) {
        active += 1;
        return Promise.resolve(true);
      }
      if (queue.length >= maxQueued) return Promise.resolve(false);
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
      // Место переходит следующему в очереди, а если очереди нет — освобождается.
      const next = queue.shift();
      if (next === undefined) active -= 1;
      else next.grant();
    },
  };
}
