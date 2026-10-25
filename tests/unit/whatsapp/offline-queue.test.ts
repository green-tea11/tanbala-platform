import { describe, expect, it, vi, type Mock } from 'vitest';
import type { Clock } from '../../../src/domain/ports.js';
import {
  createOfflineQueueWatch,
  OFFLINE_QUEUE_FALLBACK_MS,
  OFFLINE_QUIET_MS,
  type OfflineQueueSource,
  type OfflineQueueWatch,
} from '../../../src/whatsapp/offline-queue.js';

const NOW = Date.UTC(2026, 9, 25, 9, 0, 0);

interface Sleep {
  readonly ms: number;
  settled: boolean;
  readonly resolve: () => void;
}

interface FakeClock {
  readonly clock: Clock;
  setNow(ms: number): void;
  pending(ms: number): number;
  release(ms: number): void;
}

function createFakeClock(): FakeClock {
  let nowMs = NOW;
  const sleeps: Sleep[] = [];
  return {
    clock: {
      now: () => nowMs,
      sleep: (ms, signal) =>
        new Promise<void>((resolve, reject) => {
          const entry: Sleep = { ms, settled: false, resolve };
          sleeps.push(entry);
          signal?.addEventListener(
            'abort',
            () => {
              entry.settled = true;
              reject(new Error('Пауза прервана'));
            },
            { once: true },
          );
        }),
    },
    setNow: (ms) => {
      nowMs = ms;
    },
    pending: (ms) => sleeps.filter((entry) => entry.ms === ms && !entry.settled).length,
    release: (ms) => {
      const entry = sleeps.find((candidate) => candidate.ms === ms && !candidate.settled);
      if (entry === undefined) throw new Error(`Нет паузы ${String(ms)} мс`);
      entry.settled = true;
      entry.resolve();
    },
  };
}

interface Setup {
  readonly watch: OfflineQueueWatch;
  readonly finish: Mock<(source: OfflineQueueSource) => void>;
  readonly clock: FakeClock;
  readonly socket: AbortController;
}

function setup(): Setup {
  const clock = createFakeClock();
  const socket = new AbortController();
  const finish = vi.fn<(source: OfflineQueueSource) => void>();
  const watch = createOfflineQueueWatch({ clock: clock.clock, signal: socket.signal, finish });
  return { watch, finish, clock, socket };
}

async function until(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { interval: 1, timeout: 1000 });
}

describe('whatsapp/offline-queue', () => {
  it('признак конца офлайн-очереди: finish после OFFLINE_QUIET_MS тишины', async () => {
    const { watch, finish, clock } = setup();

    watch.signalled();
    expect(clock.pending(OFFLINE_QUIET_MS)).toBe(1);
    clock.release(OFFLINE_QUIET_MS);

    await until(() => expect(finish).toHaveBeenCalledWith('signal'));
    expect(watch.complete('signal')).toBe(true);
  });

  it('новые пачки append во время ожидания продлевают его', async () => {
    const { watch, finish, clock } = setup();
    watch.signalled();

    watch.appended();
    clock.release(OFFLINE_QUIET_MS);
    await until(() => expect(clock.pending(OFFLINE_QUIET_MS)).toBe(1));
    expect(finish).not.toHaveBeenCalled();
    clock.release(OFFLINE_QUIET_MS);

    await until(() => expect(finish).toHaveBeenCalledWith('signal'));
  });

  it('ожидание тишины не дольше OFFLINE_QUEUE_FALLBACK_MS от признака', async () => {
    const { watch, finish, clock } = setup();
    watch.signalled();

    watch.appended();
    clock.setNow(NOW + OFFLINE_QUEUE_FALLBACK_MS);
    clock.release(OFFLINE_QUIET_MS);

    await until(() => expect(finish).toHaveBeenCalledWith('signal'));
    expect(clock.pending(OFFLINE_QUIET_MS)).toBe(0);
  });

  it('повторный признак во время ожидания второго ожидания не запускает', () => {
    const { watch, clock } = setup();

    watch.signalled();
    watch.signalled();

    expect(clock.pending(OFFLINE_QUIET_MS)).toBe(1);
  });

  it('страховка: после open без признака finish(fallback) через OFFLINE_QUEUE_FALLBACK_MS', async () => {
    const { watch, finish, clock } = setup();

    watch.opened();
    clock.release(OFFLINE_QUEUE_FALLBACK_MS);

    await until(() => expect(finish).toHaveBeenCalledWith('fallback'));
    expect(watch.complete('fallback')).toBe(true);
  });

  it('страховка молчит, если признак уже пришёл, и не завершает очередь после него', async () => {
    const { watch, finish, clock } = setup();
    watch.opened();
    watch.signalled();

    clock.release(OFFLINE_QUEUE_FALLBACK_MS);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(finish).not.toHaveBeenCalled();
    expect(watch.complete('fallback')).toBe(false);
    expect(watch.complete('signal')).toBe(true);
  });

  it('после завершения новый признак снова ждёт тишину', () => {
    const { watch, clock } = setup();
    watch.opened();
    expect(watch.complete('fallback')).toBe(true);

    watch.signalled();

    expect(clock.pending(OFFLINE_QUIET_MS)).toBe(1);
  });

  it('сокет закрыт: ни страховка, ни тишина finish не вызывают', async () => {
    const { watch, finish, clock, socket } = setup();
    watch.opened();
    watch.signalled();

    socket.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(clock.pending(OFFLINE_QUIET_MS)).toBe(0);
    expect(clock.pending(OFFLINE_QUEUE_FALLBACK_MS)).toBe(0);
    expect(finish).not.toHaveBeenCalled();
  });
});
