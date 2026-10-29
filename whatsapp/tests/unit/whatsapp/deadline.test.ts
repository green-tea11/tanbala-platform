import { describe, expect, it } from 'vitest';
import type { Clock } from '../../../src/domain/ports.js';
import { TIMED_OUT, withDeadline } from '../../../src/whatsapp/deadline.js';

// Часы подделаны: пауза заканчивается только по команде release или по сигналу отмены.

interface ManualClock {
  readonly clock: Clock;
  /** Сколько мс просили у пауз, по порядку. */
  readonly requested: number[];
  /** Прерывались ли паузы сигналом. */
  readonly aborted: boolean[];
  /** Завершает самую раннюю паузу штатно (срок вышел). */
  release(): void;
}

function createManualClock(): ManualClock {
  const requested: number[] = [];
  const aborted: boolean[] = [];
  const releases: (() => void)[] = [];
  const clock: Clock = {
    now: () => 0,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        const index = requested.push(ms) - 1;
        aborted.push(false);
        releases.push(resolve);
        signal?.addEventListener('abort', () => {
          aborted[index] = true;
          reject(new Error('Пауза прервана'));
        });
      }),
  };
  return {
    clock,
    requested,
    aborted,
    release: () => {
      releases.shift()?.();
    },
  };
}

describe('whatsapp/deadline withDeadline', () => {
  it('работа успела раньше срока: её значение, а пауза отменена', async () => {
    const manual = createManualClock();

    const result = await withDeadline(manual.clock, 10_000, () => Promise.resolve('готово'));

    expect(result).toBe('готово');
    expect(manual.requested).toEqual([10_000]);
    expect(manual.aborted).toEqual([true]);
  });

  it('срок вышел раньше работы: TIMED_OUT, а сигнал отмены уходит в работу', async () => {
    const manual = createManualClock();
    let workSignal: AbortSignal | undefined;

    const pending = withDeadline(manual.clock, 10_000, (signal) => {
      workSignal = signal;
      return new Promise<string>(() => undefined);
    });
    manual.release();
    const result = await pending;

    expect(result).toBe(TIMED_OUT);
    expect(workSignal?.aborted).toBe(true);
  });

  it('сбой работы поднимается наверх, пауза отменяется', async () => {
    const manual = createManualClock();

    await expect(
      withDeadline(manual.clock, 10_000, () => Promise.reject(new Error('сбой'))),
    ).rejects.toThrow('сбой');
    expect(manual.aborted).toEqual([true]);
  });

  it('работа бросила сразу, без промиса: сбой поднимается наверх, пауза отменяется', async () => {
    const manual = createManualClock();

    await expect(
      withDeadline(manual.clock, 10_000, () => {
        throw new Error('сразу');
      }),
    ).rejects.toThrow('сразу');
    expect(manual.aborted).toEqual([true]);
  });

  it('сбой работы после срока не становится необработанным отказом', async () => {
    const manual = createManualClock();
    let fail: (error: Error) => void = () => undefined;

    const pending = withDeadline(
      manual.clock,
      10_000,
      () =>
        new Promise<string>((_resolve, reject) => {
          fail = reject;
        }),
    );
    manual.release();
    expect(await pending).toBe(TIMED_OUT);
    fail(new Error('поздний сбой'));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('сломанные часы (пауза падает сразу) считаются сроком: безопаснее остановить работу', async () => {
    const clock: Clock = { now: () => 0, sleep: () => Promise.reject(new Error('сломано')) };

    const result = await withDeadline(clock, 10_000, () => new Promise<string>(() => undefined));

    expect(result).toBe(TIMED_OUT);
  });
});
