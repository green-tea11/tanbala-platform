import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initAuthCreds, proto } from 'baileys';
import type {
  AuthenticationCreds,
  AuthenticationState,
  BaileysEventMap,
  Chat,
  UserFacingSocketConfig,
  WABusinessProfile,
  WAMessage,
  WAMessageKey,
} from 'baileys';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Clock, Logger, PairingDecision } from '../../../src/domain/ports.js';
import type {
  Jid,
  MediaRef,
  PhoneDigits,
  WaMessageId,
  WorkingMode,
} from '../../../src/domain/types.js';
import { SafeError } from '../../../src/shared/safe-error.js';
import {
  LINKED_AT_SKEW_MS,
  LinkBoundaryMissingError,
  PairingLimitError,
  startWhatsApp,
  type FetchedVersion,
  type HistoryChat,
  type LoadedAuthState,
  type WaSocket,
  type WhatsAppConnection,
  type WhatsAppDeps,
  type WhatsAppStopReason,
} from '../../../src/whatsapp/connection.js';
import {
  classifyUpsert,
  type ClassifyContext,
  type WaEvent,
} from '../../../src/whatsapp/inbound.js';
import {
  decideOnDisconnect,
  RECONNECT_BASE_DELAY_MS,
  type DisconnectContext,
  type ReconnectDecision,
} from '../../../src/whatsapp/reconnect.js';
import {
  OFFLINE_QUEUE_FALLBACK_MS,
  OFFLINE_QUIET_MS,
} from '../../../src/whatsapp/offline-queue.js';
import {
  MAX_RECONNECTS_PER_HOUR,
  STABLE_CONNECTION_MS,
} from '../../../src/whatsapp/reconnect-policy.js';
import type { ProfileFetch } from '../../../src/whatsapp/contacts.js';
import { VERSION_FETCH_TIMEOUT_MS } from '../../../src/whatsapp/socket-config.js';
import type { MediaDownload } from '../../../src/whatsapp/voice-media.js';

// Все тесты на поддельном сокете, близком к Baileys rc14: close приходит из end() отдельной пачкой, затем буфер
// событий уничтожается и обработчики снимаются. К WhatsApp никто не подключается, сеть заблокирована (tests/setup).
// Разбор сообщений и решения о разрыве настоящие (whatsapp/inbound.ts, whatsapp/reconnect.ts), но под шпионом.

const NOW = Date.UTC(2026, 9, 25, 9, 0, 0);
const HOUR_MS = 3_600_000;
const BACKLOG_MAX_AGE_MS = 12 * HOUR_MS;
const FIRST_DELAY_MS = RECONNECT_BASE_DELAY_MS;
const QR = '2@pairing-ref-1,bm9pc2U=,aWRlbnRpdHk=,YWR2';
const VERSION: FetchedVersion = { version: [2, 3000, 1_000_000_001], isLatest: true };
const SELF_ID = '77000000001:12@s.whatsapp.net';
const SELF_LID = '100000000000001:12@lid';
const CLIENT_PHONE = '77000000002';
const CLIENT_PN = '77000000002@s.whatsapp.net';
const CLIENT_LID = '200000000000002@lid';
const OTHER_PN = '77000000004@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const MANAGER_PHONE = '77000000003' as PhoneDigits;
const MANAGER_PN = '77000000003@s.whatsapp.net';

interface LogEntry {
  readonly level: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly message: string | undefined;
}

function createFakeLogger(entries: LogEntry[]): Logger {
  const log =
    (level: string) =>
    (context: Readonly<Record<string, unknown>>, message?: string): void => {
      entries.push({ level, context, message });
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

interface FakeClock {
  readonly clock: Clock;
  setNow(ms: number): void;
  /** Сколько незавершённых пауз такой длины. */
  pending(ms: number): number;
  /** Завершает самую раннюю незавершённую паузу такой длины. */
  release(ms: number): void;
  /** Следующая пауза такой длины сразу падает: сломанный таймер. */
  failNext(ms: number): void;
}

interface Sleep {
  readonly ms: number;
  settled: boolean;
  readonly resolve: () => void;
}

function createFakeClock(): FakeClock {
  let nowMs = NOW;
  const sleeps: Sleep[] = [];
  const failing: number[] = [];
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const broken = failing.indexOf(ms);
      if (broken !== -1 || signal?.aborted === true) {
        if (broken !== -1) failing.splice(broken, 1);
        reject(new Error('Пауза прервана'));
        return;
      }
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
    });
  return {
    clock: { now: () => nowMs, sleep },
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
    failNext: (ms) => {
      failing.push(ms);
    },
  };
}

interface AuthStore {
  readonly loadAuthState: Mock<(folder: string) => Promise<LoadedAuthState>>;
  readonly saveCreds: Mock<() => Promise<void>>;
  /** Запись состояния последнего сокета «на диск»: то, что делает настоящий saveCreds. */
  persist(): void;
  /** Состояние последнего сокета: Baileys меняет creds в памяти. */
  current(): AuthenticationState;
}

function createAuthStore(linked: boolean): AuthStore {
  let saved: AuthenticationCreds = linked
    ? { ...initAuthCreds(), me: { id: SELF_ID } }
    : initAuthCreds();
  let current: AuthenticationState | null = null;
  const persist = (): void => {
    if (current !== null) saved = { ...current.creds };
  };
  const saveCreds = vi.fn((): Promise<void> => {
    persist();
    return Promise.resolve();
  });
  const loadAuthState = vi.fn<(folder: string) => Promise<LoadedAuthState>>(() => {
    const state: AuthenticationState = {
      creds: { ...saved },
      keys: { get: () => ({}), set: () => undefined },
    };
    current = state;
    return Promise.resolve({ state, saveCreds: () => saveCreds() });
  });
  return {
    loadAuthState,
    saveCreds,
    persist,
    current: () => {
      if (current === null) throw new Error('Сессия ещё не загружена');
      return current;
    },
  };
}

type Handler = (events: Partial<BaileysEventMap>) => void | Promise<void>;

interface FakeSocket {
  readonly config: UserFacingSocketConfig;
  readonly end: Mock<(error: Error | undefined) => Promise<void>>;
  readonly flush: Mock<() => boolean>;
  readonly sendMessage: Mock<WaSocket['sendMessage']>;
  readonly sendPresenceUpdate: Mock<WaSocket['sendPresenceUpdate']>;
  readonly readMessages: Mock<WaSocket['readMessages']>;
  readonly getBusinessProfile: Mock<WaSocket['getBusinessProfile']>;
  readonly profilePictureUrl: Mock<WaSocket['profilePictureUrl']>;
  /** Есть ли подписчик: Baileys снимает обработчики при закрытии, адаптер отписывается сам. */
  listening(): boolean;
  emit(events: Partial<BaileysEventMap>): void;
  /** Событие копится в буфере Baileys и выдаётся только по flush; при закрытии буфер пропадает. */
  buffer(events: Partial<BaileysEventMap>): void;
  /** Соединение закрыто сервером или сетью: Baileys сам вызывает end(error). */
  fail(error: Error | undefined): void;
  close(code: number): void;
}

interface AddressBook {
  readonly pnForLid: Readonly<Record<string, string>>;
  readonly lidForPn: Readonly<Record<string, string>>;
}

function disconnectError(code: number): Error {
  return Object.assign(new Error('Connection Failure'), { output: { statusCode: code } });
}

function createFakeSocket(
  config: UserFacingSocketConfig,
  book: AddressBook,
): FakeSocket & { readonly socket: WaSocket } {
  let handler: Handler | undefined;
  let buffered: Partial<BaileysEventMap>[] = [];
  let closed = false;
  const emit = (events: Partial<BaileysEventMap>): void => {
    void handler?.(events);
  };
  const flush = vi.fn((): boolean => {
    const pending = buffered;
    buffered = [];
    pending.forEach(emit);
    return pending.length > 0;
  });
  // Как end() в Baileys rc14: пачка close, затем ev.destroy() стирает буфер и снимает обработчики.
  const end = vi.fn((error: Error | undefined): Promise<void> => {
    if (closed) return Promise.resolve();
    closed = true;
    emit({
      'connection.update': { connection: 'close', lastDisconnect: { error, date: new Date() } },
    });
    buffered = [];
    handler = undefined;
    return Promise.resolve();
  });
  const sendMessage = vi.fn<WaSocket['sendMessage']>(() => Promise.resolve(undefined));
  const sendPresenceUpdate = vi.fn<WaSocket['sendPresenceUpdate']>(() => Promise.resolve());
  const readMessages = vi.fn<WaSocket['readMessages']>(() => Promise.resolve());
  const getBusinessProfile = vi.fn<WaSocket['getBusinessProfile']>(() =>
    Promise.resolve(undefined),
  );
  const profilePictureUrl = vi.fn<WaSocket['profilePictureUrl']>(() => Promise.resolve(undefined));
  const socket: WaSocket = {
    ev: {
      process: (next) => {
        handler = next;
        return () => {
          if (handler === next) handler = undefined;
        };
      },
      flush,
    },
    user: { id: SELF_ID, lid: SELF_LID },
    signalRepository: {
      lidMapping: {
        getPNForLID: (lid) => Promise.resolve(book.pnForLid[lid] ?? null),
        getLIDForPN: (pn) => Promise.resolve(book.lidForPn[pn] ?? null),
      },
    },
    end,
    sendMessage,
    sendPresenceUpdate,
    readMessages,
    getBusinessProfile,
    profilePictureUrl,
  };
  return {
    config,
    socket,
    end,
    flush,
    sendMessage,
    sendPresenceUpdate,
    readMessages,
    getBusinessProfile,
    profilePictureUrl,
    listening: () => handler !== undefined,
    emit,
    buffer: (events) => {
      buffered = [...buffered, events];
    },
    fail: (error) => {
      void end(error);
    },
    close: (code) => {
      void end(disconnectError(code));
    },
  };
}

function eventLabel(event: WaEvent): string {
  return event.type === 'ignore' ? `ignore:${event.reason}` : `event:${event.message.waId}`;
}

function textMessage(id: string, key: Partial<WAMessageKey> = {}, seconds = NOW / 1000): WAMessage {
  return {
    key: { id, remoteJid: CLIENT_PN, fromMe: false, ...key },
    messageTimestamp: seconds,
    message: { conversation: 'Здравствуйте' },
  };
}

function firstCall(fn: { mock: { invocationCallOrder: readonly number[] } }): number {
  return fn.mock.invocationCallOrder[0] ?? Infinity;
}

interface SetupOptions {
  readonly linked?: boolean;
  readonly linkedAtMs?: number | null;
  readonly managerPhone?: PhoneDigits | null;
  readonly testAllowlist?: ReadonlySet<PhoneDigits> | null;
  readonly workingMode?: WorkingMode | null;
  readonly pnForLid?: Readonly<Record<string, string>>;
  readonly lidForPn?: Readonly<Record<string, string>>;
}

interface Harness {
  readonly deps: WhatsAppDeps;
  readonly calls: string[];
  readonly logs: LogEntry[];
  readonly clock: FakeClock;
  readonly auth: AuthStore;
  readonly createSocket: Mock<(config: UserFacingSocketConfig) => WaSocket>;
  readonly fetchVersion: Mock<() => Promise<FetchedVersion>>;
  readonly tryBeginAttempt: Mock<(nowMs: number) => PairingDecision>;
  readonly setLinkedAtMs: Mock<(ms: number) => void>;
  readonly markHistoryIncomplete: Mock<(nowMs: number) => void>;
  readonly linkedAtMs: () => number | null;
  readonly show: Mock<(qr: string) => Promise<void>>;
  readonly clear: Mock<() => Promise<void>>;
  readonly classify: Mock<(message: WAMessage, context: ClassifyContext) => WaEvent>;
  readonly decide: Mock<(context: DisconnectContext) => ReconnectDecision>;
  readonly onEvent: Mock<(event: WaEvent) => Promise<void>>;
  readonly onOfflineQueueDone: Mock<() => Promise<void>>;
  readonly onHistoryChats: Mock<(chats: readonly HistoryChat[]) => Promise<void>>;
  readonly onStopped: Mock<(reason: WhatsAppStopReason) => void | Promise<void>>;
  readonly downloadMedia: Mock<MediaDownload>;
  readonly fetchPhoto: Mock<ProfileFetch>;
  socket(index: number): FakeSocket;
}

let root = '';
let sessionDir = '';
const started: WhatsAppConnection[] = [];

function setup(options: SetupOptions = {}): Harness {
  const calls: string[] = [];
  const logs: LogEntry[] = [];
  const clock = createFakeClock();
  const auth = createAuthStore(options.linked ?? true);
  const book = { pnForLid: options.pnForLid ?? {}, lidForPn: options.lidForPn ?? {} };
  const sockets: FakeSocket[] = [];
  let linkedAtMs = options.linkedAtMs === undefined ? NOW - HOUR_MS : options.linkedAtMs;
  const harness = {
    calls,
    logs,
    clock,
    auth,
    createSocket: vi.fn((config: UserFacingSocketConfig): WaSocket => {
      const fake = createFakeSocket(config, book);
      sockets.push(fake);
      return fake.socket;
    }),
    fetchVersion: vi.fn(() => Promise.resolve(VERSION)),
    tryBeginAttempt: vi.fn<(nowMs: number) => PairingDecision>(() => ({
      ok: true,
      attemptsLeft: 1,
    })),
    setLinkedAtMs: vi.fn((ms: number): void => {
      linkedAtMs = ms;
    }),
    markHistoryIncomplete: vi.fn<(nowMs: number) => void>(),
    linkedAtMs: () => linkedAtMs,
    show: vi.fn<(qr: string) => Promise<void>>(() => Promise.resolve()),
    clear: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    classify: vi.fn(classifyUpsert),
    decide: vi.fn(decideOnDisconnect),
    onEvent: vi.fn((event: WaEvent): Promise<void> => {
      calls.push(eventLabel(event));
      return Promise.resolve();
    }),
    onOfflineQueueDone: vi.fn((): Promise<void> => {
      calls.push('offline-done');
      return Promise.resolve();
    }),
    onHistoryChats: vi.fn<(chats: readonly HistoryChat[]) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    onStopped: vi.fn<(reason: WhatsAppStopReason) => void | Promise<void>>(),
    downloadMedia: vi.fn<MediaDownload>(() => Promise.resolve(byteChunks('ogg', '-opus'))),
    fetchPhoto: vi.fn<ProfileFetch>(() => Promise.reject(new Error('Фото не подготовлено'))),
    socket: (index: number): FakeSocket => {
      const fake = sockets[index];
      if (fake === undefined) throw new Error(`Сокет ${String(index)} не создан`);
      return fake;
    },
  };
  const deps: WhatsAppDeps = {
    sessionDir,
    logger: createFakeLogger(logs),
    clock: clock.clock,
    appState: {
      getLinkedAtMs: () => linkedAtMs,
      setLinkedAtMs: harness.setLinkedAtMs,
      markHistoryIncomplete: harness.markHistoryIncomplete,
    },
    pairingGuard: { tryBeginAttempt: harness.tryBeginAttempt },
    managerPhone: options.managerPhone ?? null,
    testAllowlist: options.testAllowlist ?? null,
    workingMode: options.workingMode ?? null,
    backlogMaxAgeMs: BACKLOG_MAX_AGE_MS,
    onEvent: harness.onEvent,
    onOfflineQueueDone: harness.onOfflineQueueDone,
    onHistoryChats: harness.onHistoryChats,
    onStopped: harness.onStopped,
    getSentText: () => Promise.resolve(null),
    createSocket: harness.createSocket,
    loadAuthState: auth.loadAuthState,
    fetchVersion: harness.fetchVersion,
    presenter: { show: harness.show, clear: harness.clear },
    classify: harness.classify,
    decide: harness.decide,
    downloadMedia: harness.downloadMedia,
    fetchPhoto: harness.fetchPhoto,
  };
  return { ...harness, deps };
}

/** Поток байтов голосового из строк, как поток расшифрованного медиа Baileys. */
async function* byteChunks(...parts: readonly string[]): AsyncGenerator<unknown> {
  for (const part of parts) {
    await Promise.resolve();
    yield Buffer.from(part);
  }
}

async function start(deps: WhatsAppDeps): Promise<WhatsAppConnection> {
  const connection = await startWhatsApp(deps);
  started.push(connection);
  return connection;
}

/** Ждёт условие, проверяя его часто: в тестах нет настоящих пауз. */
async function until(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { interval: 1, timeout: 2000 });
}

/** Подключение открыто: дальше идут сообщения. */
async function startOpen(h: Harness): Promise<WhatsAppConnection> {
  const connection = await start(h.deps);
  h.socket(0).emit({ 'connection.update': { connection: 'open' } });
  await until(() => expect(h.clock.pending(OFFLINE_QUEUE_FALLBACK_MS)).toBe(1));
  return connection;
}

function upsert(
  h: Harness,
  messages: WAMessage[],
  type: 'notify' | 'append' = 'notify',
  socket = 0,
): void {
  h.socket(socket).emit({ 'messages.upsert': { messages, type } });
}

function signalOfflineDone(h: Harness, socket = 0): void {
  h.socket(socket).emit({ 'connection.update': { receivedPendingNotifications: true } });
}

/** Дать очереди событий доработать, когда ждать нечего (проверка, что чего-то не случилось). */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tanbala-wa-'));
  sessionDir = join(root, 'whatsapp-session');
});

afterEach(async () => {
  await Promise.all(started.splice(0).map((connection) => connection.stop()));
  await rm(root, { recursive: true, force: true });
});

describe('whatsapp/connection: запуск', () => {
  it('сессии нет и попыток нет: сокета нет, PairingLimitError (SafeError) со временем следующей попытки', async () => {
    const h = setup({ linked: false });
    h.tryBeginAttempt.mockReturnValue({ ok: false, retryAfterMs: 2 * HOUR_MS });
    const retryAt = new Date(NOW + 2 * HOUR_MS).toISOString();

    const failure = startWhatsApp(h.deps);

    await expect(failure).rejects.toBeInstanceOf(PairingLimitError);
    await expect(failure).rejects.toBeInstanceOf(SafeError);
    await expect(failure).rejects.toMatchObject({
      name: 'PairingLimitError',
      retryAtMs: NOW + 2 * HOUR_MS,
    });
    await expect(failure).rejects.toThrow(retryAt);
    expect(h.createSocket).not.toHaveBeenCalled();
    expect(h.logs).toContainEqual(expect.objectContaining({ level: 'warn', context: { retryAt } }));
  });

  it('сбой счётчика попыток (испорченная копия): запуск отклонён, ошибка в логе, сокета нет', async () => {
    const h = setup({ linked: false });
    const broken = new Error('Копия счётчика привязок по QR испорчена: привязка остановлена');
    h.tryBeginAttempt.mockImplementation(() => {
      throw broken;
    });

    await expect(startWhatsApp(h.deps)).rejects.toBe(broken);

    expect(h.createSocket).not.toHaveBeenCalled();
    expect(h.logs).toContainEqual(
      expect.objectContaining({ level: 'error', context: { err: broken } }),
    );
  });

  it('сессии нет: версия до попытки, попытка до сокета; QR показан и не попал в лог', async () => {
    const h = setup({ linked: false });
    await start(h.deps);

    h.socket(0).emit({ 'connection.update': { qr: QR } });

    await until(() => expect(h.show).toHaveBeenCalledWith(QR));
    expect(firstCall(h.fetchVersion)).toBeLessThan(firstCall(h.tryBeginAttempt));
    expect(firstCall(h.tryBeginAttempt)).toBeLessThan(firstCall(h.createSocket));
    expect(JSON.stringify(h.logs)).not.toContain(QR);
  });

  it('версия не пришла за отведённое время: попытка засчитывается только после таймаута', async () => {
    const h = setup({ linked: false });
    h.fetchVersion.mockReturnValue(new Promise<FetchedVersion>(() => undefined));

    const starting = start(h.deps);
    await until(() => expect(h.clock.pending(VERSION_FETCH_TIMEOUT_MS)).toBe(1));
    expect(h.tryBeginAttempt).not.toHaveBeenCalled();
    h.clock.release(VERSION_FETCH_TIMEOUT_MS);
    await starting;

    expect(h.tryBeginAttempt).toHaveBeenCalledTimes(1);
    expect('version' in h.socket(0).config).toBe(false);
  });

  it('сессия есть, а момента привязки нет: LinkBoundaryMissingError (SafeError), сокета нет', async () => {
    const h = setup({ linked: true, linkedAtMs: null });

    const failure = startWhatsApp(h.deps);

    await expect(failure).rejects.toBeInstanceOf(LinkBoundaryMissingError);
    await expect(failure).rejects.toBeInstanceOf(SafeError);
    await expect(failure).rejects.toThrow('нет момента привязки');
    expect(h.createSocket).not.toHaveBeenCalled();
    expect(h.tryBeginAttempt).not.toHaveBeenCalled();
  });

  it('привязанная сессия не тратит попытку привязки', async () => {
    const h = setup({ linked: true });

    await start(h.deps);

    expect(h.tryBeginAttempt).not.toHaveBeenCalled();
    expect(h.socket(0).config.auth).toBe(h.auth.current());
  });

  it('по умолчанию сессия читается из папки: новая папка значит привязку по QR', async () => {
    const h = setup({ linked: true });

    await start({ ...h.deps, loadAuthState: undefined });

    expect(h.tryBeginAttempt).toHaveBeenCalledTimes(1);
    expect(h.socket(0).config.auth.creds.me).toBeUndefined();
    expect(existsSync(sessionDir)).toBe(true);
  });

  it('без presenter в deps берётся показ QR по умолчанию', async () => {
    const connection = await start({ ...setup().deps, presenter: undefined });

    await expect(connection.stop()).resolves.toBeUndefined();
  });
});

describe('whatsapp/connection: привязка по QR', () => {
  it('QR вне сеанса привязки не показывается', async () => {
    const h = setup({ linked: true });
    await start(h.deps);

    h.socket(0).emit({ 'connection.update': { qr: QR } });

    await until(() => expect(h.logs).toContainEqual(expect.objectContaining({ level: 'warn' })));
    expect(h.show).not.toHaveBeenCalled();
    expect(JSON.stringify(h.logs)).not.toContain(QR);
  });

  it('isNewLogin: граница = сейчас минус запас на расхождение часов, с перезаписью; open убирает QR', async () => {
    const h = setup({ linked: false, linkedAtMs: NOW - 30 * 24 * HOUR_MS });
    await start(h.deps);
    h.socket(0).emit({ 'connection.update': { qr: QR } });
    await until(() => expect(h.show).toHaveBeenCalled());
    h.clock.setNow(NOW + 60_000);

    h.socket(0).emit({ 'connection.update': { isNewLogin: true, qr: undefined } });
    h.socket(0).emit({ 'connection.update': { connection: 'open' } });

    await until(() => expect(h.clear).toHaveBeenCalled());
    expect(h.setLinkedAtMs).toHaveBeenCalledWith(NOW + 60_000 - LINKED_AT_SKEW_MS);
    expect(h.linkedAtMs()).toBe(NOW + 60_000 - LINKED_AT_SKEW_MS);
  });

  it('момент привязки не записался в базу: стоп link_save_failed', async () => {
    const h = setup({ linked: false });
    h.setLinkedAtMs.mockImplementation(() => {
      throw new Error('база только для чтения');
    });
    await start(h.deps);

    h.socket(0).emit({ 'connection.update': { isNewLogin: true } });

    await until(() => expect(h.onStopped).toHaveBeenCalledWith('link_save_failed'));
    expect(h.socket(0).end).toHaveBeenCalled();
  });

  it('408 во время привязки: стоп pairing_timeout без второй попытки, QR убран', async () => {
    const h = setup({ linked: false });
    await start(h.deps);
    h.socket(0).emit({ 'connection.update': { qr: QR } });

    h.socket(0).close(408);

    await until(() => expect(h.onStopped).toHaveBeenCalledWith('pairing_timeout'));
    expect(h.decide).toHaveBeenCalledWith({ code: 408, attempt: 1, pairing: true });
    expect(h.tryBeginAttempt).toHaveBeenCalledTimes(1);
    expect(h.createSocket).toHaveBeenCalledTimes(1);
    expect(h.clear).toHaveBeenCalled();
  });

  it('обрыв связи во время привязки: стоп pairing_timeout, нового QR и новой попытки нет', async () => {
    const h = setup({ linked: false });
    await start(h.deps);

    h.socket(0).close(428);

    await until(() => expect(h.onStopped).toHaveBeenCalledWith('pairing_timeout'));
    expect(h.tryBeginAttempt).toHaveBeenCalledTimes(1);
    expect(h.createSocket).toHaveBeenCalledTimes(1);
  });

  it('515 сразу после скана: сессия сохраняется до перечитывания, переподключение без новой попытки', async () => {
    const h = setup({ linked: false });
    await start(h.deps);
    const first = h.socket(0);
    const save = deferred();
    h.auth.saveCreds.mockImplementationOnce(() => save.promise.then(() => h.auth.persist()));
    // pair-success: Baileys дописывает me в creds в памяти, затем шлёт creds.update и isNewLogin
    h.auth.current().creds.me = { id: SELF_ID };
    first.emit({ 'creds.update': { me: { id: SELF_ID } } });
    first.emit({ 'connection.update': { isNewLogin: true, qr: undefined } });

    first.close(515);
    await until(() =>
      expect(h.decide).toHaveBeenCalledWith({ code: 515, attempt: 1, pairing: false }),
    );
    await settle();
    expect(h.auth.loadAuthState).toHaveBeenCalledTimes(1);
    save.resolve();

    await until(() => expect(h.createSocket).toHaveBeenCalledTimes(2));
    expect(h.tryBeginAttempt).toHaveBeenCalledTimes(1);
    expect(h.socket(1).config.auth.creds.me?.id).toBe(SELF_ID);
    expect(h.onStopped).not.toHaveBeenCalled();
  });

  it('переподключение без привязанной сессии: новый QR не показывается, стоп pairing_timeout', async () => {
    const h = setup({ linked: false });
    await start(h.deps);

    h.socket(0).close(515);

    await until(() => expect(h.onStopped).toHaveBeenCalledWith('pairing_timeout'));
    expect(h.tryBeginAttempt).toHaveBeenCalledTimes(1);
    expect(h.createSocket).toHaveBeenCalledTimes(1);
  });

  it('сессия не сохранилась перед переподключением: стоп session_save_failed, а не pairing_timeout', async () => {
    const h = setup({ linked: false });
    await start(h.deps);
    h.auth.saveCreds.mockRejectedValueOnce(new Error('диск полон'));

    h.socket(0).emit({ 'creds.update': { me: { id: SELF_ID } } });
    h.socket(0).emit({ 'connection.update': { isNewLogin: true } });
    h.socket(0).close(515);

    await until(() => expect(h.onStopped).toHaveBeenCalledWith('session_save_failed'));
    expect(h.createSocket).toHaveBeenCalledTimes(1);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ level: 'error', message: 'Не удалось сохранить сессию WhatsApp' }),
    );
  });

  it('WhatsApp отклонил версию (405): стоп version_rejected без решения о переподключении', async () => {
    const h = setup({ linked: false });
    await start(h.deps);

    h.socket(0).close(405);

    await until(() => expect(h.onStopped).toHaveBeenCalledWith('version_rejected'));
    expect(h.decide).not.toHaveBeenCalled();
  });

  it('QR, пришедший перед stop, после stop не показывается', async () => {
    const h = setup({ linked: false });
    const connection = await start(h.deps);
    const firstShow = deferred();
    h.show.mockImplementationOnce(() => firstShow.promise);
    h.socket(0).emit({ 'connection.update': { qr: QR } });
    await until(() => expect(h.show).toHaveBeenCalledWith(QR));

    h.socket(0).emit({ 'connection.update': { qr: `${QR}-2` } });
    const stopping = connection.stop();
    firstShow.resolve();
    await stopping;

    expect(h.show).not.toHaveBeenCalledWith(`${QR}-2`);
  });

  it('сбой показа QR: ошибка в лог без самого QR, следующий QR показывается', async () => {
    const h = setup({ linked: false });
    await start(h.deps);
    h.show.mockRejectedValueOnce(new Error('терминал недоступен'));

    h.socket(0).emit({ 'connection.update': { qr: QR } });
    h.socket(0).emit({ 'connection.update': { qr: `${QR}-2` } });

    await until(() => expect(h.show).toHaveBeenCalledWith(`${QR}-2`));
    expect(h.logs).toContainEqual(
      expect.objectContaining({ level: 'error', message: 'Не удалось показать QR' }),
    );
    expect(JSON.stringify(h.logs)).not.toContain(QR);
  });
});

describe('whatsapp/connection: события сокета', () => {
  it('сессия сохраняется своей цепочкой: не ждёт медленный onEvent', async () => {
    const h = setup();
    await startOpen(h);
    const slow = deferred();
    h.onEvent.mockImplementationOnce(() => slow.promise);
    upsert(h, [textMessage('m1')]);
    await until(() => expect(h.onEvent).toHaveBeenCalled());

    h.socket(0).emit({ 'creds.update': {} });

    await until(() => expect(h.auth.saveCreds).toHaveBeenCalled());
    slow.resolve();
  });

  it('конец офлайн-очереди: onOfflineQueueDone после сообщений и паузы тишины', async () => {
    const h = setup();
    await startOpen(h);
    upsert(h, [textMessage('m1'), textMessage('m2')], 'append');

    signalOfflineDone(h);
    await until(() => expect(h.clock.pending(OFFLINE_QUIET_MS)).toBe(1));
    expect(h.calls).toEqual(['event:m1', 'event:m2']);
    h.clock.release(OFFLINE_QUIET_MS);

    await until(() => expect(h.calls).toEqual(['event:m1', 'event:m2', 'offline-done']));
    expect(h.onHistoryChats).not.toHaveBeenCalled();
  });

  it('пачки разбираются строго по очереди, даже если onEvent медленный', async () => {
    const h = setup();
    await startOpen(h);
    const slow = deferred();
    h.onEvent.mockImplementationOnce((event) =>
      slow.promise.then(() => {
        h.calls.push(eventLabel(event));
      }),
    );

    upsert(h, [textMessage('m1')]);
    upsert(h, [textMessage('m2')]);
    await until(() => expect(h.onEvent).toHaveBeenCalled());
    expect(h.calls).toEqual([]);
    slow.resolve();

    await until(() => expect(h.calls).toEqual(['event:m1', 'event:m2']));
  });

  it('история: в onHistoryChats только адреса личных чатов и время, сообщения истории не разбираются', async () => {
    const h = setup();
    await startOpen(h);
    const history = textMessage('h1');
    const chats: Chat[] = [
      { id: CLIENT_PN, conversationTimestamp: 1_760_000_000, messages: [{ message: history }] },
      {
        id: CLIENT_LID,
        conversationTimestamp: 1_760_000_100,
        lastMessageRecvTimestamp: 1_760_000_200,
      },
      { id: GROUP, conversationTimestamp: 1_760_000_300 },
      { id: OTHER_PN },
    ];

    h.socket(0).emit({
      'messaging-history.set': {
        chats,
        contacts: [{ id: CLIENT_PN, notify: 'Клиент' }],
        messages: [history],
        syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
        isLatest: true,
        progress: 100,
      },
    });

    await until(() =>
      expect(h.onHistoryChats).toHaveBeenCalledWith([
        { jid: CLIENT_PN, lastMessageAtMs: 1_760_000_000_000 },
        { jid: CLIENT_LID, lastMessageAtMs: 1_760_000_200_000 },
        { jid: OTHER_PN, lastMessageAtMs: null },
      ]),
    );
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.onEvent).not.toHaveBeenCalled();
  });

  it('сбой записи истории: отметка неполной синхронизации, сообщения той же пачки не теряются', async () => {
    const h = setup();
    await startOpen(h);
    h.onHistoryChats.mockRejectedValueOnce(new Error('база заблокирована'));

    h.socket(0).emit({
      'messaging-history.set': { chats: [{ id: CLIENT_PN }], contacts: [], messages: [] },
      'messages.upsert': { messages: [textMessage('m1')], type: 'append' },
    });

    await until(() => expect(h.calls).toEqual(['event:m1']));
    expect(h.markHistoryIncomplete).toHaveBeenCalledWith(NOW);
  });

  it('контекст разбора: граница, время, порог, список, свои адреса, менеджер, тип пачки и номер', async () => {
    const allowlist: ReadonlySet<PhoneDigits> = new Set([CLIENT_PHONE as PhoneDigits]);
    const h = setup({
      managerPhone: MANAGER_PHONE,
      testAllowlist: allowlist,
      lidForPn: { [MANAGER_PN]: '300000000000003:5@lid' },
    });
    await startOpen(h);
    h.clock.setNow(NOW + 5000);
    const message = textMessage('m1', { remoteJid: CLIENT_LID, remoteJidAlt: CLIENT_PN });

    upsert(h, [message], 'append');

    await until(() => expect(h.calls).toEqual(['event:m1']));
    expect(h.classify).toHaveBeenCalledWith(message, {
      managerJids: new Set([MANAGER_PN, '300000000000003@lid']),
      selfJids: new Set(['77000000001@s.whatsapp.net', '100000000000001@lid']),
      linkedAtMs: NOW - HOUR_MS,
      nowMs: NOW + 5000,
      backlogMaxAgeMs: BACKLOG_MAX_AGE_MS,
      testAllowlist: allowlist,
      workingMode: null,
      chatPhone: CLIENT_PHONE,
      upsertType: 'append',
    });
  });

  it('рабочий режим: граница перехода из deps в контексте разбора, закрытого списка нет', async () => {
    const workingMode: WorkingMode = {
      sinceMs: NOW - 1000,
      allowlist: new Set([CLIENT_PHONE as PhoneDigits]),
    };
    const h = setup({ workingMode });
    await startOpen(h);

    upsert(h, [textMessage('m1')], 'notify');

    await until(() => expect(h.calls).toEqual(['event:m1']));
    expect(h.classify.mock.calls[0]?.[1]).toMatchObject({ testAllowlist: null, workingMode });
  });

  it('три сбоя подряд: стоп handler_failed, остаток пачки не разбирается', async () => {
    const h = setup();
    await startOpen(h);
    h.onEvent.mockRejectedValue(new Error('база недоступна'));

    upsert(
      h,
      ['m1', 'm2', 'm3', 'm4'].map((id) => textMessage(id)),
    );

    await until(() => expect(h.onStopped).toHaveBeenCalledWith('handler_failed'));
    expect(h.onEvent).toHaveBeenCalledTimes(3);
    expect(h.socket(0).end).toHaveBeenCalled();
  });

  it('без момента привязки (сеанс привязки) сообщения не разбираются', async () => {
    const h = setup({ linked: false, linkedAtMs: null });
    await start(h.deps);

    upsert(h, [textMessage('m1')]);

    await until(() =>
      expect(h.logs).toContainEqual(
        expect.objectContaining({ level: 'warn', context: { count: 1 } }),
      ),
    );
    expect(h.classify).not.toHaveBeenCalled();
  });

  it('страховочный таймер: признака конца офлайн-очереди нет => onOfflineQueueDone по таймеру', async () => {
    const h = setup();
    await startOpen(h);

    h.clock.release(OFFLINE_QUEUE_FALLBACK_MS);

    await until(() => expect(h.calls).toEqual(['offline-done']));
    expect(h.logs).toContainEqual(expect.objectContaining({ level: 'warn' }));
  });

  it('во время остановки onOfflineQueueDone не вызывается', async () => {
    const h = setup();
    const connection = await startOpen(h);
    signalOfflineDone(h);
    await until(() => expect(h.clock.pending(OFFLINE_QUIET_MS)).toBe(1));

    await connection.stop();

    expect(h.clock.pending(OFFLINE_QUIET_MS)).toBe(0);
    expect(h.onOfflineQueueDone).not.toHaveBeenCalled();
  });

  it('буфер Baileys выдаётся перед end при stop: сообщения за простой не теряются', async () => {
    const h = setup();
    const connection = await startOpen(h);
    h.socket(0).buffer({ 'messages.upsert': { messages: [textMessage('m1')], type: 'append' } });

    await connection.stop();

    expect(h.calls).toEqual(['event:m1']);
    expect(firstCall(h.socket(0).flush)).toBeLessThan(firstCall(h.socket(0).end));
  });

  it('буфер Baileys выдаётся и при обрыве: сообщения разбираются до решения о переподключении', async () => {
    const h = setup();
    await startOpen(h);
    h.socket(0).buffer({ 'messages.upsert': { messages: [textMessage('m1')], type: 'append' } });

    h.socket(0).close(428);

    await until(() => expect(h.decide).toHaveBeenCalled());
    expect(h.calls).toEqual(['event:m1']);
    expect(firstCall(h.onEvent)).toBeLessThan(firstCall(h.decide));
  });
});

describe('whatsapp/connection: разрывы и остановка', () => {
  it('счётчик разрывов не сбрасывается от одного open, а сбрасывается после 5 минут связи', async () => {
    const h = setup();
    await startOpen(h);

    h.socket(0).close(428);
    await until(() => expect(h.clock.pending(FIRST_DELAY_MS)).toBe(1));
    h.clock.release(FIRST_DELAY_MS);
    await until(() => expect(h.createSocket).toHaveBeenCalledTimes(2));
    h.socket(1).emit({ 'connection.update': { connection: 'open' } });
    await until(() => expect(h.clock.pending(STABLE_CONNECTION_MS)).toBe(1));
    h.socket(1).close(428);
    await until(() => expect(h.clock.pending(2 * FIRST_DELAY_MS)).toBe(1));
    h.clock.release(2 * FIRST_DELAY_MS);
    await until(() => expect(h.createSocket).toHaveBeenCalledTimes(3));
    h.socket(2).emit({ 'connection.update': { connection: 'open' } });
    await until(() => expect(h.clock.pending(STABLE_CONNECTION_MS)).toBe(1));
    h.clock.release(STABLE_CONNECTION_MS);
    await settle();
    h.socket(2).close(428);

    await until(() => expect(h.decide).toHaveBeenCalledTimes(3));
    expect(h.decide.mock.calls.map(([context]) => context.attempt)).toEqual([1, 2, 1]);
  });

  it('больше 12 переподключений за час: стоп gave_up, цикл open и close грозит баном', async () => {
    const h = setup();
    await startOpen(h);
    h.decide.mockReturnValue({ action: 'reconnect', delayMs: 0 });

    for (let index = 0; index < MAX_RECONNECTS_PER_HOUR; index += 1) {
      h.socket(index).close(428);
      await until(() => expect(h.createSocket).toHaveBeenCalledTimes(index + 2));
    }
    h.socket(MAX_RECONNECTS_PER_HOUR).close(428);

    await until(() => expect(h.onStopped).toHaveBeenCalledWith('gave_up'));
    expect(h.createSocket).toHaveBeenCalledTimes(MAX_RECONNECTS_PER_HOUR + 1);
  });

  it('stop во время паузы: пауза прерывается, новый сокет не создаётся', async () => {
    const h = setup();
    const connection = await startOpen(h);
    h.socket(0).close(428);
    await until(() => expect(h.clock.pending(FIRST_DELAY_MS)).toBe(1));

    await connection.stop();

    expect(h.clock.pending(FIRST_DELAY_MS)).toBe(0);
    expect(h.createSocket).toHaveBeenCalledTimes(1);
    expect(h.onStopped).not.toHaveBeenCalled();
  });

  it.each([
    ['сессия загрузилась', 'resolve'],
    ['загрузка сессии упала', 'reject'],
  ] as const)(
    'stop во время загрузки сессии при переподключении (%s): сокета и onStopped нет',
    async (_case, outcome) => {
      const h = setup();
      const connection = await startOpen(h);
      const gate = deferred();
      const load = h.auth.loadAuthState.getMockImplementation();
      h.auth.loadAuthState.mockImplementationOnce((folder) =>
        gate.promise.then(() =>
          outcome === 'resolve' && load !== undefined
            ? load(folder)
            : Promise.reject(new Error('диск')),
        ),
      );
      h.socket(0).close(428);
      await until(() => expect(h.clock.pending(FIRST_DELAY_MS)).toBe(1));
      h.clock.release(FIRST_DELAY_MS);
      await until(() => expect(h.auth.loadAuthState).toHaveBeenCalledTimes(2));

      const stopping = connection.stop();
      gate.resolve();
      await stopping;

      expect(h.createSocket).toHaveBeenCalledTimes(1);
      expect(h.onStopped).not.toHaveBeenCalled();
    },
  );

  it('стоп-решение (logged_out): onStopped, сокет закрыт, QR убран, обработчики сняты', async () => {
    const h = setup();
    const connection = await startOpen(h);

    h.socket(0).close(401);

    await until(() => expect(h.onStopped).toHaveBeenCalledWith('logged_out'));
    expect(h.createSocket).toHaveBeenCalledTimes(1);
    expect(h.clear).toHaveBeenCalled();
    expect(h.socket(0).listening()).toBe(false);
    await expect(connection.stop()).resolves.toBeUndefined();
    expect(h.onStopped).toHaveBeenCalledTimes(1);
  });

  it('сбой переподключения (сессия не загрузилась) => reconnect_failed', async () => {
    const h = setup();
    await startOpen(h);
    h.auth.loadAuthState.mockRejectedValueOnce(new Error('папка недоступна'));

    h.socket(0).close(428);
    await until(() => expect(h.clock.pending(FIRST_DELAY_MS)).toBe(1));
    h.clock.release(FIRST_DELAY_MS);

    await until(() => expect(h.onStopped).toHaveBeenCalledWith('reconnect_failed'));
    expect(h.createSocket).toHaveBeenCalledTimes(1);
  });

  it('сбой решения о переподключении => reconnect_failed', async () => {
    const h = setup();
    await startOpen(h);
    h.decide.mockImplementationOnce(() => {
      throw new Error('неизвестный код');
    });

    h.socket(0).close(499);

    await until(() => expect(h.onStopped).toHaveBeenCalledWith('reconnect_failed'));
  });

  it('stop: decide не вызывается, сохранение сессии дожидается, повторный stop безопасен', async () => {
    const h = setup();
    const connection = await startOpen(h);
    const save = deferred();
    h.auth.saveCreds.mockImplementationOnce(() => save.promise);
    h.socket(0).emit({ 'creds.update': {} });
    let stopped = false;

    const stopping = connection.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    save.resolve();
    await stopping;
    await connection.stop();

    expect(h.decide).not.toHaveBeenCalled();
    expect(h.onStopped).not.toHaveBeenCalled();
    expect(h.socket(0).listening()).toBe(false);
  });

  it('stop дожидается разбора уже пришедших сообщений', async () => {
    const h = setup();
    const connection = await startOpen(h);
    const slow = deferred();
    h.onEvent.mockImplementationOnce(() => slow.promise);
    upsert(h, [textMessage('m1')]);
    await until(() => expect(h.onEvent).toHaveBeenCalled());
    let stopped = false;

    const stopping = connection.stop().then(() => {
      stopped = true;
    });
    await until(() => expect(h.socket(0).end).toHaveBeenCalled());
    expect(stopped).toBe(false);
    slow.resolve();
    await stopping;

    expect(stopped).toBe(true);
  });

  it('сбой выдачи буфера и удаления картинки при stop пишутся в лог, остановка завершается', async () => {
    const h = setup();
    const connection = await startOpen(h);
    h.socket(0).flush.mockImplementation(() => {
      throw new Error('буфер сломан');
    });
    h.clear.mockRejectedValue(new Error('файл занят'));

    await connection.stop();

    expect(h.socket(0).end).toHaveBeenCalled();
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'Накопленные события WhatsApp не выданы',
      }),
    );
    expect(h.logs).toContainEqual(
      expect.objectContaining({ level: 'error', message: 'Не удалось удалить картинку QR' }),
    );
  });

  it('stop во время остановки по решению: onStopped один раз, ресурсы освобождены', async () => {
    const h = setup();
    const connection = await startOpen(h);
    const clearing = deferred();
    h.clear.mockImplementationOnce(() => clearing.promise);
    h.socket(0).close(401);
    await until(() => expect(h.clear).toHaveBeenCalled());

    const stopping = connection.stop();
    clearing.resolve();
    await stopping;

    await until(() => expect(h.onStopped).toHaveBeenCalledWith('logged_out'));
    expect(h.onStopped).toHaveBeenCalledTimes(1);
  });

  it('после переподключения stop закрывает новый сокет; у старого обработчиков нет', async () => {
    const h = setup();
    const connection = await startOpen(h);
    h.socket(0).close(428);
    await until(() => expect(h.clock.pending(FIRST_DELAY_MS)).toBe(1));
    h.clock.release(FIRST_DELAY_MS);
    await until(() => expect(h.createSocket).toHaveBeenCalledTimes(2));

    await connection.stop();

    expect(h.socket(0).listening()).toBe(false);
    expect(h.socket(0).end).toHaveBeenCalledTimes(1);
    expect(h.socket(1).end).toHaveBeenCalled();
    expect(h.socket(1).listening()).toBe(false);
  });

  it.each([
    ['отказ промиса', (): Promise<void> => Promise.reject(new Error('обработчик упал'))],
    [
      'исключение',
      (): void => {
        throw new Error('обработчик упал');
      },
    ],
  ])('сбой в onStopped (%s) пишется в лог и не роняет процесс', async (_case, failing) => {
    const h = setup();
    await startOpen(h);
    h.onStopped.mockImplementation(failing);

    h.socket(0).close(401);

    await until(() =>
      expect(h.logs).toContainEqual(
        expect.objectContaining({
          level: 'error',
          message: 'Ошибка в обработчике остановки WhatsApp',
        }),
      ),
    );
  });

  it('сломанный таймер паузы: warn и переподключение без паузы', async () => {
    const h = setup();
    await startOpen(h);
    h.clock.failNext(FIRST_DELAY_MS);

    h.socket(0).close(428);

    await until(() => expect(h.createSocket).toHaveBeenCalledTimes(2));
    expect(h.logs).toContainEqual(
      expect.objectContaining({ level: 'warn', message: 'Пауза перед переподключением прервана' }),
    );
  });

  it('по умолчанию сообщения разбирает whatsapp/inbound, разрывы решает whatsapp/reconnect', async () => {
    const h = setup();
    await start({ ...h.deps, classify: undefined, decide: undefined });
    h.socket(0).emit({ 'connection.update': { connection: 'open' } });

    upsert(h, [textMessage('m1')]);
    await until(() => expect(h.calls).toEqual(['event:m1']));
    h.socket(0).close(440);

    await until(() => expect(h.onStopped).toHaveBeenCalledWith('replaced'));
    expect(h.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'client' }));
  });
});

describe('whatsapp/connection: шлюз этапа 2', () => {
  it('newMessageId выдаёт ID в формате WhatsApp Web', async () => {
    const connection = await start(setup().deps);

    const first = connection.newMessageId();

    expect(first).toMatch(/^3EB0[0-9A-F]{18}$/);
    expect(connection.newMessageId()).not.toBe(first);
  });

  it('resolvePhone: номер из адреса с номером или через getPNForLID', async () => {
    const connection = await start(
      setup({ pnForLid: { [CLIENT_LID]: '77000000002:7@s.whatsapp.net' } }).deps,
    );

    await expect(connection.resolvePhone(CLIENT_PN as Jid)).resolves.toBe(CLIENT_PHONE);
    await expect(connection.resolvePhone(CLIENT_LID as Jid)).resolves.toBe(CLIENT_PHONE);
    await expect(connection.resolvePhone('999@lid' as Jid)).resolves.toBeNull();
  });
});

describe('whatsapp/connection: шлюз этапа 3', () => {
  const ALLOWLIST: ReadonlySet<PhoneDigits> = new Set([CLIENT_PHONE as PhoneDigits]);
  const VOICE_MIME = 'audio/ogg; codecs=opus';

  function voiceMessage(id: string, key: Partial<WAMessageKey> = {}): WAMessage {
    return {
      key: { id, remoteJid: CLIENT_PN, fromMe: false, ...key },
      messageTimestamp: NOW / 1000,
      message: { audioMessage: { ptt: true, mimetype: VOICE_MIME, seconds: 3 } },
    };
  }

  it('sendText: текст без предпросмотра ссылок с заранее выданным ID; @lid по сопоставлению с номером', async () => {
    const h = setup({ testAllowlist: ALLOWLIST, pnForLid: { [CLIENT_LID]: CLIENT_PN } });
    const connection = await startOpen(h);

    await connection.sendText(CLIENT_PN as Jid, 'Добрый день', 'OUT-1' as WaMessageId);
    await connection.sendText(CLIENT_LID as Jid, 'Ещё', 'OUT-2' as WaMessageId);

    expect(h.socket(0).sendMessage.mock.calls).toEqual([
      [CLIENT_PN, { text: 'Добрый день', linkPreview: null }, { messageId: 'OUT-1' }],
      [CLIENT_LID, { text: 'Ещё', linkPreview: null }, { messageId: 'OUT-2' }],
    ]);
  });

  it('закрытый режим: чат не из списка, неизвестный номер и не личный чат отклоняются; менеджеру можно', async () => {
    const h = setup({ testAllowlist: ALLOWLIST, managerPhone: MANAGER_PHONE });
    const connection = await startOpen(h);
    const id = 'OUT-1' as WaMessageId;

    await expect(connection.sendText(OTHER_PN as Jid, 'т', id)).rejects.toThrow('TEST_ALLOWLIST');
    await expect(connection.sendText(CLIENT_LID as Jid, 'т', id)).rejects.toThrow('TEST_ALLOWLIST');
    await expect(connection.sendText(GROUP as Jid, 'т', id)).rejects.toThrow('не личного чата');
    await connection.sendText(MANAGER_PN as Jid, 'уведомление', id);

    expect(h.socket(0).sendMessage.mock.calls.map(([jid]) => jid)).toEqual([MANAGER_PN]);
  });

  it('setTyping и markRead: только чаты из списка (менеджер тоже нет); пустой список ID ничего не шлёт', async () => {
    const h = setup({ testAllowlist: ALLOWLIST, managerPhone: MANAGER_PHONE });
    const connection = await startOpen(h);
    const jid = CLIENT_PN as Jid;

    await connection.setTyping(jid, true);
    await connection.setTyping(jid, false);
    await connection.markRead(jid, ['A1' as WaMessageId, 'A2' as WaMessageId]);
    await connection.markRead(jid, []);

    const sock = h.socket(0);
    expect(sock.sendPresenceUpdate.mock.calls).toEqual([
      ['composing', CLIENT_PN],
      ['paused', CLIENT_PN],
    ]);
    expect(sock.readMessages.mock.calls).toEqual([
      [
        [
          { remoteJid: CLIENT_PN, id: 'A1', fromMe: false },
          { remoteJid: CLIENT_PN, id: 'A2', fromMe: false },
        ],
      ],
    ]);
    await expect(connection.setTyping(MANAGER_PN as Jid, true)).rejects.toThrow('TEST_ALLOWLIST');
    await expect(connection.markRead(OTHER_PN as Jid, ['B1' as WaMessageId])).rejects.toThrow(
      'TEST_ALLOWLIST',
    );
    expect(sock.sendPresenceUpdate).toHaveBeenCalledTimes(2);
    expect(sock.readMessages).toHaveBeenCalledTimes(1);
  });

  it('без закрытого режима проверяется только личный чат; после остановки шлюз отказывает', async () => {
    const h = setup();
    const connection = await startOpen(h);

    await connection.sendText(OTHER_PN as Jid, 'т', 'OUT-1' as WaMessageId);
    await expect(connection.setTyping(GROUP as Jid, true)).rejects.toThrow('не личного чата');
    await connection.stop();

    await expect(connection.sendText(OTHER_PN as Jid, 'т', 'OUT-2' as WaMessageId)).rejects.toThrow(
      'не подключён',
    );
    expect(h.socket(0).sendMessage).toHaveBeenCalledTimes(1);
  });

  it('downloadAudio: голосовое клиента после разбора качается потоком', async () => {
    const h = setup({ testAllowlist: ALLOWLIST });
    const connection = await startOpen(h);
    const source = voiceMessage('V1');
    upsert(h, [source]);
    await until(() => expect(h.calls).toEqual(['event:V1']));

    const clip = await connection.downloadAudio('V1' as MediaRef, 1024);

    expect(Buffer.from(clip.data).toString()).toBe('ogg-opus');
    expect(clip.mimeType).toBe(VOICE_MIME);
    expect(h.downloadMedia).toHaveBeenCalledWith(source);
  });

  it('downloadAudio: своё голосовое и неизвестная ссылка не скачиваются', async () => {
    const h = setup({ testAllowlist: ALLOWLIST });
    const connection = await startOpen(h);
    upsert(h, [voiceMessage('V2', { fromMe: true })]);
    await until(() => expect(h.calls).toEqual(['event:V2']));

    await expect(connection.downloadAudio('V2' as MediaRef, 1024)).rejects.toThrow('не найдено');
    await expect(connection.downloadAudio('V9' as MediaRef, 1024)).rejects.toThrow('не найдено');
    expect(h.downloadMedia).not.toHaveBeenCalled();
  });
});

describe('whatsapp/connection: профиль собеседника (определение компании)', () => {
  const ALLOWLIST: ReadonlySet<PhoneDigits> = new Set([CLIENT_PHONE as PhoneDigits]);
  const PHOTO_URL = 'https://pps.whatsapp.net/v/t61/photo.jpg?ccb=1';

  function businessProfile(): WABusinessProfile {
    return {
      description: 'Склад в Алматы',
      email: 'info@sklad.kz',
      business_hours: {},
      website: ['https://sklad.kz'],
    };
  }

  function photoResponse(): Response {
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
  }

  it('businessProfile: бизнес-аккаунт из TEST_ALLOWLIST: сайты и почта, запрос в сокет с адресом чата', async () => {
    const h = setup({ testAllowlist: ALLOWLIST });
    const connection = await startOpen(h);
    h.socket(0).getBusinessProfile.mockResolvedValueOnce(businessProfile());

    const result = await connection.businessProfile(CLIENT_PN as Jid);

    expect(result).toEqual({
      kind: 'business',
      websites: ['https://sklad.kz'],
      email: 'info@sklad.kz',
    });
    expect(h.socket(0).getBusinessProfile).toHaveBeenCalledExactlyOnceWith(CLIENT_PN);
  });

  it('businessProfile: обычный аккаунт => personal; сбой запроса => failed', async () => {
    const h = setup();
    const connection = await startOpen(h);
    h.socket(0).getBusinessProfile.mockRejectedValueOnce(new Error('Connection Closed'));

    expect(await connection.businessProfile(CLIENT_PN as Jid)).toEqual({ kind: 'failed' });
    expect(await connection.businessProfile(CLIENT_PN as Jid)).toEqual({ kind: 'personal' });
  });

  it('profilePhoto: адрес с сервера WhatsApp, скачивание только по нему, байты и тип', async () => {
    const h = setup({ testAllowlist: ALLOWLIST });
    const connection = await startOpen(h);
    h.socket(0).profilePictureUrl.mockResolvedValueOnce(PHOTO_URL);
    h.fetchPhoto.mockResolvedValueOnce(photoResponse());

    const photo = await connection.profilePhoto(CLIENT_PN as Jid, 1024);

    expect(photo).toEqual({ data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' });
    expect(h.socket(0).profilePictureUrl).toHaveBeenCalledExactlyOnceWith(
      CLIENT_PN,
      'image',
      10_000,
    );
    expect(h.fetchPhoto.mock.calls[0]?.[0]).toBe(PHOTO_URL);
  });

  it('закрытый режим: чат не из списка, менеджер и не личный чат: failed и null, сокет не тронут', async () => {
    const h = setup({ testAllowlist: ALLOWLIST, managerPhone: MANAGER_PHONE });
    const connection = await startOpen(h);

    for (const jid of [OTHER_PN, MANAGER_PN, CLIENT_LID, GROUP]) {
      expect(await connection.businessProfile(jid as Jid)).toEqual({ kind: 'failed' });
      expect(await connection.profilePhoto(jid as Jid, 1024)).toBeNull();
    }

    expect(h.socket(0).getBusinessProfile).not.toHaveBeenCalled();
    expect(h.socket(0).profilePictureUrl).not.toHaveBeenCalled();
    expect(h.fetchPhoto).not.toHaveBeenCalled();
  });

  it('закрытый режим: @lid, номер которого из списка (по сопоставлению), проходит', async () => {
    const h = setup({ testAllowlist: ALLOWLIST, pnForLid: { [CLIENT_LID]: CLIENT_PN } });
    const connection = await startOpen(h);

    expect(await connection.businessProfile(CLIENT_LID as Jid)).toEqual({ kind: 'personal' });
    expect(h.socket(0).getBusinessProfile).toHaveBeenCalledExactlyOnceWith(CLIENT_LID);
  });

  it('без закрытого режима проверяется только личный чат', async () => {
    const h = setup();
    const connection = await startOpen(h);

    expect(await connection.businessProfile(OTHER_PN as Jid)).toEqual({ kind: 'personal' });
    expect(await connection.businessProfile(GROUP as Jid)).toEqual({ kind: 'failed' });
    expect(h.socket(0).getBusinessProfile).toHaveBeenCalledExactlyOnceWith(OTHER_PN);
  });

  it('после остановки подключения запросов к WhatsApp нет', async () => {
    const h = setup();
    const connection = await startOpen(h);
    await connection.stop();

    expect(await connection.businessProfile(CLIENT_PN as Jid)).toEqual({ kind: 'failed' });
    expect(await connection.profilePhoto(CLIENT_PN as Jid, 1024)).toBeNull();
    expect(h.socket(0).getBusinessProfile).not.toHaveBeenCalled();
    expect(h.socket(0).profilePictureUrl).not.toHaveBeenCalled();
  });

  it('шлюз профиля ничего не отправляет: ни сообщений, ни «печатает», ни отметок прочтения', async () => {
    const h = setup();
    const connection = await startOpen(h);
    h.socket(0).profilePictureUrl.mockResolvedValueOnce(PHOTO_URL);
    h.fetchPhoto.mockResolvedValueOnce(photoResponse());

    await connection.businessProfile(CLIENT_PN as Jid);
    await connection.profilePhoto(CLIENT_PN as Jid, 1024);

    expect(h.socket(0).sendMessage).not.toHaveBeenCalled();
    expect(h.socket(0).sendPresenceUpdate).not.toHaveBeenCalled();
    expect(h.socket(0).readMessages).not.toHaveBeenCalled();
  });

  it('без своей подмены скачивание идёт через глобальный fetch (в тестах он заблокирован): null', async () => {
    const h = setup();
    const connection = await start({ ...h.deps, fetchPhoto: undefined });
    h.socket(0).emit({ 'connection.update': { connection: 'open' } });
    h.socket(0).profilePictureUrl.mockResolvedValueOnce(PHOTO_URL);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect(await connection.profilePhoto(CLIENT_PN as Jid, 1024)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
