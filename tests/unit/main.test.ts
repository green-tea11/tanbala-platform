import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { ConfigError, formatFatalError } from '../../src/config/errors.js';
import { acquireProcessLock, ProcessLockBusyError } from '../../src/db/process-lock.js';
import type { Jid, WaMessageId } from '../../src/domain/types.js';
import { main, type MainOptions, type RunningApp } from '../../src/main.js';
import { SafeError } from '../../src/shared/safe-error.js';
import {
  LinkBoundaryMissingError,
  PairingLimitError,
  type WhatsAppConnection,
  type WhatsAppDeps,
  type WhatsAppStopReason,
} from '../../src/whatsapp/connection.js';
import type { WaEvent } from '../../src/whatsapp/inbound.js';
import { ROOT as PROJECT_ROOT } from '../helpers/source-files.js';

// main во временном корне (os.tmpdir) с копией config/models.json. Настоящий адаптер WhatsApp и сокет Baileys
// в тестах недостижимы: каждый вызов main получает шов startWhatsApp, по умолчанию отказывающий (useHarness).
// Сеть в тестах к тому же заблокирована. Номера вымышленные.

type EnvInput = Readonly<Record<string, string | undefined>>;
type StartWhatsApp = Mock<(deps: WhatsAppDeps) => Promise<WhatsAppConnection>>;

interface LogRecord {
  readonly level: number;
  readonly msg?: string;
  readonly [key: string]: unknown;
}

const INFO = 30;
const WARN = 40;
const ERROR = 50;
const HOUR_MS = 3_600_000;
const CLIENT_PHONE = '77000000002';
const CLIENT_JID = `${CLIENT_PHONE}@s.whatsapp.net` as Jid;
const MANAGER_PHONE = '77000000009';
const DISABLED_ENV: EnvInput = {
  WA_ENABLED: 'false',
  TEST_MODE: 'true',
  TEST_ALLOWLIST: CLIENT_PHONE,
};
const ENABLED_ENV: EnvInput = { ...DISABLED_ENV, WA_ENABLED: 'true' };
const TABLES = [
  'app_state',
  'backlog_chats',
  'chats',
  'known_chats',
  'messages',
  'pairing_attempts',
];
const LOCK_BUSY_TEXT = 'Бот уже запущен: папка данных занята другим процессом';

const CLIENT_EVENT: WaEvent = {
  type: 'client',
  message: {
    waId: 'WA-1' as WaMessageId,
    identity: { replyJid: CLIENT_JID, lidJid: null, pnJid: CLIENT_JID },
    pushName: null,
    content: { kind: 'text', text: 'Здравствуйте' },
    tsMs: Date.UTC(2026, 9, 25, 9, 0, 0),
  },
};

const STALE_EVENT: WaEvent = {
  type: 'stale',
  message: { ...CLIENT_EVENT.message, waId: 'WA-2' as WaMessageId, tsMs: Date.UTC(2026, 9, 24) },
};

/** Шов по умолчанию: тест без своего шва не дойдёт до настоящего адаптера и сокета Baileys. */
function refuseRealWhatsApp(): Promise<WhatsAppConnection> {
  return Promise.reject(new Error('Тест без шва startWhatsApp: настоящий сокет запрещён'));
}

interface Harness {
  readonly root: string;
  readonly dbPath: string;
  readonly lockPath: string;
  records(): LogRecord[];
  run(env: EnvInput, extra?: Partial<MainOptions>): Promise<RunningApp>;
}

/** Временный корень проекта с data/ и копией config/models.json; после теста приложения стоп, папка удаляется. */
function useHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'tanbala-main-test-'));
  mkdirSync(join(root, 'config'));
  mkdirSync(join(root, 'data'));
  copyFileSync(join(PROJECT_ROOT, 'config', 'models.json'), join(root, 'config', 'models.json'));
  const apps: RunningApp[] = [];
  const lines: string[] = [];
  onTestFinished(async () => {
    await Promise.allSettled(apps.map((app) => app.stop()));
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    dbPath: join(root, 'data', 'tanbala.db'),
    lockPath: join(root, 'data', 'process.lock'),
    records: () => lines.map((line) => JSON.parse(line) as LogRecord),
    async run(env, extra = {}) {
      const destination = { write: (line: string): void => void lines.push(line) };
      const app = await main({
        env,
        root,
        logDestination: destination,
        ...extra,
        startWhatsApp: extra.startWhatsApp ?? refuseRealWhatsApp,
      });
      apps.push(app);
      return app;
    },
  };
}

/** Поддельное подключение: остановку можно проверить и сломать. */
function fakeConnection(stop: () => Promise<void> = () => Promise.resolve()): {
  readonly connection: WhatsAppConnection;
  readonly stop: Mock<() => Promise<void>>;
} {
  const stopMock = vi.fn(stop);
  const connection: WhatsAppConnection = {
    newMessageId: () => 'OUT-1' as WaMessageId,
    sendText: () => Promise.reject(new Error('этап 2 ничего не отправляет')),
    setTyping: () => Promise.reject(new Error('этап 2 ничего не отправляет')),
    markRead: () => Promise.reject(new Error('этап 2 ничего не отмечает')),
    downloadAudio: () => Promise.reject(new Error('этап 7')),
    resolvePhone: () => Promise.resolve(null),
    stop: stopMock,
  };
  return { connection, stop: stopMock };
}

function fakeStart(connection: WhatsAppConnection): StartWhatsApp {
  return vi.fn((_deps: WhatsAppDeps) => Promise.resolve(connection));
}

function failingStart(error: Error): StartWhatsApp {
  return vi.fn((_deps: WhatsAppDeps) => Promise.reject(error));
}

function depsOf(start: StartWhatsApp): WhatsAppDeps {
  const deps = start.mock.calls[0]?.[0];
  if (deps === undefined) throw new Error('startWhatsApp не вызван');
  return deps;
}

/** WAL: файлы -wal и -shm есть, пока база открыта; последнее соединение при закрытии удаляет их. */
function databaseOpen(dbPath: string): boolean {
  return existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`);
}

/** Свободен ли замок процесса: тест берёт его и сразу отпускает. */
function lockFree(lockPath: string): boolean {
  try {
    acquireProcessLock(lockPath).release();
    return true;
  } catch (error: unknown) {
    if (error instanceof ProcessLockBusyError) return false;
    throw error;
  }
}

/** Отдельное соединение теста; закрывается сразу, чтобы не держать файл. */
function readDb<T>(dbPath: string, read: (db: Database.Database) => T): T {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function count(dbPath: string, table: string): number {
  return readDb(dbPath, (db) => Number(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()));
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Ожидалась ошибка');
}

describe('main: WA_ENABLED=false', () => {
  it('создаёт и мигрирует базу, к WhatsApp не подключается, stop закрывает базу и снимает замок', async () => {
    const harness = useHarness();
    const startWhatsApp = fakeStart(fakeConnection().connection);

    const app = await harness.run(DISABLED_ENV, { startWhatsApp });

    expect(startWhatsApp).not.toHaveBeenCalled();
    expect(harness.records()).toContainEqual(
      expect.objectContaining({ level: WARN, msg: 'WhatsApp выключен (WA_ENABLED=false)' }),
    );
    expect(databaseOpen(harness.dbPath)).toBe(true);
    expect(lockFree(harness.lockPath)).toBe(false);

    await app.stop();

    expect(databaseOpen(harness.dbPath)).toBe(false);
    expect(lockFree(harness.lockPath)).toBe(true);
    await expect(app.stopped).resolves.toBe('requested');
    expect(harness.records()).toContainEqual(
      expect.objectContaining({ level: INFO, msg: 'Бот остановлен', ignored: 0 }),
    );
    readDb(harness.dbPath, (db) => {
      expect(db.pragma('user_version', { simple: true })).toBe(1);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .pluck()
        .all();
      expect(tables).toEqual(TABLES);
    });
  });

  it('stop идемпотентный: повторный вызов не падает и не пишет лог второй раз', async () => {
    const harness = useHarness();
    const app = await harness.run(DISABLED_ENV);

    await app.stop();
    await app.stop();

    const stops = harness.records().filter((record) => record.msg === 'Бот остановлен');
    expect(stops).toHaveLength(1);
  });

  it('при старте в лог: WhatsApp выключен, закрытый режим включён, число номеров без самих номеров', async () => {
    const harness = useHarness();

    await harness.run({ ...DISABLED_ENV, TEST_ALLOWLIST: `${CLIENT_PHONE}, 77000000003` });

    expect(harness.records()).toContainEqual(
      expect.objectContaining({
        level: INFO,
        waEnabled: false,
        allowlistSize: 2,
        msg: 'Запуск: WhatsApp выключен, закрытый режим включён, номеров в TEST_ALLOWLIST: 2',
      }),
    );
    expect(JSON.stringify(harness.records())).not.toMatch(/77000000002|77000000003/);
  });

  it('предупреждения настроек пишутся в лог', async () => {
    const harness = useHarness();

    await harness.run({ WA_ENABLED: 'false', TEST_MODE: 'true' });

    expect(harness.records()).toContainEqual(
      expect.objectContaining({
        level: WARN,
        msg: expect.stringContaining('TEST_ALLOWLIST') as unknown,
      }),
    );
  });
});

describe('main: замок процесса', () => {
  it('лежит в папке данных (data/process.lock) и взят до startWhatsApp', async () => {
    const harness = useHarness();
    const { connection } = fakeConnection();
    let freeAtStart: boolean | null = null;
    const startWhatsApp: StartWhatsApp = vi.fn(() => {
      freeAtStart = lockFree(harness.lockPath);
      return Promise.resolve(connection);
    });

    await harness.run(ENABLED_ENV, { startWhatsApp });

    expect(existsSync(harness.lockPath)).toBe(true);
    expect(freeAtStart).toBe(false);
  });

  it('второй main на том же корне: ProcessLockBusyError до WhatsApp, текст в лог; после stop первого запуск снова возможен', async () => {
    const harness = useHarness();
    const first = await harness.run(ENABLED_ENV, {
      startWhatsApp: fakeStart(fakeConnection().connection),
    });
    const secondStart = fakeStart(fakeConnection().connection);

    const error = await errorOf(harness.run(ENABLED_ENV, { startWhatsApp: secondStart }));

    expect(error).toBeInstanceOf(ProcessLockBusyError);
    expect(error).toBeInstanceOf(SafeError);
    expect(secondStart).not.toHaveBeenCalled();
    expect(harness.records()).toContainEqual(
      expect.objectContaining({ level: ERROR, msg: LOCK_BUSY_TEXT }),
    );
    expect(formatFatalError(error)).toContain(LOCK_BUSY_TEXT);
    expect(databaseOpen(harness.dbPath)).toBe(true);

    await first.stop();

    await expect(harness.run(DISABLED_ENV)).resolves.toBeDefined();
  });
});

describe('main: ошибки настроек', () => {
  it('ConfigError: в лог её текстом, всплывает; база и замок не создаются', async () => {
    const harness = useHarness();

    const error = await errorOf(harness.run({ ...DISABLED_ENV, PANEL_PORT: '0' }));

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toEqual([expect.stringMatching(/^PANEL_PORT: /)]);
    expect(harness.records()).toEqual([
      expect.objectContaining({ level: ERROR, msg: (error as ConfigError).message }),
    ]);
    expect(existsSync(harness.dbPath)).toBe(false);
    expect(existsSync(harness.lockPath)).toBe(false);
  });

  it('TEST_MODE=false до этапа 8: ConfigError, к WhatsApp не подключается', async () => {
    const harness = useHarness();
    const startWhatsApp = fakeStart(fakeConnection().connection);

    const error = await errorOf(
      harness.run({ ...ENABLED_ENV, TEST_MODE: 'false' }, { startWhatsApp }),
    );

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toEqual([expect.stringMatching(/^TEST_MODE: /)]);
    expect(startWhatsApp).not.toHaveBeenCalled();
    expect(existsSync(harness.dbPath)).toBe(false);
  });

  it('нет config/models.json: ConfigError с причиной', async () => {
    const harness = useHarness();
    rmSync(join(harness.root, 'config', 'models.json'));

    const error = await errorOf(harness.run(DISABLED_ENV));

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toEqual([
      'config/models.json: файл не читается (ENOENT)',
    ]);
    expect(existsSync(harness.dbPath)).toBe(false);
  });

  it('config/models.json не JSON: ConfigError с причиной', async () => {
    const harness = useHarness();
    writeFileSync(join(harness.root, 'config', 'models.json'), '{ "reply": ');

    const error = await errorOf(harness.run(DISABLED_ENV));

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toEqual(['config/models.json: файл не в формате JSON']);
  });

  it('config/models.json с меткой BOM (Блокнот Windows) читается', async () => {
    const harness = useHarness();
    const modelsPath = join(harness.root, 'config', 'models.json');
    writeFileSync(modelsPath, `${String.fromCharCode(0xfeff)}${readFileSync(modelsPath, 'utf8')}`);

    await expect(harness.run(DISABLED_ENV)).resolves.toBeDefined();
  });

  it('схема базы новее кода: ошибка в лог, база закрыта, замок снят', async () => {
    const harness = useHarness();
    const db = new Database(harness.dbPath);
    db.pragma('user_version = 99');
    db.close();

    await expect(harness.run(DISABLED_ENV)).rejects.toThrow(/Схема базы новее кода/);

    expect(databaseOpen(harness.dbPath)).toBe(false);
    expect(lockFree(harness.lockPath)).toBe(true);
    expect(harness.records()).toContainEqual(
      expect.objectContaining({ level: ERROR, msg: 'Бот не запущен' }),
    );
  });
});

describe('main: WA_ENABLED=true, зависимости WhatsApp', () => {
  it('startWhatsApp получает настройки: папку сессии, номер менеджера, закрытый режим, порог простоя', async () => {
    const harness = useHarness();
    const startWhatsApp = fakeStart(fakeConnection().connection);

    await harness.run(
      { ...ENABLED_ENV, MANAGER_WHATSAPP: MANAGER_PHONE, BACKLOG_MAX_AGE_HOURS: '6' },
      { startWhatsApp },
    );

    expect(startWhatsApp).toHaveBeenCalledTimes(1);
    expect(depsOf(startWhatsApp)).toMatchObject({
      sessionDir: join(harness.root, 'data', 'whatsapp-session'),
      managerPhone: MANAGER_PHONE,
      testAllowlist: new Set([CLIENT_PHONE]),
      backlogMaxAgeMs: 6 * HOUR_MS,
    });
    expect(harness.records()).toContainEqual(
      expect.objectContaining({
        level: INFO,
        waEnabled: true,
        allowlistSize: 1,
        msg: 'Запуск: WhatsApp включён, закрытый режим включён, номеров в TEST_ALLOWLIST: 1',
      }),
    );
  });

  it('логгер, часы, состояние приложения, лимит QR с копией в корне и пустой getSentText', async () => {
    const harness = useHarness();
    const startWhatsApp = fakeStart(fakeConnection().connection);
    await harness.run(ENABLED_ENV, { startWhatsApp });
    const deps = depsOf(startWhatsApp);

    deps.logger.info({}, 'запись через логгер WhatsApp');
    deps.appState.markHistoryIncomplete(Date.now());

    expect(harness.records()).toContainEqual(
      expect.objectContaining({ msg: 'запись через логгер WhatsApp' }),
    );
    expect(Math.abs(deps.clock.now() - Date.now())).toBeLessThan(60_000);
    expect(deps.appState.getLinkedAtMs()).toBeNull();
    expect(count(harness.dbPath, 'app_state')).toBe(1);
    expect(deps.pairingGuard.tryBeginAttempt(Date.now())).toEqual({ ok: true, attemptsLeft: 1 });
    expect(existsSync(join(harness.root, '.pairing-attempts.json'))).toBe(true);
    expect(count(harness.dbPath, 'pairing_attempts')).toBe(1);
    await expect(deps.getSentText('OUT-1' as WaMessageId, CLIENT_JID)).resolves.toBeNull();
  });

  it('QR показывается картинкой data/qr.png: presenter убирает именно её', async () => {
    const harness = useHarness();
    const startWhatsApp = fakeStart(fakeConnection().connection);
    await harness.run(ENABLED_ENV, { startWhatsApp });
    const qrPath = join(harness.root, 'data', 'qr.png');
    writeFileSync(qrPath, 'старая картинка');

    await depsOf(startWhatsApp).presenter?.clear();

    expect(existsSync(qrPath)).toBe(false);
  });

  it('onEvent и onHistoryChats пишут в базу; onOfflineQueueDone пишет в лог число чатов простоя', async () => {
    const harness = useHarness();
    const startWhatsApp = fakeStart(fakeConnection().connection);
    await harness.run(ENABLED_ENV, { startWhatsApp });
    const deps = depsOf(startWhatsApp);

    await deps.onEvent(CLIENT_EVENT);
    await deps.onEvent(STALE_EVENT);
    await deps.onHistoryChats([{ jid: CLIENT_JID, lastMessageAtMs: null }]);
    await deps.onOfflineQueueDone();

    expect(count(harness.dbPath, 'messages')).toBe(2);
    expect(count(harness.dbPath, 'backlog_chats')).toBe(1);
    expect(count(harness.dbPath, 'known_chats')).toBe(1);
    expect(harness.records()).toContainEqual(
      expect.objectContaining({
        level: INFO,
        count: 1,
        msg: expect.stringContaining('чатов простоя') as unknown,
      }),
    );
  });
});

describe('main: остановка с WhatsApp', () => {
  it('stop останавливает WhatsApp один раз, закрывает базу и снимает замок; stopped: requested', async () => {
    const harness = useHarness();
    const { connection, stop } = fakeConnection();
    const app = await harness.run(ENABLED_ENV, { startWhatsApp: fakeStart(connection) });

    await app.stop();
    await app.stop();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(databaseOpen(harness.dbPath)).toBe(false);
    expect(lockFree(harness.lockPath)).toBe(true);
    await expect(app.stopped).resolves.toBe('requested');
  });

  it('сбой остановки WhatsApp: база закрыта и замок снят, ошибка всплывает, stopped всё равно приходит', async () => {
    const harness = useHarness();
    const { connection } = fakeConnection(() => Promise.reject(new Error('сокет завис')));
    const app = await harness.run(ENABLED_ENV, { startWhatsApp: fakeStart(connection) });

    await expect(app.stop()).rejects.toThrow('сокет завис');

    expect(databaseOpen(harness.dbPath)).toBe(false);
    expect(lockFree(harness.lockPath)).toBe(true);
    await expect(app.stopped).resolves.toBe('requested');
  });

  it('самоостановка: база закрывается после остановки подключения, события его очереди записываются', async () => {
    const harness = useHarness();
    const holder: { deps: WhatsAppDeps | null } = { deps: null };
    // Повторный stop() адаптера дожидается его очереди: последнее событие приходит во время остановки.
    const { connection, stop } = fakeConnection(
      () => holder.deps?.onEvent(CLIENT_EVENT) ?? Promise.resolve(),
    );
    const startWhatsApp: StartWhatsApp = vi.fn((deps: WhatsAppDeps) => {
      holder.deps = deps;
      return Promise.resolve(connection);
    });
    const app = await harness.run(ENABLED_ENV, { startWhatsApp });

    await depsOf(startWhatsApp).onStopped('gave_up');

    expect(stop).toHaveBeenCalledTimes(1);
    expect(count(harness.dbPath, 'messages')).toBe(1);
    expect(databaseOpen(harness.dbPath)).toBe(false);
    await expect(app.stopped).resolves.toBe('gave_up');
  });

  it('самоостановка во время запуска: остановка дожидается запуска и останавливает подключение', async () => {
    const harness = useHarness();
    const { connection, stop } = fakeConnection();
    const startWhatsApp: StartWhatsApp = vi.fn((deps: WhatsAppDeps) => {
      void deps.onStopped('forbidden');
      return Promise.resolve(connection);
    });

    const app = await harness.run(ENABLED_ENV, { startWhatsApp });

    await expect(app.stopped).resolves.toBe('forbidden');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(databaseOpen(harness.dbPath)).toBe(false);
    expect(lockFree(harness.lockPath)).toBe(true);
  });

  it('самоостановка, затем отказ запуска: всплывает ошибка запуска, база закрыта, замок снят', async () => {
    const harness = useHarness();
    const startWhatsApp: StartWhatsApp = vi.fn((deps: WhatsAppDeps) => {
      void deps.onStopped('reconnect_failed');
      return Promise.reject(new Error('Сбой открытия сокета'));
    });

    await expect(harness.run(ENABLED_ENV, { startWhatsApp })).rejects.toThrow(
      'Сбой открытия сокета',
    );

    expect(databaseOpen(harness.dbPath)).toBe(false);
    expect(lockFree(harness.lockPath)).toBe(true);
  });

  it.each<[WhatsAppStopReason, RegExp]>([
    ['logged_out', /сессия отозвана в телефоне.*новая привязка/],
    ['pairing_timeout', /QR не отсканирован.*связь оборвалась.*засчитана.*вручную/],
    [
      'replaced',
      /подключён в другом месте.*Если второго экземпляра нет, отвяжите устройство в телефоне и удалите папку сессии/,
    ],
    ['forbidden', /отказал в доступе/],
    ['gave_up', /переподключиться не удалось/],
    ['reconnect_failed', /сбой при переподключении/],
    ['version_rejected', /отклонил версию клиента.*обновить Baileys/],
    ['session_save_failed', /сессия не сохранилась на диск.*место/],
    ['link_save_failed', /момент привязки не записался в базу.*привяжите номер заново/],
    ['handler_failed', /сбоев подряд.*выше в логе/],
  ])(
    'onStopped(%s): понятный лог владельцу, подключение остановлено, база закрыта, замок снят, stopped с причиной',
    async (reason, text) => {
      const harness = useHarness();
      const { connection, stop } = fakeConnection();
      const startWhatsApp = fakeStart(connection);
      const app = await harness.run(ENABLED_ENV, { startWhatsApp });
      const deps = depsOf(startWhatsApp);

      await deps.onStopped(reason);

      expect(harness.records()).toContainEqual(
        expect.objectContaining({
          level: ERROR,
          reason,
          msg: expect.stringMatching(text) as unknown,
        }),
      );
      expect(stop).toHaveBeenCalledTimes(1);
      expect(databaseOpen(harness.dbPath)).toBe(false);
      expect(lockFree(harness.lockPath)).toBe(true);
      await expect(app.stopped).resolves.toBe(reason);
      await expect(deps.onEvent(CLIENT_EVENT)).resolves.toBeUndefined();
      await expect(
        deps.onHistoryChats([{ jid: CLIENT_JID, lastMessageAtMs: 1 }]),
      ).resolves.toBeUndefined();
      await expect(deps.onOfflineQueueDone()).resolves.toBeUndefined();
      await app.stop();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(count(harness.dbPath, 'messages')).toBe(0);
      expect(count(harness.dbPath, 'known_chats')).toBe(0);
    },
  );
});

describe('main: отказ запуска WhatsApp', () => {
  it.each<[string, number, string]>([
    ['секунды округляются вверх', Date.UTC(2026, 9, 26, 9, 5, 30), '26.10.2026 14:06'],
    ['ровная минута', Date.UTC(2026, 9, 26, 9, 5, 0), '26.10.2026 14:05'],
    ['переход даты и года', Date.UTC(2026, 11, 31, 19, 0, 0), '01.01.2027 00:00'],
  ])(
    'PairingLimitError (%s): текст со временем по Алматы в лог и в stderr, база закрыта, замок снят',
    async (_case, retryAtMs, almatyTime) => {
      const harness = useHarness();
      const startWhatsApp = failingStart(new PairingLimitError(retryAtMs));

      const error = await errorOf(harness.run(ENABLED_ENV, { startWhatsApp }));

      const expected = `не раньше ${almatyTime} по времени Алматы (UTC+5)`;
      expect(error).toBeInstanceOf(PairingLimitError);
      expect(error).toMatchObject({
        retryAtMs,
        message: expect.stringContaining(expected) as unknown,
      });
      expect(harness.records()).toContainEqual(
        expect.objectContaining({ level: ERROR, msg: (error as PairingLimitError).message }),
      );
      expect(formatFatalError(error)).toContain(expected);
      expect(databaseOpen(harness.dbPath)).toBe(false);
      expect(lockFree(harness.lockPath)).toBe(true);
    },
  );

  it('LinkBoundaryMissingError: всплывает как есть, в лог и в stderr её текстом', async () => {
    const harness = useHarness();
    const failure = new LinkBoundaryMissingError();

    const error = await errorOf(harness.run(ENABLED_ENV, { startWhatsApp: failingStart(failure) }));

    expect(error).toBe(failure);
    expect(harness.records()).toContainEqual(
      expect.objectContaining({ level: ERROR, msg: failure.message }),
    );
    expect(formatFatalError(error)).toContain(failure.message);
    expect(databaseOpen(harness.dbPath)).toBe(false);
  });

  it('прочая ошибка запуска всплывает как есть, в лог без текста в msg, база закрыта, замок снят', async () => {
    const harness = useHarness();
    const failure = new Error('Сбой открытия сокета');

    const error = await errorOf(harness.run(ENABLED_ENV, { startWhatsApp: failingStart(failure) }));

    expect(error).toBe(failure);
    expect(harness.records()).toContainEqual(
      expect.objectContaining({
        level: ERROR,
        msg: 'Бот не запущен',
        err: expect.objectContaining({ message: 'Сбой открытия сокета' }) as unknown,
      }),
    );
    expect(databaseOpen(harness.dbPath)).toBe(false);
    expect(lockFree(harness.lockPath)).toBe(true);
  });
});
