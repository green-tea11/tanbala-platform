import { DisconnectReason } from 'baileys';
import { describe, expect, it } from 'vitest';
import {
  decideOnDisconnect,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_DELAY_MS,
  type DisconnectContext,
} from '../../../src/whatsapp/reconnect.js';

// attempt: номер попытки подряд с 1, как считает адаптер (первый разрыв после подключения => 1).
function context(overrides: Partial<DisconnectContext> = {}): DisconnectContext {
  return { code: DisconnectReason.connectionClosed, attempt: 1, pairing: false, ...overrides };
}

/** Решения для попыток 1..RECONNECT_MAX_ATTEMPTS подряд. */
function decisionsInRow(): ReturnType<typeof decideOnDisconnect>[] {
  return Array.from({ length: RECONNECT_MAX_ATTEMPTS }, (_, index) =>
    decideOnDisconnect(context({ attempt: index + 1 })),
  );
}

// Коды, после которых переподключение не поможет или повысит риск бана.
const FINAL_CODES = [
  [DisconnectReason.loggedOut, 'logged_out'],
  [DisconnectReason.forbidden, 'forbidden'],
  [DisconnectReason.connectionReplaced, 'replaced'],
] as const;

// Временные сбои: 408 вне привязки, 428, 500, 503, 411 и коды, которых Baileys не знает.
const TRANSIENT_CODES = [
  DisconnectReason.timedOut,
  DisconnectReason.connectionClosed,
  DisconnectReason.badSession,
  DisconnectReason.unavailableService,
  DisconnectReason.multideviceMismatch,
  undefined,
  999,
];

describe('decideOnDisconnect: окончательные коды', () => {
  it('коды совпадают с DisconnectReason Baileys 7', () => {
    expect([401, 403, 440, 408, 515]).toEqual([
      DisconnectReason.loggedOut,
      DisconnectReason.forbidden,
      DisconnectReason.connectionReplaced,
      DisconnectReason.timedOut,
      DisconnectReason.restartRequired,
    ]);
  });

  it.each(
    FINAL_CODES.flatMap(([code, reason]) =>
      [true, false].map((pairing) => ({ code, reason, pairing })),
    ),
  )(
    'код $code (pairing: $pairing) => stop $reason без переподключения',
    ({ code, reason, pairing }) => {
      expect(decideOnDisconnect(context({ code, pairing }))).toEqual({ action: 'stop', reason });
    },
  );

  it('окончательный код важнее исчерпанных попыток', () => {
    const decision = decideOnDisconnect(
      context({ code: DisconnectReason.loggedOut, attempt: RECONNECT_MAX_ATTEMPTS + 1 }),
    );

    expect(decision).toEqual({ action: 'stop', reason: 'logged_out' });
  });
});

describe('decideOnDisconnect: привязка по QR', () => {
  it('408 во время привязки (QR истёк) => stop pairing_timeout: новый QR только по команде владельца', () => {
    const decision = decideOnDisconnect(
      context({ code: DisconnectReason.timedOut, pairing: true }),
    );

    expect(decision).toEqual({ action: 'stop', reason: 'pairing_timeout' });
  });

  it.each(TRANSIENT_CODES)(
    'любой другой временный код %s во время привязки тоже stop pairing_timeout: новый сокет истратил бы вторую попытку',
    (code) => {
      expect(decideOnDisconnect(context({ code, pairing: true }))).toEqual({
        action: 'stop',
        reason: 'pairing_timeout',
      });
    },
  );

  it('515 сразу после привязки => переподключение без паузы, это продолжение того же сеанса', () => {
    const decision = decideOnDisconnect(
      context({ code: DisconnectReason.restartRequired, pairing: true }),
    );

    expect(decision).toEqual({ action: 'reconnect', delayMs: 0 });
  });
});

describe('decideOnDisconnect: временные сбои', () => {
  it('515 в обычной работе => переподключение без паузы', () => {
    const decision = decideOnDisconnect(
      context({ code: DisconnectReason.restartRequired, attempt: 3 }),
    );

    expect(decision).toEqual({ action: 'reconnect', delayMs: 0 });
  });

  it.each(TRANSIENT_CODES)('код %s => переподключение с паузой', (code) => {
    expect(decideOnDisconnect(context({ code }))).toEqual({
      action: 'reconnect',
      delayMs: RECONNECT_BASE_DELAY_MS,
    });
  });

  it('пауза растёт вдвое от 1 с на первой попытке и упирается в 30 с', () => {
    const delays = decisionsInRow().map((decision) =>
      decision.action === 'reconnect' ? decision.delayMs : null,
    );

    expect(delays.slice(0, 7)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(delays.every((delay) => delay !== null && delay <= RECONNECT_MAX_DELAY_MS)).toBe(true);
  });

  it('общее ожидание до отказа ограничено несколькими минутами', () => {
    const total = decisionsInRow().reduce(
      (sum, decision) => sum + (decision.action === 'reconnect' ? decision.delayMs : 0),
      0,
    );

    expect(total).toBeGreaterThan(60_000);
    expect(total).toBeLessThanOrEqual(5 * 60_000);
  });

  it('последняя допустимая попытка ещё переподключается', () => {
    expect(decideOnDisconnect(context({ attempt: RECONNECT_MAX_ATTEMPTS }))).toEqual({
      action: 'reconnect',
      delayMs: RECONNECT_MAX_DELAY_MS,
    });
  });

  it.each([RECONNECT_MAX_ATTEMPTS + 1, RECONNECT_MAX_ATTEMPTS + 5])(
    'попытка %i: предел исчерпан => stop gave_up',
    (attempt) => {
      expect(decideOnDisconnect(context({ attempt }))).toEqual({
        action: 'stop',
        reason: 'gave_up',
      });
    },
  );

  it('предел действует и на 515: бесконечный цикл мгновенных переподключений невозможен', () => {
    const decision = decideOnDisconnect(
      context({ code: DisconnectReason.restartRequired, attempt: RECONNECT_MAX_ATTEMPTS + 1 }),
    );

    expect(decision).toEqual({ action: 'stop', reason: 'gave_up' });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'испорченный счётчик попыток %s => stop gave_up, а не цикл без паузы',
    (attempt) => {
      expect(decideOnDisconnect(context({ attempt }))).toEqual({
        action: 'stop',
        reason: 'gave_up',
      });
    },
  );
});

describe('decideOnDisconnect: чистая функция', () => {
  it('не меняет вход и на одинаковый вход отвечает одинаково', () => {
    const input = Object.freeze(context({ attempt: 2 }));

    expect(decideOnDisconnect(input)).toEqual(decideOnDisconnect(input));
    expect(input).toEqual(context({ attempt: 2 }));
  });
});
