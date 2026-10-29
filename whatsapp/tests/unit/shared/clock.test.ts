import { describe, expect, it, vi } from 'vitest';
import { createSystemClock } from '../../../src/shared/clock.js';

// Настоящие таймеры: node:timers/promises не подменяется фейковыми таймерами Vitest.
const SHORT_MS = 30;
const LONG_MS = 10_000;
// Таймеры ОС срабатывают с погрешностью в пару миллисекунд.
const TIMER_SLACK_MS = 5;

describe('shared/clock createSystemClock', () => {
  it('now отдаёт Date.now: мс UTC', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_792_000_000_000);

    expect(createSystemClock().now()).toBe(1_792_000_000_000);
  });

  it('sleep ждёт не меньше заданного времени', async () => {
    const started = performance.now();

    await createSystemClock().sleep(SHORT_MS);

    expect(performance.now() - started).toBeGreaterThanOrEqual(SHORT_MS - TIMER_SLACK_MS);
  });

  it('sleep(0) завершается', async () => {
    await expect(createSystemClock().sleep(0)).resolves.toBeUndefined();
  });

  it('уже отменённый signal: пауза сразу отклоняется с AbortError', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(createSystemClock().sleep(LONG_MS, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('отмена во время паузы прерывает её с AbortError, не дожидаясь конца', async () => {
    const controller = new AbortController();
    const started = performance.now();
    setTimeout(() => controller.abort(), SHORT_MS);

    await expect(createSystemClock().sleep(LONG_MS, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(performance.now() - started).toBeLessThan(LONG_MS / 2);
  });

  it('signal, который так и не отменили, паузе не мешает', async () => {
    await expect(
      createSystemClock().sleep(SHORT_MS, new AbortController().signal),
    ).resolves.toBeUndefined();
  });
});
