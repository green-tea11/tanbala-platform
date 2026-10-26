import { describe, expect, it, vi } from 'vitest';
import type { Clock, Logger } from '../../../src/domain/ports.js';
import type { ChatId, InboundMessage, Jid, WaMessageId } from '../../../src/domain/types.js';
import {
  createChatBatcher,
  type ChatBatcher,
  type ClientBatch,
} from '../../../src/pipeline/batcher.js';

// Очередь на поддельных часах: паузы завершаются только при advance, настоящих таймеров нет.

const NOW = Date.UTC(2026, 9, 26, 9, 0, 0);
const DEBOUNCE_MS = 4000;
const MAX_WAIT_MS = 15_000;
const CHAT_A = 1 as ChatId;
const CHAT_B = 2 as ChatId;
const JID = '77000000002@s.whatsapp.net' as Jid;

interface Sleep {
  readonly until: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  done: boolean;
}

interface ManualClock {
  readonly clock: Clock;
  /** Сдвигает время и завершает паузы, срок которых наступил. */
  advance(ms: number): Promise<void>;
  /** Следующая пауза сразу падает: сломанный таймер. */
  breakNext(): void;
}

function createManualClock(): ManualClock {
  let nowMs = NOW;
  let broken = false;
  const sleeps: Sleep[] = [];
  const clock: Clock = {
    now: () => nowMs,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (broken) {
          broken = false;
          reject(new Error('таймер сломан'));
          return;
        }
        const entry: Sleep = { until: nowMs + ms, resolve, reject, done: false };
        sleeps.push(entry);
        signal?.addEventListener(
          'abort',
          () => {
            if (entry.done) return;
            entry.done = true;
            reject(new Error('Пауза прервана'));
          },
          { once: true },
        );
      }),
  };
  return {
    clock,
    advance: async (ms) => {
      nowMs += ms;
      for (const entry of sleeps) {
        if (!entry.done && entry.until <= nowMs) {
          entry.done = true;
          entry.resolve();
        }
      }
      await settle();
    },
    breakNext: () => {
      broken = true;
    },
  };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function message(id: string, tsMs = NOW): InboundMessage {
  return {
    waId: id as WaMessageId,
    identity: { replyJid: JID, lidJid: null, pnJid: JID },
    pushName: null,
    content: { kind: 'text', text: 'Здравствуйте' },
    tsMs,
  };
}

function createLogger(errors: unknown[]): Logger {
  const noop = (): void => undefined;
  const logger: Logger = {
    level: 'info',
    trace: noop,
    debug: noop,
    info: noop,
    warn: (context) => {
      errors.push({ level: 'warn', context });
    },
    error: (context) => {
      errors.push({ level: 'error', context });
    },
    fatal: noop,
    silent: noop,
    child: () => logger,
  };
  return logger;
}

interface Harness {
  readonly batcher: ChatBatcher;
  readonly time: ManualClock;
  readonly batches: ClientBatch[];
  readonly logs: unknown[];
  /** waId пачек по порядку вызова onBatch. */
  ids(): string[][];
}

function setup(onBatch?: (batch: ClientBatch) => Promise<void>): Harness {
  const time = createManualClock();
  const batches: ClientBatch[] = [];
  const logs: unknown[] = [];
  const batcher = createChatBatcher({
    clock: time.clock,
    debounceMs: DEBOUNCE_MS,
    maxWaitMs: MAX_WAIT_MS,
    logger: createLogger(logs),
    onBatch: (batch) => {
      batches.push(batch);
      return onBatch === undefined ? Promise.resolve() : onBatch(batch);
    },
  });
  return {
    batcher,
    time,
    batches,
    logs,
    ids: () => batches.map((batch) => batch.messages.map((item) => String(item.waId))),
  };
}

describe('pipeline/batcher: склейка', () => {
  it('сообщения подряд: одна пачка после тишины debounceMs, по времени сообщения', async () => {
    const h = setup();

    h.batcher.push(CHAT_A, message('m2', NOW + 2));
    await h.time.advance(1000);
    h.batcher.push(CHAT_A, message('m1', NOW + 1));
    await h.time.advance(DEBOUNCE_MS - 1);
    expect(h.batches).toEqual([]);
    await h.time.advance(1);

    expect(h.ids()).toEqual([['m1', 'm2']]);
    expect(h.batches[0]?.chatId).toBe(CHAT_A);
  });

  it('клиент пишет без пауз: пачка уходит не позже maxWaitMs от первого сообщения', async () => {
    const h = setup();

    for (let index = 0; index < 6; index += 1) {
      h.batcher.push(CHAT_A, message(`m${index}`));
      await h.time.advance(3000);
    }

    expect(h.ids()).toEqual([['m0', 'm1', 'm2', 'm3', 'm4']]);
  });

  it('сломанный таймер не теряет пачку: она уходит сразу', async () => {
    const h = setup();
    h.time.breakNext();

    h.batcher.push(CHAT_A, message('m1'));
    await settle();

    expect(h.ids()).toEqual([['m1']]);
  });
});

describe('pipeline/batcher: очередь по чату', () => {
  it('чат строго по очереди: новая пачка ждёт конца предыдущей; другой чат идёт параллельно', async () => {
    const gate = deferred();
    const h = setup((batch) => (batch.chatId === CHAT_A ? gate.promise : Promise.resolve()));
    h.batcher.push(CHAT_A, message('a1'));
    await h.time.advance(DEBOUNCE_MS);

    h.batcher.push(CHAT_A, message('a2'));
    h.batcher.push(CHAT_B, message('b1'));
    await h.time.advance(MAX_WAIT_MS);
    expect(h.ids()).toEqual([['a1'], ['b1']]);
    gate.resolve();
    await settle();

    expect(h.ids()).toEqual([['a1'], ['b1'], ['a2']]);
  });

  it('takeNewer забирает пришедшие во время обработки сообщения: отдельной пачки из них нет', async () => {
    const gate = deferred();
    const taken: string[][] = [];
    const h = setup(async (batch) => {
      if (batch.messages[0]?.waId !== 'm1') return;
      await gate.promise;
      taken.push(batch.takeNewer().map((item) => String(item.waId)));
    });
    h.batcher.push(CHAT_A, message('m1'));
    await h.time.advance(DEBOUNCE_MS);
    h.batcher.push(CHAT_A, message('m3', NOW + 3));
    h.batcher.push(CHAT_A, message('m2', NOW + 2));

    gate.resolve();
    await settle();
    await h.time.advance(MAX_WAIT_MS);

    expect(taken).toEqual([['m2', 'm3']]);
    expect(h.ids()).toEqual([['m1']]);
  });

  it('сбой обработки пачки пишется в лог, следующая пачка чата обрабатывается', async () => {
    const onBatch = vi
      .fn<(batch: ClientBatch) => Promise<void>>()
      .mockRejectedValueOnce(new Error('база недоступна'))
      .mockResolvedValue(undefined);
    const h = setup(onBatch);

    h.batcher.push(CHAT_A, message('m1'));
    await h.time.advance(DEBOUNCE_MS);
    h.batcher.push(CHAT_A, message('m2'));
    await h.time.advance(DEBOUNCE_MS);

    expect(h.ids()).toEqual([['m1'], ['m2']]);
    expect(h.logs).toEqual([
      { level: 'error', context: expect.objectContaining({ chatId: CHAT_A }) as unknown },
    ]);
  });
});

describe('pipeline/batcher: остановка', () => {
  it('drain отдаёт накопленное сразу и ждёт всех пачек; после drain очередь не принимает', async () => {
    const gate = deferred();
    const h = setup((batch) => (batch.chatId === CHAT_A ? gate.promise : Promise.resolve()));
    h.batcher.push(CHAT_A, message('a1'));
    await h.time.advance(DEBOUNCE_MS);
    h.batcher.push(CHAT_A, message('a2'));
    h.batcher.push(CHAT_B, message('b1'));
    let drained = false;

    const draining = h.batcher.drain().then(() => {
      drained = true;
    });
    await settle();
    expect(h.ids()).toEqual([['a1'], ['b1']]);
    expect(drained).toBe(false);
    gate.resolve();
    await draining;
    h.batcher.push(CHAT_B, message('b2'));
    await h.time.advance(MAX_WAIT_MS);

    expect(h.ids()).toEqual([['a1'], ['b1'], ['a2']]);
    expect(h.logs).toEqual([
      { level: 'warn', context: expect.objectContaining({ chatId: CHAT_B }) as unknown },
    ]);
  });

  it('drain без пачек завершается сразу', async () => {
    const h = setup();

    await expect(h.batcher.drain()).resolves.toBeUndefined();
  });
});
