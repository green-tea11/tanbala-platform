import { describe, expect, it, vi, type Mock } from 'vitest';
import type { ConnectionState } from 'baileys';
import type { Clock, Logger } from '../../../src/domain/ports.js';
import type { DisconnectContext, ReconnectDecision } from '../../../src/whatsapp/reconnect.js';
import {
  createReconnectPolicy,
  MAX_RECONNECTS_PER_HOUR,
  STABLE_CONNECTION_MS,
} from '../../../src/whatsapp/reconnect-policy.js';

const NOW = Date.UTC(2026, 9, 25, 9, 0, 0);
const HOUR_MS = 3_600_000;

interface LogEntry {
  readonly level: string;
  readonly context: Readonly<Record<string, unknown>>;
}

function createLogger(entries: LogEntry[]): Logger {
  const log =
    (level: string) =>
    (context: Readonly<Record<string, unknown>>): void => {
      entries.push({ level, context });
    };
  const logger: Logger = {
    level: 'info',
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    fatal: log('fatal'),
    silent: log('silent'),
    child: () => logger,
  };
  return logger;
}

interface ManualClock {
  readonly clock: Clock;
  setNow(ms: number): void;
  /** Завершает последнюю паузу. */
  finish(): void;
}

function createClock(): ManualClock {
  let nowMs = NOW;
  let finish: () => void = () => undefined;
  return {
    clock: {
      now: () => nowMs,
      sleep: (_ms, signal) =>
        new Promise<void>((resolve, reject) => {
          finish = resolve;
          signal?.addEventListener('abort', () => reject(new Error('Пауза прервана')), {
            once: true,
          });
        }),
    },
    setNow: (ms) => {
      nowMs = ms;
    },
    finish: () => finish(),
  };
}

function closed(code: number | undefined): Partial<ConnectionState> {
  const error =
    code === undefined
      ? new Error('ws closed')
      : Object.assign(new Error('closed'), { output: { statusCode: code } });
  return { connection: 'close', lastDisconnect: { error, date: new Date() } };
}

function setup(decision: ReconnectDecision = { action: 'reconnect', delayMs: 1000 }): {
  policy: ReturnType<typeof createReconnectPolicy>;
  decide: Mock<(context: DisconnectContext) => ReconnectDecision>;
  clock: ManualClock;
  logs: LogEntry[];
} {
  const logs: LogEntry[] = [];
  const clock = createClock();
  const decide = vi.fn<(context: DisconnectContext) => ReconnectDecision>(() => decision);
  const policy = createReconnectPolicy({ decide, clock: clock.clock, logger: createLogger(logs) });
  return { policy, decide, clock, logs };
}

/** Даёт выполниться обработчикам промисов после завершения паузы. */
async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('whatsapp/reconnect-policy', () => {
  it('передаёт в решение код, номер разрыва подряд и признак привязки', () => {
    const { policy, decide } = setup();

    expect(policy.afterClose(closed(428), false)).toEqual({ action: 'reconnect', delayMs: 1000 });
    policy.afterClose(closed(503), true);

    expect(decide.mock.calls.map(([context]) => context)).toEqual([
      { code: 428, attempt: 1, pairing: false },
      { code: 503, attempt: 2, pairing: true },
    ]);
  });

  it.each([
    ['обычная ошибка без кода', new Error('ws closed')],
    ['output без statusCode', Object.assign(new Error('boom'), { output: {} })],
    ['statusCode не число', Object.assign(new Error('boom'), { output: { statusCode: '428' } })],
    ['ошибки нет', undefined],
  ])('код не определён (%s) => code undefined', (_case, error) => {
    const { policy, decide } = setup();

    policy.afterClose({ connection: 'close', lastDisconnect: { error, date: new Date() } }, false);

    expect(decide).toHaveBeenCalledWith({ code: undefined, attempt: 1, pairing: false });
  });

  it('WhatsApp отклонил версию (405): стоп version_rejected без решения', () => {
    const { policy, decide, logs } = setup();

    expect(policy.afterClose(closed(405), true)).toEqual({
      action: 'stop',
      reason: 'version_rejected',
    });
    expect(decide).not.toHaveBeenCalled();
    expect(logs).toContainEqual(expect.objectContaining({ level: 'error' }));
  });

  it('решение упало: стоп reconnect_failed, ошибка в лог', () => {
    const { policy, decide, logs } = setup();
    decide.mockImplementation(() => {
      throw new Error('неизвестный код');
    });

    expect(policy.afterClose(closed(499), false)).toEqual({
      action: 'stop',
      reason: 'reconnect_failed',
    });
    expect(logs).toContainEqual(expect.objectContaining({ level: 'error' }));
  });

  it('стоп-решение проходит как есть и в лимит переподключений не идёт', () => {
    const { policy } = setup({ action: 'stop', reason: 'logged_out' });

    expect(policy.afterClose(closed(401), false)).toEqual({ action: 'stop', reason: 'logged_out' });
  });

  it('больше MAX_RECONNECTS_PER_HOUR переподключений за час: стоп gave_up', () => {
    const { policy } = setup();

    const outcomes = Array.from({ length: MAX_RECONNECTS_PER_HOUR + 1 }, () =>
      policy.afterClose(closed(428), false),
    );

    expect(outcomes.slice(0, MAX_RECONNECTS_PER_HOUR).every((o) => o.action === 'reconnect')).toBe(
      true,
    );
    expect(outcomes.at(-1)).toEqual({ action: 'stop', reason: 'gave_up' });
  });

  it('окно скользящее: через час старые переподключения не считаются', () => {
    const { policy, clock } = setup();
    for (let index = 0; index < MAX_RECONNECTS_PER_HOUR; index += 1) {
      policy.afterClose(closed(428), false);
    }

    clock.setNow(NOW + HOUR_MS);

    expect(policy.afterClose(closed(428), false).action).toBe('reconnect');
  });

  it('счётчик разрывов сбрасывается только после STABLE_CONNECTION_MS связи', async () => {
    const { policy, decide, clock } = setup();
    policy.afterClose(closed(428), false);
    const opened = new AbortController();

    policy.opened(opened.signal);
    clock.finish();
    await flushPromises();
    policy.afterClose(closed(428), false);

    expect(decide.mock.calls.map(([context]) => context.attempt)).toEqual([1, 1]);
    expect(STABLE_CONNECTION_MS).toBe(5 * 60_000);
  });

  it('сокет закрылся раньше STABLE_CONNECTION_MS: счётчик не сбрасывается', async () => {
    const { policy, decide } = setup();
    policy.afterClose(closed(428), false);
    const opened = new AbortController();

    policy.opened(opened.signal);
    opened.abort();
    await flushPromises();
    policy.afterClose(closed(428), false);

    expect(decide.mock.calls.map(([context]) => context.attempt)).toEqual([1, 2]);
  });
});
