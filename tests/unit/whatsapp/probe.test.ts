import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initAuthCreds, proto } from 'baileys';
import type {
  AuthenticationCreds,
  BaileysEventMap,
  SignalKeyStore,
  UserFacingSocketConfig,
  WAMessage,
} from 'baileys';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Clock, KnownChatSource, ProcessLock } from '../../../src/domain/ports.js';
import type { Jid, PhoneDigits } from '../../../src/domain/types.js';
import type { FetchedVersion, LoadedAuthState } from '../../../src/whatsapp/connection-types.js';
import {
  parseProbeNumber,
  PROBE_CLOSE_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  PROBE_USAGE,
  runBusinessProbe,
  type ProbeDeps,
  type ProbeSocket,
} from '../../../src/whatsapp/probe.js';
import type { ProbeChatStore } from '../../../src/whatsapp/probe-chats.js';
import { VERSION_FETCH_TIMEOUT_MS } from '../../../src/whatsapp/socket-config.js';
import { createFakeLogger, type LogEntry } from '../../helpers/fake-logger.js';

// Проба бизнес-профиля: поддельный сокет, замок, сессия и часы. К WhatsApp никто не подключается,
// QR не запускается, выводится только JSON без номера и JID.

const PHONE = '77012345678';
const PN_JID = `${PHONE}@s.whatsapp.net`;
const LID_JID = '200000000000009@lid';
const SELF_ID = '77000000001:12@s.whatsapp.net';
const VERSION: FetchedVersion = { version: [2, 3000, 1_000_000_001], isLatest: true };

const MESSAGE_BOT_RUNNING = 'Бот запущен: остановите его перед пробой';
const MESSAGE_NO_SESSION = 'Сессии нет, QR не запускаю';
const MESSAGE_QR = 'WhatsApp запросил QR: проба прекращена';
const MESSAGE_CHATS_INCOMPLETE =
  'Не все чаты из пробы записаны в known_chats: перед этапом 8 сверьте чаты с перепиской в телефоне';
const MESSAGE_CREDS = /Сессия WhatsApp не сохранилась/;

/** Строка о сообщениях, доставшихся пробе. */
function receivedLine(count: number, saved = true): string {
  const head = `Проба получила сообщений: ${String(count)}. Бот их не увидит, в телефоне они есть`;
  return saved ? `${head}; чаты записаны для этапа 8\n` : `${head}\n`;
}

const CLIENT_PN = '77000000001@s.whatsapp.net' as Jid;
const CLIENT_LID = '100000000000001@lid' as Jid;
const MESSAGE_SECONDS = 1_790_000_000;

/** Сообщение клиента в личном чате (как из офлайн-очереди): форма WAMessage Baileys rc14. */
function clientMessage(remoteJid: string = CLIENT_PN, id = '3EB0A1B2C3D4E5F60718'): WAMessage {
  const synthetic: unknown = {
    key: { remoteJid, fromMe: false, id },
    message: { conversation: 'Здравствуйте, нужен учёт' },
    messageTimestamp: MESSAGE_SECONDS,
  };
  return synthetic as WAMessage;
}

function offlineQueue(messages: readonly WAMessage[]): Partial<BaileysEventMap> {
  return { 'messages.upsert': { messages: [...messages], type: 'append' } };
}

const NO_PROFILE = {
  business: false,
  website: 0,
  email: false,
  category: false,
  description: false,
  address: false,
};

interface ManualClock {
  readonly clock: Clock;
  /** Сколько незавершённых пауз такой длины. */
  pending(ms: number): number;
  /** Ждёт (без настоящего времени), пока появится незавершённая пауза такой длины. */
  sleeping(ms: number): Promise<void>;
  /** Срок вышел у самой ранней паузы такой длины. */
  expire(ms: number): void;
}

interface Pause {
  readonly ms: number;
  settled: boolean;
  readonly resolve: () => void;
}

/** Часы без настоящего времени: паузы заканчиваются только по expire или по сигналу отмены. */
function createManualClock(): ManualClock {
  const pauses: Pause[] = [];
  const waiters: { readonly ms: number; readonly resolve: () => void }[] = [];
  const firstPending = (ms: number): Pause | undefined =>
    pauses.find((pause) => pause.ms === ms && !pause.settled);
  const clock: Clock = {
    now: () => 0,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        const pause: Pause = { ms, settled: false, resolve };
        pauses.push(pause);
        signal?.addEventListener('abort', () => {
          pause.settled = true;
          reject(new Error('Пауза прервана'));
        });
        for (const waiter of waiters.filter((candidate) => candidate.ms === ms)) waiter.resolve();
      }),
  };
  return {
    clock,
    pending: (ms) => pauses.filter((pause) => pause.ms === ms && !pause.settled).length,
    sleeping: (ms) =>
      firstPending(ms) === undefined
        ? new Promise<void>((resolve) => {
            waiters.push({ ms, resolve });
          })
        : Promise.resolve(),
    expire: (ms) => {
      const pause = firstPending(ms);
      if (pause === undefined) throw new Error(`Нет паузы ${String(ms)} мс`);
      pause.settled = true;
      pause.resolve();
    },
  };
}

/** Даёт пройти всем уже готовым промисам (одна макрозадача, без таймеров). */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

type Handler = (events: Partial<BaileysEventMap>) => void | Promise<void>;

interface FakeProbeSocket {
  readonly socket: ProbeSocket;
  readonly end: Mock<(error: Error | undefined) => Promise<void>>;
  readonly flush: Mock<() => boolean>;
  /** Нет в типе ProbeSocket: проба обязана никогда не вызывать logout. */
  readonly logout: Mock<() => Promise<void>>;
  readonly getBusinessProfile: Mock<ProbeSocket['getBusinessProfile']>;
  readonly getLIDForPN: Mock<(pn: string) => Promise<string | null>>;
  readonly subscriptions: () => number;
  emit(events: Partial<BaileysEventMap>): void;
}

interface SocketOptions {
  readonly profiles?: Readonly<Record<string, unknown>>;
  readonly lid?: string | null;
  readonly lidFails?: boolean;
  readonly failures?: Readonly<Record<string, Error>>;
  /** События в буфере Baileys: выдаются обработчику при первом flush. */
  readonly buffered?: Partial<BaileysEventMap>;
  readonly flushFails?: boolean;
  /** Сопоставление @lid с номером не отвечает: запись чатов @lid ждёт. */
  readonly pnHangs?: boolean;
}

function createFakeProbeSocket(calls: string[], options: SocketOptions): FakeProbeSocket {
  let handler: Handler | undefined;
  let subscribed = 0;
  let closed = false;
  const end = vi.fn((error: Error | undefined): Promise<void> => {
    calls.push('end');
    if (closed) return Promise.resolve();
    closed = true;
    void handler?.({
      'connection.update': { connection: 'close', lastDisconnect: { error, date: new Date() } },
    });
    handler = undefined;
    return Promise.resolve();
  });
  const logout = vi.fn(() => Promise.resolve());
  let buffered = options.buffered;
  const flush = vi.fn((): boolean => {
    calls.push('flush');
    if (options.flushFails === true) throw new Error('buffer destroyed');
    const events = buffered;
    buffered = undefined;
    if (events === undefined) return false;
    void handler?.(events);
    return true;
  });
  const getBusinessProfile = vi.fn((jid: string) => {
    const label = jid === PN_JID ? 'profile:number' : jid === LID_JID ? 'profile:lid' : 'profile:?';
    calls.push(label);
    const failure = options.failures?.[jid];
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve(
      options.profiles?.[jid] as Awaited<ReturnType<ProbeSocket['getBusinessProfile']>>,
    );
  });
  const getLIDForPN = vi.fn((pn: string) => {
    calls.push('lid-mapping');
    if (options.lidFails === true) return Promise.reject(new RangeError(`нет ключей для ${pn}`));
    return Promise.resolve(options.lid === undefined ? LID_JID : options.lid);
  });
  const base = {
    ev: {
      process: (next: Handler) => {
        subscribed += 1;
        handler = next;
        return () => {
          if (handler === next) handler = undefined;
        };
      },
      flush,
    },
    signalRepository: {
      lidMapping: {
        getPNForLID: () =>
          options.pnHangs === true
            ? new Promise<string | null>(() => undefined)
            : Promise.resolve(null),
        getLIDForPN,
      },
    },
    end,
    getBusinessProfile,
    logout,
  };
  const socket: ProbeSocket = base;
  return {
    socket,
    end,
    flush,
    logout,
    getBusinessProfile,
    getLIDForPN,
    subscriptions: () => subscribed,
    emit: (events) => {
      void handler?.(events);
    },
  };
}

interface StoredTouch {
  readonly jid: Jid;
  readonly atMs: number;
  readonly source: KnownChatSource;
}

interface Harness {
  readonly deps: ProbeDeps;
  /** Что проба записала в known_chats. */
  readonly touches: StoredTouch[];
  readonly openChatStore: Mock<() => ProbeChatStore | null>;
  readonly storeRun: Mock<(work: () => unknown) => unknown>;
  readonly storeClose: Mock<() => void>;
  readonly keysSet: Mock<SignalKeyStore['set']>;
  readonly calls: string[];
  readonly stdout: string[];
  readonly stderr: string[];
  readonly logs: LogEntry[];
  readonly clock: ManualClock;
  readonly acquireLock: Mock<() => ProcessLock | null>;
  readonly loadAuthState: Mock<(folder: string) => Promise<LoadedAuthState>>;
  readonly saveCreds: Mock<() => Promise<void>>;
  readonly createSocket: Mock<(config: UserFacingSocketConfig) => ProbeSocket>;
  readonly fetchVersion: Mock<() => Promise<FetchedVersion>>;
  readonly state: LoadedAuthState['state'];
  socket(): FakeProbeSocket;
  sockets(): number;
  /** Запуск пробы; без аргументов с номером PHONE. */
  run(args?: readonly string[]): Promise<number>;
  /** Ждёт, пока проба создаст сокет и подпишется на события. */
  socketReady(): Promise<FakeProbeSocket>;
  /** Сокет открылся: проба работает до конца и возвращает код выхода. */
  runToOpen(args?: readonly string[]): Promise<number>;
}

interface SetupOptions extends SocketOptions {
  readonly linked?: boolean;
  /** База бота: нет файла (null) или сбой открытия. */
  readonly storeMissing?: boolean;
  readonly storeFails?: boolean;
  readonly locked?: boolean;
  readonly sessionExists?: boolean;
  /** Настоящий useMultiFileAuthState (по умолчанию в пробе) вместо подделки: только чтение временной папки. */
  readonly realAuth?: boolean;
  readonly saveDelay?: boolean;
  readonly saveFails?: boolean;
  readonly timeoutMs?: number;
}

let root = '';

function setup(options: SetupOptions = {}): Harness {
  const calls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logs: LogEntry[] = [];
  const manual = createManualClock();
  const sockets: FakeProbeSocket[] = [];
  let socketCreated: (fake: FakeProbeSocket) => void = () => undefined;
  const firstSocket = new Promise<FakeProbeSocket>((resolve) => {
    socketCreated = resolve;
  });
  const creds: AuthenticationCreds =
    options.linked === false ? initAuthCreds() : { ...initAuthCreds(), me: { id: SELF_ID } };
  const keysSet = vi.fn<SignalKeyStore['set']>((): void => {
    calls.push('keys-saved');
  });
  const state: LoadedAuthState['state'] = {
    creds,
    keys: { get: () => ({}), set: keysSet },
  };
  const touches: StoredTouch[] = [];
  const storeRun = vi.fn((work: () => unknown): unknown => work());
  const storeClose = vi.fn((): void => {
    calls.push('db-close');
  });
  const store: ProbeChatStore = {
    knownChats: {
      touch: (jid, atMs, source) => {
        touches.push({ jid, atMs, source });
      },
      count: () => touches.length,
    },
    unitOfWork: { run: <T>(work: () => T): T => storeRun(work) as T },
    close: storeClose,
  };
  const openChatStore = vi.fn((): ProbeChatStore | null => {
    calls.push('db');
    if (options.storeFails === true) throw new Error(`SQLITE_CANTOPEN ${root}`);
    return options.storeMissing === true ? null : store;
  });
  const saveCreds = vi.fn((): Promise<void> => {
    if (options.saveFails === true) return Promise.reject(new Error('EACCES'));
    if (options.saveDelay !== true) {
      calls.push('saved');
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        calls.push('saved');
        resolve();
      });
    });
  });
  const loadAuthState = vi.fn<(folder: string) => Promise<LoadedAuthState>>(() =>
    Promise.resolve({ state, saveCreds }),
  );
  const createSocket = vi.fn((_config: UserFacingSocketConfig): ProbeSocket => {
    calls.push('socket');
    const fake = createFakeProbeSocket(calls, options);
    sockets.push(fake);
    socketCreated(fake);
    return fake.socket;
  });
  const fetchVersion = vi.fn(() => Promise.resolve(VERSION));
  const release = vi.fn((): void => {
    calls.push('release');
  });
  const acquireLock = vi.fn((): ProcessLock | null => {
    calls.push('lock');
    return options.locked === true ? null : { release };
  });
  const deps: ProbeDeps = {
    sessionDir: options.sessionExists === false ? join(root, 'missing') : root,
    logger: createFakeLogger(logs),
    clock: manual.clock,
    acquireLock,
    openChatStore,
    out: {
      stdout: (text) => {
        stdout.push(text);
      },
      stderr: (text) => {
        stderr.push(text);
      },
    },
    createSocket,
    ...(options.realAuth === true ? {} : { loadAuthState }),
    fetchVersion,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
  const socket = (): FakeProbeSocket => {
    const first = sockets[0];
    if (first === undefined) throw new Error('Сокет не создан');
    return first;
  };
  const run = (args: readonly string[] = [PHONE]): Promise<number> => runBusinessProbe(args, deps);
  // Проба подписывается на события синхронно сразу после создания сокета: к моменту ожидания подписка уже есть.
  const socketReady = (): Promise<FakeProbeSocket> => firstSocket;
  return {
    deps,
    touches,
    openChatStore,
    storeRun,
    storeClose,
    keysSet,
    calls,
    stdout,
    stderr,
    logs,
    clock: manual,
    acquireLock,
    loadAuthState,
    saveCreds,
    createSocket,
    fetchVersion,
    state,
    socket,
    sockets: () => sockets.length,
    run,
    socketReady,
    runToOpen: async (args) => {
      const running = run(args);
      const fake = await socketReady();
      fake.emit({ 'connection.update': { connection: 'open' } });
      return running;
    },
  };
}

function reportOf(h: Harness): Record<string, unknown> {
  return JSON.parse(h.stdout.join('')) as Record<string, unknown>;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tanbala-probe-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('whatsapp/probe parseProbeNumber', () => {
  it.each([
    ['11 цифр', PHONE],
    ['10 цифр (нижняя граница)', '7701234567'],
    ['15 цифр (верхняя граница)', '123456789012345'],
  ])('принимает %s', (_case, digits) => {
    expect(parseProbeNumber([digits])).toBe(digits);
  });

  it.each([
    ['нет аргументов', []],
    ['два аргумента', [PHONE, PHONE]],
    ['9 цифр', ['770123456']],
    ['16 цифр', ['1234567890123456']],
    ['плюс', [`+${PHONE}`]],
    ['пробелы внутри', ['7701 234 5678']],
    ['пробел по краям', [` ${PHONE}`]],
    ['буква', ['7701234567a']],
    ['дефис', ['7701-234-5678']],
    ['пусто', ['']],
    ['цифры другой письменности', ['٧٧٠١٢٣٤٥٦٧٨']],
    ['JID', [PN_JID]],
  ])('отклоняет: %s', (_case, args) => {
    expect(parseProbeNumber(args)).toBeNull();
  });
});

describe('whatsapp/probe runBusinessProbe: до подключения', () => {
  it.each([[[]], [['abc']], [['123']], [[PHONE, PHONE]]])(
    'неверный номер %j: выход 1 до любых действий, номер в сообщении не повторяется',
    async (args) => {
      const h = setup();

      const code = await h.run(args);

      expect(code).toBe(1);
      expect(h.acquireLock).not.toHaveBeenCalled();
      expect(h.loadAuthState).not.toHaveBeenCalled();
      expect(h.createSocket).not.toHaveBeenCalled();
      expect(h.stdout).toEqual([]);
      expect(h.stderr).toEqual([`${PROBE_USAGE}\n`]);
      expect(PROBE_USAGE).toMatch(/номер.*от 10 до 15/);
      expect(h.stderr.join('')).not.toMatch(/abc|123/);
    },
  );

  it('замок занят: ботом, выход 1 с понятной причиной, ни сессии, ни сокета', async () => {
    const h = setup({ locked: true });

    const code = await h.run();

    expect(code).toBe(1);
    expect(h.stderr.join('')).toContain(MESSAGE_BOT_RUNNING);
    expect(h.stdout).toEqual([]);
    expect(h.loadAuthState).not.toHaveBeenCalled();
    expect(h.createSocket).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['lock']);
  });

  it('папки сессии нет: выход 1, QR не запускается, папка не создаётся, замок снят', async () => {
    const h = setup({ sessionExists: false });

    const code = await h.run();

    expect(code).toBe(1);
    expect(h.stderr.join('')).toContain(MESSAGE_NO_SESSION);
    expect(h.loadAuthState).not.toHaveBeenCalled();
    expect(h.createSocket).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['lock', 'release']);
  });

  it('настоящее чтение сессии: папки нет => она не создаётся; пустая папка => в неё ничего не пишется', async () => {
    const missing = setup({ realAuth: true, sessionExists: false });
    const empty = setup({ realAuth: true });

    const codes = [await missing.run(), await empty.run()];

    expect(codes).toEqual([1, 1]);
    expect(missing.stderr.join('')).toContain(MESSAGE_NO_SESSION);
    expect(empty.stderr.join('')).toContain(MESSAGE_NO_SESSION);
    expect(existsSync(missing.deps.sessionDir)).toBe(false);
    expect(await readdir(empty.deps.sessionDir)).toEqual([]);
    expect(missing.createSocket).not.toHaveBeenCalled();
    expect(empty.createSocket).not.toHaveBeenCalled();
  });

  it('сессия есть, но номер не привязан (в creds нет me): выход 1, сокет не создаётся', async () => {
    const h = setup({ linked: false });

    const code = await h.run();

    expect(code).toBe(1);
    expect(h.stderr.join('')).toContain(MESSAGE_NO_SESSION);
    expect(h.loadAuthState).toHaveBeenCalledWith(h.deps.sessionDir);
    expect(h.createSocket).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['lock', 'release']);
  });

  it('папка сессии вместо папки файл: ошибка загрузки => выход 1, замок снят, текста ошибки нет', async () => {
    const h = setup();
    h.loadAuthState.mockRejectedValueOnce(new Error(`found something at ${PHONE}`));

    const code = await h.run();

    expect(code).toBe(1);
    expect(h.stderr.join('')).toMatch(/Error/);
    expect(h.stderr.join('')).not.toContain(PHONE);
    expect(h.calls).toEqual(['lock', 'release']);
  });
});

describe('whatsapp/probe runBusinessProbe: сокет', () => {
  it('сокет с теми же настройками, что у бота: не онлайн при подключении, без полной истории, сессия из папки', async () => {
    const h = setup();

    await h.runToOpen();

    expect(h.createSocket).toHaveBeenCalledTimes(1);
    const config = h.createSocket.mock.calls[0]?.[0];
    // Тот же объект creds: Baileys меняет его на месте, а saveCreds пишет именно его.
    expect(config?.auth.creds).toBe(h.state.creds);
    expect(config?.markOnlineOnConnect).toBe(false);
    expect(config?.syncFullHistory).toBe(false);
    expect(config?.version).toEqual(VERSION.version);
    const full = { syncType: proto.Message.HistorySyncType.FULL };
    expect(config?.shouldSyncHistoryMessage?.(full)).toBe(false);
    expect(h.loadAuthState).toHaveBeenCalledWith(h.deps.sessionDir);
  });

  it('повторная отправка не из чего: getMessage сокета ничего не находит', async () => {
    const h = setup();
    await h.runToOpen();

    const config = h.createSocket.mock.calls[0]?.[0];

    await expect(config?.getMessage?.({ remoteJid: PN_JID, id: 'M1' })).resolves.toBeUndefined();
  });

  it('версия WhatsApp Web не пришла (сбой): сокет всё равно создаётся, версию выберет Baileys', async () => {
    const h = setup();
    h.fetchVersion.mockRejectedValueOnce(new Error('offline'));

    await h.runToOpen();

    expect(h.createSocket.mock.calls[0]?.[0]).not.toHaveProperty('version');
  });

  it('обработчик событий один; пустые история и сообщения ничего не пишут и не считаются', async () => {
    const h = setup();
    const running = h.run();
    const fake = await h.socketReady();

    fake.emit({
      'messages.upsert': { messages: [], type: 'notify' },
      'messaging-history.set': { chats: [], contacts: [], messages: [], syncType: 0 },
    });
    fake.emit({ 'connection.update': { receivedPendingNotifications: true } });
    fake.emit({ 'connection.update': { connection: 'open' } });
    const code = await running;

    expect(fake.subscriptions()).toBe(1);
    expect(code).toBe(0);
    expect(h.stdout).toHaveLength(1);
    expect(h.touches).toEqual([]);
    expect(h.stderr).toEqual([]);
  });

  it('ключи сессии идут в сокет с учётом записей: keys.set доходит до исходного хранилища', async () => {
    const h = setup();
    const running = h.run();
    const fake = await h.socketReady();
    const config = h.createSocket.mock.calls[0]?.[0];
    const data = { session: { '100000000000001.0': new Uint8Array([1]) } };

    await config?.auth.keys.set(data);
    fake.emit({ 'connection.update': { connection: 'open' } });
    await running;

    expect(config?.auth.keys).not.toBe(h.state.keys);
    expect(h.keysSet).toHaveBeenCalledExactlyOnceWith(data);
  });
});

describe('whatsapp/probe runBusinessProbe: QR и закрытие до открытия', () => {
  it('пришёл qr: сокет закрыт сразу, выход 1, без запросов, повторов и logout, замок снят', async () => {
    const h = setup();
    const running = h.run();
    const fake = await h.socketReady();

    fake.emit({ 'connection.update': { qr: '2@pairing-ref,secret' } });
    const code = await running;

    expect(code).toBe(1);
    expect(h.stderr.join('')).toContain(MESSAGE_QR);
    expect(h.stdout).toEqual([]);
    expect(fake.end).toHaveBeenCalledWith(undefined);
    expect(fake.getBusinessProfile).not.toHaveBeenCalled();
    expect(fake.logout).not.toHaveBeenCalled();
    expect(h.createSocket).toHaveBeenCalledTimes(1);
    expect(h.calls.at(-1)).toBe('release');
  });

  it('текст QR никуда не попадает: ни в вывод, ни в лог', async () => {
    const h = setup();
    const running = h.run();
    const fake = await h.socketReady();

    fake.emit({ 'connection.update': { qr: '2@pairing-ref,secret-qr-payload' } });
    await running;

    expect(JSON.stringify([h.stdout, h.stderr, h.logs])).not.toContain('secret-qr-payload');
  });

  it('qr и open в одной пачке: решает qr, запросов нет', async () => {
    const h = setup();
    const running = h.run();
    const fake = await h.socketReady();

    fake.emit({ 'connection.update': { qr: '2@ref', connection: 'open' } });
    const code = await running;

    expect(code).toBe(1);
    expect(fake.getBusinessProfile).not.toHaveBeenCalled();
  });

  it('пустой qr не считается запросом QR', async () => {
    const h = setup();
    const running = h.run();
    const fake = await h.socketReady();

    fake.emit({ 'connection.update': { qr: '' } });
    fake.emit({ 'connection.update': { connection: 'open' } });

    expect(await running).toBe(0);
  });

  it.each([
    [401, 'сессия отозвана'],
    [440, 'в другом месте'],
    [403, 'отказал в доступе'],
    [405, 'версию клиента'],
    [428, 'соединение закрыто'],
  ])('закрытие до open с кодом %i: выход 1 с причиной, без переподключения', async (code, text) => {
    const h = setup();
    const running = h.run();
    const fake = await h.socketReady();

    fake.emit({
      'connection.update': {
        connection: 'close',
        lastDisconnect: {
          error: Object.assign(new Error('Connection Failure'), { output: { statusCode: code } }),
          date: new Date(),
        },
      },
    });
    const exit = await running;

    expect(exit).toBe(1);
    expect(h.stderr.join('')).toContain(`код ${String(code)}`);
    expect(h.stderr.join('')).toContain(text);
    expect(h.createSocket).toHaveBeenCalledTimes(1);
    expect(fake.getBusinessProfile).not.toHaveBeenCalled();
    expect(fake.logout).not.toHaveBeenCalled();
    expect(h.calls.at(-1)).toBe('release');
  });

  it('закрытие без кода: выход 1, причина без кода', async () => {
    const h = setup();
    const running = h.run();
    const fake = await h.socketReady();

    fake.emit({ 'connection.update': { connection: 'close' } });

    expect(await running).toBe(1);
    expect(h.stderr.join('')).toMatch(/закрыто до открытия/);
    expect(h.stderr.join('')).not.toMatch(/код/);
  });

  it('неизвестный код закрытия называется числом без догадок', async () => {
    const h = setup();
    const running = h.run();
    const fake = await h.socketReady();

    fake.emit({
      'connection.update': {
        connection: 'close',
        lastDisconnect: {
          error: Object.assign(new Error('x'), { output: { statusCode: 599 } }),
          date: new Date(),
        },
      },
    });

    expect(await running).toBe(1);
    expect(h.stderr.join('')).toContain('код 599');
  });
});

describe('whatsapp/probe runBusinessProbe: open и два запроса', () => {
  it('open: запрос по номеру, затем LID из сопоставления и запрос по LID; потом end(undefined), без logout', async () => {
    const h = setup({
      profiles: {
        [PN_JID]: {
          website: ['https://sklad.kz', 'https://shop.kz'],
          email: 'info@sklad.kz',
          category: 'Склад',
          description: 'Хранение',
          address: '',
        },
        [LID_JID]: undefined,
      },
    });

    const code = await h.runToOpen();

    expect(code).toBe(0);
    const fake = h.socket();
    expect(fake.getBusinessProfile.mock.calls.map(([jid]) => jid)).toEqual([PN_JID, LID_JID]);
    expect(fake.getLIDForPN).toHaveBeenCalledExactlyOnceWith(PN_JID);
    expect(fake.end).toHaveBeenCalledWith(undefined);
    expect(fake.logout).not.toHaveBeenCalled();
    // База под замком после проверки сессии; буфер выдаётся до end и при закрытии; база закрыта до снятия замка.
    expect(h.calls).toEqual([
      'lock',
      'db',
      'socket',
      'profile:number',
      'lid-mapping',
      'profile:lid',
      'flush',
      'end',
      'flush',
      'db-close',
      'release',
    ]);
  });

  it('вывод: одна строка JSON с признаками для номера и для LID, без значений полей', async () => {
    const h = setup({
      profiles: {
        [PN_JID]: {
          website: ['https://sklad.kz', 'https://shop.kz'],
          email: 'info@sklad.kz',
          category: 'Склад',
          description: 'Хранение вещей',
          address: '',
        },
        [LID_JID]: {
          website: [],
          email: undefined,
          category: undefined,
          description: '',
          address: 'ул. Абая 1',
        },
      },
    });

    await h.runToOpen();

    expect(h.stdout).toHaveLength(1);
    expect(h.stdout[0]?.endsWith('\n')).toBe(true);
    expect(reportOf(h)).toEqual({
      number: {
        business: true,
        website: 2,
        email: true,
        category: true,
        description: true,
        address: false,
      },
      lid: {
        business: true,
        website: 0,
        email: false,
        category: false,
        description: false,
        address: true,
      },
      receivedMessages: 0,
    });
  });

  it('обычный аккаунт (профиля нет): business false и нули', async () => {
    const h = setup({ profiles: {} });

    await h.runToOpen();

    expect(reportOf(h)).toEqual({ number: NO_PROFILE, lid: NO_PROFILE, receivedMessages: 0 });
  });

  it('сайты считаются только по непустым строкам, остальные поля только по непустым строкам', async () => {
    const h = setup({
      profiles: {
        [PN_JID]: {
          website: ['https://a.kz', '', '  ', 42, null],
          email: '  ',
          category: 7,
          description: null,
          address: '   ',
        },
      },
      lid: null,
    });

    await h.runToOpen();

    expect(reportOf(h)['number']).toEqual({
      business: true,
      website: 1,
      email: false,
      category: false,
      description: false,
      address: false,
    });
  });

  it('website не массив: сайтов ноль', async () => {
    const h = setup({ profiles: { [PN_JID]: { website: 'https://a.kz' } }, lid: null });

    await h.runToOpen();

    expect(reportOf(h)['number']).toMatchObject({ business: true, website: 0 });
  });

  it('LID неизвестен: второго запроса нет, в выводе «LID неизвестен»', async () => {
    const h = setup({ profiles: {}, lid: null });

    const code = await h.runToOpen();

    expect(code).toBe(0);
    expect(h.socket().getBusinessProfile).toHaveBeenCalledTimes(1);
    expect(reportOf(h)).toEqual({
      number: NO_PROFILE,
      lid: { error: 'LID неизвестен' },
      receivedMessages: 0,
    });
  });

  it('сбой запроса по номеру: в выводе имя ошибки и код, проба идёт дальше к LID', async () => {
    const failure = Object.assign(new TypeError(`bad request ${PHONE}`), {
      output: { statusCode: 429 },
    });
    const h = setup({ failures: { [PN_JID]: failure }, profiles: {} });

    const code = await h.runToOpen();

    expect(code).toBe(0);
    expect(reportOf(h)).toEqual({
      number: { error: 'TypeError', status: 429 },
      lid: NO_PROFILE,
      receivedMessages: 0,
    });
  });

  it('сбой без кода и отказ не Error: только имя или тип, без статуса', async () => {
    const h = setup();
    const running = h.run();
    const fake = await h.socketReady();
    // Первый запрос по номеру, второй по LID.
    fake.getBusinessProfile
      .mockRejectedValueOnce(new RangeError('x'))
      .mockRejectedValueOnce('boom');

    fake.emit({ 'connection.update': { connection: 'open' } });
    await running;

    expect(reportOf(h)).toEqual({
      number: { error: 'RangeError' },
      lid: { error: 'string' },
      receivedMessages: 0,
    });
  });

  it('ответ не объект (строка): ошибка UnexpectedResponse', async () => {
    const h = setup({ profiles: { [PN_JID]: 'business' }, lid: null });

    await h.runToOpen();

    expect(reportOf(h)['number']).toEqual({ error: 'UnexpectedResponse' });
  });

  it('сбой сопоставления LID: имя ошибки в разделе lid, запроса по LID нет', async () => {
    const h = setup({ profiles: {}, lidFails: true });

    await h.runToOpen();

    expect(h.socket().getBusinessProfile).toHaveBeenCalledTimes(1);
    expect(reportOf(h)['lid']).toEqual({ error: 'RangeError' });
  });

  it('вывод и лог без номера, JID и значений полей, даже при сбоях', async () => {
    const h = setup({
      profiles: {
        [PN_JID]: {
          website: ['https://secret-site.kz'],
          email: 'secret@mail.kz',
          address: 'Секретная 1',
        },
      },
      failures: { [LID_JID]: new RangeError(`нет ${PN_JID} ${LID_JID}`) },
    });

    await h.runToOpen();

    const everything = JSON.stringify([h.stdout, h.stderr, h.logs]);
    expect(everything).not.toMatch(new RegExp(`${PHONE}|200000000000009|@s\\.whatsapp|@lid`));
    expect(everything).not.toMatch(/secret|Секретная/);
  });

  it('close после open (связь оборвалась во время запросов) проба не прерывает', async () => {
    const h = setup({ profiles: {} });
    const running = h.run();
    const fake = await h.socketReady();

    fake.emit({
      'connection.update': { connection: 'open' },
    });
    fake.emit({ 'connection.update': { connection: 'close' } });

    expect(await running).toBe(0);
    expect(h.stdout).toHaveLength(1);
  });

  it('повторный open не запускает вторую пару запросов', async () => {
    const h = setup({ profiles: {} });
    const running = h.run();
    const fake = await h.socketReady();

    fake.emit({ 'connection.update': { connection: 'open' } });
    fake.emit({ 'connection.update': { connection: 'open' } });
    await running;

    expect(fake.getBusinessProfile).toHaveBeenCalledTimes(2);
  });
});

describe('whatsapp/probe runBusinessProbe: сессия WhatsApp', () => {
  it('creds.update сохраняется, а замок снимается только после сохранения', async () => {
    const h = setup({ profiles: {}, saveDelay: true });
    const running = h.run();
    const fake = await h.socketReady();

    fake.emit({ 'creds.update': {}, 'connection.update': { connection: 'open' } });
    fake.emit({ 'creds.update': {} });
    const code = await running;

    expect(code).toBe(0);
    expect(h.saveCreds).toHaveBeenCalledTimes(2);
    expect(h.calls.slice(-6)).toEqual(['end', 'flush', 'saved', 'saved', 'db-close', 'release']);
  });

  it('сохранение сессии не удалось: JSON выведен, но выход 1 и понятная причина без текста ошибки', async () => {
    const h = setup({ profiles: {}, saveFails: true });
    const running = h.run();
    const fake = await h.socketReady();

    fake.emit({ 'creds.update': {}, 'connection.update': { connection: 'open' } });
    const code = await running;

    expect(code).toBe(1);
    expect(h.stdout).toHaveLength(1);
    expect(h.stderr.join('')).toMatch(/Сессия WhatsApp не сохранилась/);
    expect(h.stderr.join('')).not.toContain('EACCES');
    expect(h.logs).toContainEqual(
      expect.objectContaining({ level: 'error', context: { errorName: 'Error' } }),
    );
    expect(h.calls.at(-1)).toBe('release');
  });

  it('без creds.update сессия не пишется', async () => {
    const h = setup({ profiles: {} });

    await h.runToOpen();

    expect(h.saveCreds).not.toHaveBeenCalled();
  });

  it('сессию не отзывает: logout не вызывается ни на одном пути', async () => {
    const opened = setup({ profiles: {} });
    const refused = setup();

    await opened.runToOpen();
    const running = refused.run();
    const fake = await refused.socketReady();
    fake.emit({ 'connection.update': { qr: '2@ref' } });
    await running;

    expect(opened.socket().logout).not.toHaveBeenCalled();
    expect(fake.logout).not.toHaveBeenCalled();
  });
});

describe('whatsapp/probe runBusinessProbe: общий таймаут', () => {
  it('60 с без open: выход 1, сокет закрыт, замок снят, пауза именно на 60 с', async () => {
    const h = setup();
    const running = h.run();
    const fake = await h.socketReady();
    await h.clock.sleeping(PROBE_TIMEOUT_MS);
    expect(h.clock.pending(PROBE_TIMEOUT_MS)).toBe(1);

    h.clock.expire(PROBE_TIMEOUT_MS);
    const code = await running;

    expect(PROBE_TIMEOUT_MS).toBe(60_000);
    expect(code).toBe(1);
    expect(h.stderr.join('')).toMatch(/не уложилась в 60 с/);
    expect(h.stdout).toEqual([]);
    expect(fake.end).toHaveBeenCalledWith(undefined);
    expect(fake.logout).not.toHaveBeenCalled();
    expect(h.calls.at(-1)).toBe('release');
  });

  it('таймаут идёт и на запросы: профиль не ответил за 60 с', async () => {
    const h = setup();
    const running = h.run();
    const fake = await h.socketReady();
    fake.getBusinessProfile.mockImplementationOnce(() => new Promise(() => undefined));

    fake.emit({ 'connection.update': { connection: 'open' } });
    expect(fake.getBusinessProfile).toHaveBeenCalledTimes(1);
    h.clock.expire(PROBE_TIMEOUT_MS);
    const code = await running;

    expect(code).toBe(1);
    expect(fake.end).toHaveBeenCalledWith(undefined);
    expect(h.stdout).toEqual([]);
  });

  it('таймаут включает и получение версии: сокет и после срока, и после прихода версии не создаётся', async () => {
    const h = setup({ timeoutMs: 5_000 });
    h.fetchVersion.mockImplementationOnce(() => new Promise(() => undefined));
    const running = h.run();
    await h.clock.sleeping(5_000);

    h.clock.expire(5_000);
    const code = await running;
    // Версия «пришла» (её отдельный срок вышел) уже после окончания пробы.
    h.clock.expire(VERSION_FETCH_TIMEOUT_MS);
    await settle();

    expect(code).toBe(1);
    expect(h.stderr.join('')).toMatch(/не уложилась в 5 с/);
    expect(h.createSocket).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['lock', 'db', 'db-close', 'release']);
  });

  it('срок можно задать: timeoutMs', async () => {
    const h = setup({ timeoutMs: 1_234 });
    const running = h.run();
    await h.socketReady();

    await h.clock.sleeping(1_234);
    h.clock.expire(1_234);

    expect(await running).toBe(1);
  });

  it('версия WhatsApp Web ждёт свои 10 с отдельно от общего срока', async () => {
    const h = setup();
    h.fetchVersion.mockImplementationOnce(() => new Promise(() => undefined));
    const running = h.run();
    await h.clock.sleeping(VERSION_FETCH_TIMEOUT_MS);

    h.clock.expire(VERSION_FETCH_TIMEOUT_MS);
    const fake = await h.socketReady();
    fake.emit({ 'connection.update': { connection: 'open' } });

    expect(await running).toBe(0);
  });
});

describe('whatsapp/probe runBusinessProbe: сбои', () => {
  it('сокет не создался (исключение): выход 1, замок снят, текст ошибки не выводится', async () => {
    const h = setup();
    h.createSocket.mockImplementationOnce(() => {
      throw new TypeError(`bad config ${PHONE}`);
    });

    const code = await h.run();

    expect(code).toBe(1);
    expect(h.stderr.join('')).toContain('TypeError');
    expect(h.stderr.join('')).not.toContain(PHONE);
    expect(h.calls.at(-1)).toBe('release');
  });

  it('end сокета упал: проба всё равно завершается, замок снят', async () => {
    const h = setup({ profiles: {} });
    const running = h.run();
    const fake = await h.socketReady();
    fake.end.mockRejectedValueOnce(new Error('Connection Closed'));

    fake.emit({ 'connection.update': { connection: 'open' } });
    const code = await running;

    expect(code).toBe(0);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ level: 'warn', context: { errorName: 'Error' } }),
    );
    expect(h.calls.at(-1)).toBe('release');
  });

  it('end отклонён не ошибкой: в лог тип значения', async () => {
    const h = setup({ profiles: {} });
    const running = h.run();
    const fake = await h.socketReady();
    fake.end.mockRejectedValueOnce('closed');

    fake.emit({ 'connection.update': { connection: 'open' } });

    expect(await running).toBe(0);
    expect(h.logs).toContainEqual({
      level: 'warn',
      context: { errorName: 'string' },
      message: 'Сокет WhatsApp не закрылся',
    });
  });

  it('замок снимается ровно один раз на любом пути', async () => {
    const successful = setup({ profiles: {} });
    const refused = setup({ locked: true });
    const unlinked = setup({ linked: false });

    await successful.runToOpen();
    await refused.run();
    await unlinked.run();

    expect(successful.calls.filter((call) => call === 'release')).toHaveLength(1);
    expect(refused.calls.filter((call) => call === 'release')).toHaveLength(0);
    expect(unlinked.calls.filter((call) => call === 'release')).toHaveLength(1);
  });

  it('PhoneDigits из аргумента уходит в JID номера только цифрами', async () => {
    const h = setup({ profiles: {} });

    await h.runToOpen([PHONE]);

    expect(h.socket().getBusinessProfile.mock.calls[0]?.[0]).toBe(
      `${PHONE as PhoneDigits}@s.whatsapp.net`,
    );
  });
});

describe('whatsapp/probe runBusinessProbe: база бота', () => {
  it('база открывается под замком только после проверки сессии: без сессии её не трогают', async () => {
    const missing = setup({ sessionExists: false });
    const unlinked = setup({ linked: false });

    await missing.run();
    await unlinked.run();

    expect(missing.openChatStore).not.toHaveBeenCalled();
    expect(unlinked.openChatStore).not.toHaveBeenCalled();
  });

  it('базы нет: выход 1 до версии и сокета, замок снят', async () => {
    const h = setup({ storeMissing: true });

    const code = await h.run();

    expect(code).toBe(1);
    expect(h.stderr).toEqual([
      'База бота не найдена: проба не подключается, иначе чаты не попадут в known_chats\n',
    ]);
    expect(h.fetchVersion).not.toHaveBeenCalled();
    expect(h.createSocket).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['lock', 'db', 'release']);
  });

  it('база не открылась: выход 1 с именем ошибки без её текста, сокета нет', async () => {
    const h = setup({ storeFails: true });

    const code = await h.run();

    expect(code).toBe(1);
    expect(h.stderr).toEqual(['База бота не открылась: проба не подключается (ошибка Error)\n']);
    expect(h.stderr.join('')).not.toContain(root);
    expect(h.createSocket).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['lock', 'db', 'release']);
  });

  it('база не закрылась: в лог имя ошибки, итог тот же, замок снят', async () => {
    const h = setup({ profiles: {} });
    h.storeClose.mockImplementationOnce(() => {
      throw new TypeError(`database ${root} is busy`);
    });

    const code = await h.runToOpen();

    expect(code).toBe(0);
    expect(h.logs).toContainEqual({
      level: 'warn',
      context: { errorName: 'TypeError' },
      message: 'База бота не закрылась',
    });
    expect(h.calls.at(-1)).toBe('release');
  });
});

describe('whatsapp/probe runBusinessProbe: сообщения, доставшиеся пробе', () => {
  it('офлайн-очередь до open: чаты в known_chats, число в JSON и строка в stderr, выход 0', async () => {
    const h = setup({ profiles: {}, lid: null });
    const running = h.run();
    const fake = await h.socketReady();

    fake.emit(offlineQueue([clientMessage(), clientMessage(CLIENT_LID, 'B2')]));
    fake.emit({ 'connection.update': { connection: 'open' } });
    const code = await running;

    expect(code).toBe(0);
    expect(h.touches).toEqual([
      { jid: CLIENT_PN, atMs: MESSAGE_SECONDS * 1000, source: 'message' },
      { jid: CLIENT_LID, atMs: MESSAGE_SECONDS * 1000, source: 'message' },
    ]);
    expect(reportOf(h)['receivedMessages']).toBe(2);
    expect(h.stderr).toEqual([receivedLine(2)]);
  });

  it('сообщения во время запросов и чаты синхронизации тоже записываются', async () => {
    const h = setup({ profiles: {}, lid: null });
    const running = h.run();
    const fake = await h.socketReady();

    fake.emit({ 'connection.update': { connection: 'open' } });
    fake.emit({
      ...offlineQueue([clientMessage()]),
      'messaging-history.set': {
        chats: [{ id: CLIENT_LID, conversationTimestamp: MESSAGE_SECONDS }],
        contacts: [],
        messages: [],
        syncType: proto.HistorySync.HistorySyncType.RECENT,
      },
    });
    const code = await running;

    expect(code).toBe(0);
    expect(h.touches).toEqual([
      { jid: CLIENT_LID, atMs: MESSAGE_SECONDS * 1000, source: 'history' },
      { jid: CLIENT_PN, atMs: MESSAGE_SECONDS * 1000, source: 'message' },
    ]);
    expect(reportOf(h)['receivedMessages']).toBe(1);
  });

  it('группы не считаются: строки в stderr нет', async () => {
    const h = setup({ profiles: {}, lid: null });
    const running = h.run();
    const fake = await h.socketReady();

    fake.emit(offlineQueue([clientMessage('120363000000000001@g.us')]));
    fake.emit({ 'connection.update': { connection: 'open' } });
    await running;

    expect(h.touches).toEqual([]);
    expect(reportOf(h)['receivedMessages']).toBe(0);
    expect(h.stderr).toEqual([]);
  });

  it('буфер Baileys выдаётся до end: его сообщения записаны и посчитаны до закрытия базы', async () => {
    const h = setup({ profiles: {}, lid: null, buffered: offlineQueue([clientMessage()]) });

    const code = await h.runToOpen();

    expect(code).toBe(0);
    expect(h.touches).toHaveLength(1);
    expect(reportOf(h)['receivedMessages']).toBe(1);
    expect(h.calls.indexOf('flush')).toBeLessThan(h.calls.indexOf('end'));
    expect(h.calls.slice(-2)).toEqual(['db-close', 'release']);
  });

  it('буфер при закрытии соединения тоже выдаётся (как у бота)', async () => {
    const h = setup({ buffered: offlineQueue([clientMessage()]) });
    const running = h.run();
    const fake = await h.socketReady();

    fake.emit({ 'connection.update': { connection: 'close' } });
    const code = await running;

    expect(code).toBe(1);
    expect(fake.flush).toHaveBeenCalled();
    expect(h.touches).toHaveLength(1);
    expect(h.stderr).toContain(receivedLine(1));
  });

  it('flush упал: в лог имя ошибки, проба завершается', async () => {
    const h = setup({ profiles: {}, flushFails: true });

    const code = await h.runToOpen();

    expect(code).toBe(0);
    expect(h.logs).toContainEqual({
      level: 'error',
      context: { errorName: 'Error' },
      message: 'Накопленные события WhatsApp не выданы',
    });
  });

  it('запись чатов упала: JSON есть, но выход 1, строка без «чаты записаны» и строка о неполных чатах', async () => {
    const h = setup({ profiles: {}, lid: null });
    h.storeRun.mockImplementation(() => {
      throw new Error('SQLITE_FULL');
    });
    const running = h.run();
    const fake = await h.socketReady();

    fake.emit(offlineQueue([clientMessage()]));
    fake.emit({ 'connection.update': { connection: 'open' } });
    const code = await running;

    expect(code).toBe(1);
    expect(reportOf(h)['receivedMessages']).toBe(1);
    expect(h.stderr).toEqual([receivedLine(1, false), `${MESSAGE_CHATS_INCOMPLETE}\n`]);
  });

  it('срок пробы вышел после сообщений: JSON нет, но число сообщений в stderr', async () => {
    const h = setup();
    const running = h.run();
    const fake = await h.socketReady();
    fake.getBusinessProfile.mockImplementationOnce(() => new Promise(() => undefined));

    fake.emit(offlineQueue([clientMessage()]));
    fake.emit({ 'connection.update': { connection: 'open' } });
    h.clock.expire(PROBE_TIMEOUT_MS);
    const code = await running;

    expect(code).toBe(1);
    expect(h.stdout).toEqual([]);
    expect(h.stderr.join('')).toMatch(/не уложилась в 60 с/);
    expect(h.stderr).toContain(receivedLine(1));
    expect(h.touches).toHaveLength(1);
  });

  it('ни в выводе, ни в логе нет номеров, JID и текста сообщений', async () => {
    const h = setup({ profiles: {}, lid: null });
    const running = h.run();
    const fake = await h.socketReady();

    fake.emit(offlineQueue([clientMessage(), clientMessage(CLIENT_LID, 'B2')]));
    fake.emit({ 'connection.update': { connection: 'open' } });
    await running;

    const everything = JSON.stringify([h.stdout, h.stderr, h.logs]);
    expect(everything).not.toMatch(/77000000001|100000000000001|@s\.whatsapp|@lid|учёт/);
  });
});

describe('whatsapp/probe runBusinessProbe: запись сессии при закрытии', () => {
  const KEY = { session: { '100000000000001.0': new Uint8Array([1]) } };

  it('незаконченная запись ключа: база закрывается и замок снимается только после неё', async () => {
    const h = setup({ profiles: {}, lid: null });
    h.keysSet.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          setImmediate(() => {
            h.calls.push('keys-saved');
            resolve();
          });
        }),
    );
    const running = h.run();
    const fake = await h.socketReady();
    const config = h.createSocket.mock.calls[0]?.[0];

    void config?.auth.keys.set(KEY);
    fake.emit({ 'connection.update': { connection: 'open' } });
    const code = await running;

    expect(code).toBe(0);
    expect(h.calls.slice(-4)).toEqual(['flush', 'keys-saved', 'db-close', 'release']);
  });

  it('запись ключа упала: JSON есть, выход 1 и причина о сессии без текста ошибки', async () => {
    const h = setup({ profiles: {}, lid: null });
    h.keysSet.mockImplementationOnce(() => Promise.reject(new Error(`EACCES ${root}`)));
    const running = h.run();
    const fake = await h.socketReady();
    const config = h.createSocket.mock.calls[0]?.[0];

    await expect(config?.auth.keys.set(KEY)).rejects.toThrow();
    fake.emit({ 'connection.update': { connection: 'open' } });
    const code = await running;

    expect(code).toBe(1);
    expect(h.stdout).toHaveLength(1);
    expect(h.stderr.join('')).toMatch(MESSAGE_CREDS);
    expect(h.stderr.join('')).not.toContain(root);
  });

  it('запись сессии зависла: закрытие ждёт не дольше 20 с, выход 1, база закрыта, замок снят', async () => {
    const h = setup({ profiles: {}, lid: null });
    h.keysSet.mockImplementationOnce(() => new Promise<void>(() => undefined));
    const running = h.run();
    const fake = await h.socketReady();
    const config = h.createSocket.mock.calls[0]?.[0];

    void config?.auth.keys.set(KEY);
    fake.emit({ 'connection.update': { connection: 'open' } });
    await h.clock.sleeping(PROBE_CLOSE_TIMEOUT_MS);
    h.clock.expire(PROBE_CLOSE_TIMEOUT_MS);
    const code = await running;

    expect(PROBE_CLOSE_TIMEOUT_MS).toBe(20_000);
    expect(code).toBe(1);
    expect(h.stdout).toHaveLength(1);
    expect(h.stderr).toEqual([
      'Запись сессии WhatsApp и чатов не закончилась за 20 с: сессия могла сохраниться не полностью\n',
    ]);
    expect(h.logs).toContainEqual({
      level: 'error',
      context: { timeoutMs: PROBE_CLOSE_TIMEOUT_MS },
      message: 'Проба не дождалась записи сессии и чатов',
    });
    expect(h.calls.slice(-2)).toEqual(['db-close', 'release']);
  });

  it('чаты в очереди к сроку закрытия не записаны: строка о неполных чатах, сокет закрыт без ожидания, выход 1', async () => {
    const h = setup({ profiles: {}, lid: null, pnHangs: true });
    const running = h.run();
    const fake = await h.socketReady();

    fake.emit(offlineQueue([clientMessage(CLIENT_LID)]));
    fake.emit({ 'connection.update': { connection: 'open' } });
    await h.clock.sleeping(PROBE_CLOSE_TIMEOUT_MS);
    expect(fake.end).not.toHaveBeenCalled();
    h.clock.expire(PROBE_CLOSE_TIMEOUT_MS);
    const code = await running;

    expect(code).toBe(1);
    expect(h.stderr).toContain(`${MESSAGE_CHATS_INCOMPLETE}\n`);
    expect(fake.end).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(fake.logout).not.toHaveBeenCalled();
    expect(h.calls.slice(-2)).toEqual(['db-close', 'release']);
  });
});
