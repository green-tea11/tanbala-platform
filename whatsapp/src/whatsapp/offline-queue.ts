import type { Clock } from '../domain/ports.js';

/** Признак конца офлайн-очереди не пришёл за это время после open: завершение по страховке. */
export const OFFLINE_QUEUE_FALLBACK_MS = 60_000;
/** После признака конца офлайн-очереди ждём столько тишины без новых пачек 'append'. */
export const OFFLINE_QUIET_MS = 5_000;

/** Почему офлайн-очередь считается разобранной: признак receivedPendingNotifications или страховка. */
export type OfflineQueueSource = 'signal' | 'fallback';

/** Ожидание конца офлайн-очереди одного сокета. */
export interface OfflineQueueWatch {
  /** Сокет открыт: страховка на случай, если признак не придёт (зависание буфера Baileys, issue #2810). */
  opened(): void;
  /** Пришла пачка 'append': офлайн-очередь ещё выдаётся, тишина не наступила. */
  appended(): void;
  /** Признак receivedPendingNotifications: ждать тишину и завершить. Повтор во время ожидания ничего не меняет. */
  signalled(): void;
  /** В очереди событий: завершать ли сейчас. Страховка не завершает очередь после признака. */
  complete(source: OfflineQueueSource): boolean;
}

/** Настройки ожидания. */
export interface OfflineQueueWatchOptions {
  readonly clock: Clock;
  /** Прерывается при закрытии сокета или остановке: таймеры снимаются, finish не вызывается. */
  readonly signal: AbortSignal;
  /** Таймер решил завершить: адаптер ставит завершение в очередь событий после уже пришедших пачек. */
  readonly finish: (source: OfflineQueueSource) => void;
}

/**
 * После признака конца офлайн-очереди Baileys ещё выдаёт пачки 'append' (повторы расшифровки, хвост буфера), поэтому
 * завершение ждёт OFFLINE_QUIET_MS без них, но не дольше OFFLINE_QUEUE_FALLBACK_MS от признака. Без признака
 * страховка завершает очередь через OFFLINE_QUEUE_FALLBACK_MS после open. Позднее завершение безопасно: список
 * простоя берётся из базы, повторный вызов только дошлёт то, что пришло позже.
 */
export function createOfflineQueueWatch(options: OfflineQueueWatchOptions): OfflineQueueWatch {
  const { clock, signal, finish } = options;
  let state: 'waiting' | 'quiet' | 'done' = 'waiting';
  let appends = 0;
  const waitForQuiet = async (): Promise<void> => {
    const deadline = clock.now() + OFFLINE_QUEUE_FALLBACK_MS;
    for (;;) {
      const seen = appends;
      const waitMs = Math.min(OFFLINE_QUIET_MS, deadline - clock.now());
      if (waitMs <= 0) return;
      await clock.sleep(waitMs, signal);
      if (appends === seen) return;
    }
  };
  return {
    opened(): void {
      clock.sleep(OFFLINE_QUEUE_FALLBACK_MS, signal).then(
        () => {
          if (state === 'waiting') finish('fallback');
        },
        // Сокет закрыт или остановка: страховка больше не нужна.
        () => undefined,
      );
    },
    appended(): void {
      appends += 1;
    },
    signalled(): void {
      if (state === 'quiet') return;
      state = 'quiet';
      waitForQuiet().then(
        () => finish('signal'),
        // Сокет закрыт или остановка во время ожидания: очередь не завершена.
        () => undefined,
      );
    },
    complete(source: OfflineQueueSource): boolean {
      if (source === 'fallback' && state !== 'waiting') return false;
      state = 'done';
      return true;
    },
  };
}
