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
import type { Clock, ImageInput, LlmClient } from '../../src/domain/ports.js';
import type { Jid, LlmResult, WaMessageId } from '../../src/domain/types.js';
import { main, type MainOptions, type RunningApp } from '../../src/main.js';
import type { PanelApp, PanelStarter } from '../../src/pipeline/panel-setup.js';
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
import { scriptedLlm } from './pipeline/scripted-llm.js';

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
const MANAGER_JID = `${MANAGER_PHONE}@s.whatsapp.net` as Jid;
const FIVE_MINUTES_MS = 5 * 60_000;
const DISABLED_ENV: EnvInput = {
  WA_ENABLED: 'false',
  TEST_MODE: 'true',
  TEST_ALLOWLIST: CLIENT_PHONE,
};
const ENABLED_ENV: EnvInput = { ...DISABLED_ENV, WA_ENABLED: 'true' };
const TABLES = [
  'api_usage',
  'app_state',
  'backlog_chats',
  'chat_companies',
  'chats',
  'client_profiles',
  'handoffs',
  'known_chats',
  'manager_notifications',
  'messages',
  'outbound_ids',
  'pairing_attempts',
];
/** Последняя версия схемы на момент проверки: новые миграции версию только повышают. */
const MIN_SCHEMA_VERSION = 6;
const LOCK_BUSY_TEXT = 'Бот уже запущен: папка данных занята другим процессом';
const STRANGER_PHONE = '77000000005';
const STRANGER_JID = `${STRANGER_PHONE}@s.whatsapp.net` as Jid;
const SUMMARY_INTERVAL_MS = 10 * 60_000;
const SUMMARY_PREFIX = 'Пропущено с запуска';
const MANAGER_IN_ALLOWLIST_TEXT =
  'Номер менеджера есть в TEST_ALLOWLIST: сообщения с него бот считает служебными (причина manager) ' +
  'и не сохраняет. Для теста укажите другой номер менеджера или оставьте MANAGER_WHATSAPP пустым';

/** Пропуск чата вне списка: так его отдаёт whatsapp/inbound.ts. */
const NOT_ALLOWLISTED_EVENT: WaEvent = {
  type: 'ignore',
  reason: 'not_allowlisted',
  chatJid: STRANGER_JID,
  tsMs: Date.UTC(2026, 9, 25, 9, 0, 0),
};

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

/** Шов по умолчанию: панель собирается, но порт не занимает (тесты идут параллельно, сеть в них запрещена). */
function noPanelListen(): Promise<void> {
  return Promise.resolve();
}

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
        startPanel: extra.startPanel ?? noPanelListen,
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
  let sent = 0;
  const connection: WhatsAppConnection = {
    newMessageId: () => `OUT-${(sent += 1)}` as WaMessageId,
    sendText: () => Promise.reject(new Error('этап 2 ничего не отправляет')),
    setTyping: () => Promise.reject(new Error('этап 2 ничего не отправляет')),
    markRead: () => Promise.reject(new Error('этап 2 ничего не отмечает')),
    downloadAudio: () => Promise.reject(new Error('этап 7')),
    resolvePhone: () => Promise.resolve(null),
    businessProfile: () => Promise.resolve({ kind: 'failed' }),
    profilePhoto: () => Promise.resolve(null),
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

/** Подменяет только setInterval и clearInterval: база, файлы и логгер работают по-настоящему. */
function useFakeIntervals(): void {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

function rows(dbPath: string, sql: string): unknown[] {
  return readDb(dbPath, (db) => db.prepare(sql).all());
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
      expect.objectContaining({ level: INFO, msg: 'Пропущено с запуска: ничего', ignored: {} }),
    );
    expect(harness.records()).toContainEqual(
      expect.objectContaining({ level: INFO, msg: 'Бот остановлен' }),
    );
    readDb(harness.dbPath, (db) => {
      expect(Number(db.pragma('user_version', { simple: true }))).toBeGreaterThanOrEqual(
        MIN_SCHEMA_VERSION,
      );
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

describe('main: видимость пропусков', () => {
  /** Строки сводки пропусков в логе. */
  function summaries(harness: Harness): LogRecord[] {
    return harness.records().filter((record) => record.msg?.startsWith(SUMMARY_PREFIX) === true);
  }

  it('номер менеджера в TEST_ALLOWLIST: предупреждение при старте, без самого номера', async () => {
    const harness = useHarness();

    await harness.run({ ...DISABLED_ENV, MANAGER_WHATSAPP: CLIENT_PHONE });

    expect(harness.records()).toContainEqual(
      expect.objectContaining({ level: WARN, msg: MANAGER_IN_ALLOWLIST_TEXT }),
    );
    expect(JSON.stringify(harness.records())).not.toContain(CLIENT_PHONE);
  });

  it('номера менеджера нет в списке: предупреждения нет', async () => {
    const harness = useHarness();

    await harness.run({ ...DISABLED_ENV, MANAGER_WHATSAPP: MANAGER_PHONE });

    expect(harness.records().map((record) => record.msg)).not.toContain(MANAGER_IN_ALLOWLIST_TEXT);
  });

  it('сводка при разборе офлайн-очереди и при остановке: только ненулевые причины, без номеров', async () => {
    const harness = useHarness();
    const startWhatsApp = fakeStart(fakeConnection().connection);
    const app = await harness.run(ENABLED_ENV, { startWhatsApp });
    const deps = depsOf(startWhatsApp);
    await deps.onEvent({ type: 'ignore', reason: 'manager' });
    await deps.onEvent(NOT_ALLOWLISTED_EVENT);
    await deps.onEvent(NOT_ALLOWLISTED_EVENT);

    await deps.onOfflineQueueDone();
    await app.stop();

    const summary: unknown = expect.objectContaining({
      level: INFO,
      msg: 'Пропущено с запуска: manager 1, not_allowlisted 2',
      ignored: { manager: 1, not_allowlisted: 2 },
    });
    expect(summaries(harness)).toEqual([summary, summary]);
    expect(harness.records()).toContainEqual(
      expect.objectContaining({ level: INFO, msg: 'Сообщение пропущено: причина manager' }),
    );
    expect(JSON.stringify(harness.records())).not.toContain(STRANGER_PHONE);
  });

  it('раз в 10 минут, только если пропуски изменились; таймер снимается при остановке', async () => {
    useFakeIntervals();
    const harness = useHarness();
    const startWhatsApp = fakeStart(fakeConnection().connection);
    const app = await harness.run(ENABLED_ENV, { startWhatsApp });
    const deps = depsOf(startWhatsApp);

    vi.advanceTimersByTime(SUMMARY_INTERVAL_MS);
    expect(summaries(harness)).toEqual([]);

    await deps.onEvent({ type: 'ignore', reason: 'manager' });
    vi.advanceTimersByTime(SUMMARY_INTERVAL_MS);
    vi.advanceTimersByTime(SUMMARY_INTERVAL_MS);
    await deps.onEvent({ type: 'ignore', reason: 'service' });
    vi.advanceTimersByTime(SUMMARY_INTERVAL_MS);

    expect(summaries(harness).map((record) => record.msg)).toEqual([
      'Пропущено с запуска: manager 1',
      'Пропущено с запуска: manager 1, service 1',
    ]);
    expect(vi.getTimerCount()).toBe(1);
    await app.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('таймер сводки снимается и при отказе запуска', async () => {
    useFakeIntervals();
    const harness = useHarness();

    await expect(
      harness.run(ENABLED_ENV, { startWhatsApp: failingStart(new Error('Сбой открытия сокета')) }),
    ).rejects.toThrow('Сбой открытия сокета');

    expect(vi.getTimerCount()).toBe(0);
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

  it('onEvent и onHistoryChats пишут в базу; onOfflineQueueDone закрывает отметку чата, где уже есть свежее сообщение', async () => {
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
    // На чат отвечает обычный порядок: в список менеджеру он не входит, отметка закрыта без уведомления.
    expect(count(harness.dbPath, 'manager_notifications')).toBe(0);
    expect(
      rows(harness.dbPath, 'SELECT notified_at_ms IS NOT NULL AS notified FROM backlog_chats'),
    ).toEqual([{ notified: 1 }]);
    expect(harness.records()).toContainEqual(
      expect.objectContaining({
        level: INFO,
        count: 1,
        msg: expect.stringContaining('в работе') as unknown,
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

describe('main: ответы клиентам, службы этапа 5 и веб-панель', () => {
  const KEY = 'sk-test-not-a-real-key';
  const OPENROUTER_KEY = 'or-test-not-a-real-key';
  const KEY_ENV: EnvInput = { ...ENABLED_ENV, VENMART_ANTHROPIC_KEY: KEY };
  const NO_KEY_TEXT =
    'Ключ Claude не задан (VENMART_ANTHROPIC_KEY): бот только принимает и сохраняет сообщения, ответов нет';
  /** Паузы склейки и «печатает» без ожидания: время настоящее, паузы мгновенные. */
  const IMMEDIATE_CLOCK: Clock = { now: () => Date.now(), sleep: () => Promise.resolve() };
  const UNAVAILABLE: LlmResult<never> = { ok: false, failure: 'unavailable' };
  const OWN_EVENT: WaEvent = {
    type: 'own',
    message: {
      waId: 'PHONE-1' as WaMessageId,
      chatJid: CLIENT_JID,
      content: { kind: 'text', text: 'Добрый день, это менеджер Tanbala' },
      tsMs: Date.UTC(2026, 9, 25, 9, 1, 0),
    },
  };

  /** Подключение, которое «отправляет»: шлюз конвейера и outbox доходят до него. */
  function sendingConnection(): {
    readonly connection: WhatsAppConnection;
    readonly sendText: Mock<WhatsAppConnection['sendText']>;
    readonly markRead: Mock<WhatsAppConnection['markRead']>;
    readonly setTyping: Mock<WhatsAppConnection['setTyping']>;
    readonly stop: Mock<() => Promise<void>>;
  } {
    const sendText = vi.fn<WhatsAppConnection['sendText']>(() => Promise.resolve());
    const markRead = vi.fn<WhatsAppConnection['markRead']>(() => Promise.resolve());
    const setTyping = vi.fn<WhatsAppConnection['setTyping']>(() => Promise.resolve());
    const stop = vi.fn(() => Promise.resolve());
    const connection: WhatsAppConnection = {
      ...fakeConnection().connection,
      sendText,
      setTyping,
      markRead,
      stop,
    };
    return { connection, sendText, markRead, setTyping, stop };
  }

  function writeKnowledge(root: string): void {
    mkdirSync(join(root, 'knowledge'));
    writeFileSync(join(root, 'knowledge', 'tanbala-agent.md'), 'Учёт вещей на RFID-метках.');
    writeFileSync(join(root, 'knowledge', 'whatsapp.md'), 'Отвечай коротко.');
  }

  function llmOf(structured: () => Promise<LlmResult<never>>): () => LlmClient {
    return () => ({ structured });
  }

  function chatRow(dbPath: string): unknown {
    return readDb(dbPath, (db) =>
      db.prepare('SELECT status, status_by AS statusBy FROM chats').get(),
    );
  }

  async function nextTurn(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  it('без ключа Claude: предупреждение, входящие сохраняются, ответа нет', async () => {
    const harness = useHarness();
    const { connection, sendText } = sendingConnection();
    const startWhatsApp = fakeStart(connection);
    await harness.run(ENABLED_ENV, { startWhatsApp, clock: IMMEDIATE_CLOCK });

    await depsOf(startWhatsApp).onEvent(CLIENT_EVENT);
    await nextTurn();

    expect(harness.records()).toContainEqual(
      expect.objectContaining({ level: WARN, msg: NO_KEY_TEXT }),
    );
    expect(count(harness.dbPath, 'messages')).toBe(1);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('человек написал с телефона: сообщение в истории, чат переходит к нему, бот молчит', async () => {
    const harness = useHarness();
    const startWhatsApp = fakeStart(fakeConnection().connection);
    await harness.run(ENABLED_ENV, { startWhatsApp });
    const deps = depsOf(startWhatsApp);

    await deps.onEvent(CLIENT_EVENT);
    await deps.onEvent(OWN_EVENT);

    expect(chatRow(harness.dbPath)).toEqual({ status: 'manager', statusBy: 'phone' });
    expect(count(harness.dbPath, 'messages')).toBe(2);
    expect(rows(harness.dbPath, 'SELECT reason, resolved_at_ms AS resolved FROM handoffs')).toEqual(
      [{ reason: 'human_took_over', resolved: null }],
    );
    expect(count(harness.dbPath, 'manager_notifications')).toBe(0);
    expect(harness.records()).toContainEqual(
      expect.objectContaining({ level: INFO, result: 'human_took_over' }),
    );
    expect(JSON.stringify(harness.records())).not.toContain('это менеджер');
  });

  it('с ключом: пачка в конвейер, сбой LLM => чат менеджеру и фраза через шлюз; getSentText из outbound_ids', async () => {
    const harness = useHarness();
    writeKnowledge(harness.root);
    const { connection, sendText } = sendingConnection();
    const startWhatsApp = fakeStart(connection);
    await harness.run(KEY_ENV, {
      startWhatsApp,
      clock: IMMEDIATE_CLOCK,
      createLlm: llmOf(() => Promise.resolve(UNAVAILABLE)),
    });
    const deps = depsOf(startWhatsApp);

    await deps.onEvent(CLIENT_EVENT);
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));

    const [jid, text, waId] = sendText.mock.calls[0] ?? [];
    expect([jid, waId]).toEqual([CLIENT_JID, 'OUT-1']);
    expect(text).toBe('Уточню у коллеги и вернусь к вам.');
    expect(chatRow(harness.dbPath)).toEqual({ status: 'manager', statusBy: 'bot' });
    // Номера менеджера нет: уведомление остаётся в панели со статусом no_manager, в лог строка без текста клиента.
    await vi.waitFor(() => expect(count(harness.dbPath, 'manager_notifications')).toBe(1));
    expect(
      rows(harness.dbPath, 'SELECT kind, status, attempts FROM manager_notifications'),
    ).toEqual([{ kind: 'handoff', status: 'no_manager', attempts: 1 }]);
    expect(rows(harness.dbPath, 'SELECT reason FROM handoffs')).toEqual([{ reason: 'llm_error' }]);
    await expect(deps.getSentText('OUT-1' as WaMessageId, CLIENT_JID)).resolves.toBe(text);
    await expect(deps.getSentText('OUT-1' as WaMessageId, STRANGER_JID)).resolves.toBeNull();
    expect(harness.records()).toContainEqual(
      expect.objectContaining({ level: INFO, voice: false }),
    );
    expect(JSON.stringify(harness.records())).not.toContain(KEY);
  });

  it('с ключом: ответ клиенту с прочтением и «печатает»; эхо своей отправки не забирает чат', async () => {
    const harness = useHarness();
    writeKnowledge(harness.root);
    const { connection, sendText, markRead, setTyping } = sendingConnection();
    const startWhatsApp = fakeStart(connection);
    const reply = 'Расскажите, пожалуйста, что вы храните?';
    // Ответы модели по назначению вызова в форме схем агента: значение проходит через те же схемы, что и настоящее.
    const { llm, purposes } = scriptedLlm({ replies: [reply] });
    await harness.run(
      { ...KEY_ENV, MANAGER_WHATSAPP: MANAGER_PHONE },
      { startWhatsApp, clock: IMMEDIATE_CLOCK, createLlm: () => llm },
    );
    const deps = depsOf(startWhatsApp);

    await deps.onEvent(CLIENT_EVENT);
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
    await deps.onEvent({
      type: 'own',
      message: { ...OWN_EVENT.message, waId: 'OUT-1' as WaMessageId },
    });

    expect(sendText).toHaveBeenCalledWith(CLIENT_JID, reply, 'OUT-1');
    expect(markRead).toHaveBeenCalledWith(CLIENT_JID, ['WA-1']);
    expect(setTyping.mock.calls).toEqual([
      [CLIENT_JID, true],
      [CLIENT_JID, false],
    ]);
    expect(chatRow(harness.dbPath)).toEqual({ status: 'bot', statusBy: null });
    expect(count(harness.dbPath, 'messages')).toBe(2);
    expect(purposes().sort()).toEqual(['interest', 'reply', 'review']);
  });

  it('повтор того же сообщения не запускает второй ответ', async () => {
    const harness = useHarness();
    writeKnowledge(harness.root);
    const structured = vi.fn(() => Promise.resolve(UNAVAILABLE));
    const startWhatsApp = fakeStart(sendingConnection().connection);
    await harness.run(KEY_ENV, {
      startWhatsApp,
      clock: IMMEDIATE_CLOCK,
      createLlm: () => ({ structured }),
    });
    const deps = depsOf(startWhatsApp);

    await deps.onEvent(CLIENT_EVENT);
    // Черновик и оценка интереса идут параллельно: два вызова на одну пачку.
    await vi.waitFor(() => expect(structured).toHaveBeenCalledTimes(2));
    await deps.onEvent(CLIENT_EVENT);
    await nextTurn();

    expect(structured).toHaveBeenCalledTimes(2);
  });

  it('stop дожидается пачки: ответ уходит до остановки WhatsApp и закрытия базы', async () => {
    const harness = useHarness();
    writeKnowledge(harness.root);
    const releases: ((value: LlmResult<never>) => void)[] = [];
    const structured = vi.fn(
      () =>
        new Promise<LlmResult<never>>((resolve) => {
          releases.push(resolve);
        }),
    );
    const { connection, sendText, stop } = sendingConnection();
    const startWhatsApp = fakeStart(connection);
    const app = await harness.run(KEY_ENV, {
      startWhatsApp,
      clock: IMMEDIATE_CLOCK,
      createLlm: () => ({ structured }),
    });
    await depsOf(startWhatsApp).onEvent(CLIENT_EVENT);
    await vi.waitFor(() => expect(structured).toHaveBeenCalled());

    const stopping = app.stop();
    await nextTurn();
    expect(stop).not.toHaveBeenCalled();
    for (const release of releases) release(UNAVAILABLE);
    await stopping;

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.invocationCallOrder[0]).toBeLessThan(
      stop.mock.invocationCallOrder[0] ?? 0,
    );
    expect(databaseOpen(harness.dbPath)).toBe(false);
  });

  describe('веб-панель (этап 6)', () => {
    const PORT = '3187';
    const HOST_HEADER = `127.0.0.1:${PORT}`;
    const ORIGIN = `http://${HOST_HEADER}`;
    const STRONG_PASSWORD = 'correct-horse-battery-staple';
    const WEAK_PASSWORD = 'short-pass';
    const FORM = 'application/x-www-form-urlencoded';

    /** Шов запуска панели: запоминает собранную панель и параметры, порт не занимает. */
    function recordingPanel(onBuilt: (app: PanelApp) => void = () => undefined): {
      readonly startPanel: Mock<PanelStarter>;
      app(): PanelApp;
    } {
      let built: PanelApp | null = null;
      const startPanel = vi.fn<PanelStarter>((app) => {
        built = app;
        onBuilt(app);
        return Promise.resolve();
      });
      return {
        startPanel,
        app: () => {
          if (built === null) throw new Error('Панель не запускалась');
          return built;
        },
      };
    }

    function sessionCookie(setCookie: string | string[] | number | undefined): string {
      const lines = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
      const line = lines.find((value) => value.startsWith('tanbala_sid='));
      return line?.split(';')[0] ?? '';
    }

    async function signIn(app: PanelApp, password: string): Promise<string> {
      const response = await app.inject({
        method: 'POST',
        url: '/login',
        headers: { host: HOST_HEADER, origin: ORIGIN, 'content-type': FORM },
        payload: new URLSearchParams({ password }).toString(),
      });
      return sessionCookie(response.headers['set-cookie']);
    }

    function formPost(app: PanelApp, url: string, cookie: string, fields: Record<string, string>) {
      return app.inject({
        method: 'POST',
        url,
        headers: { host: HOST_HEADER, origin: ORIGIN, cookie, 'content-type': FORM },
        payload: new URLSearchParams(fields).toString(),
      });
    }

    it.each([
      ['выключен', DISABLED_ENV],
      ['включён', ENABLED_ENV],
    ])(
      'WhatsApp %s: панель слушает PANEL_HOST и PANEL_PORT, пароль из настроек',
      async (_c, env) => {
        const harness = useHarness();
        const { startPanel } = recordingPanel();
        const startWhatsApp = fakeStart(fakeConnection().connection);

        await harness.run({ ...env, PANEL_PORT: PORT }, { startPanel, startWhatsApp });

        expect(startPanel).toHaveBeenCalledTimes(1);
        expect(startPanel).toHaveBeenCalledWith(expect.anything(), {
          host: '127.0.0.1',
          port: Number(PORT),
          password: 'admin',
        });
        expect(harness.records()).toContainEqual(
          expect.objectContaining({ level: INFO, msg: `Веб-панель запущена: 127.0.0.1:${PORT}` }),
        );
      },
    );

    it('панель начинает слушать после старта WhatsApp', async () => {
      const harness = useHarness();
      const { startPanel } = recordingPanel();
      const startWhatsApp = fakeStart(fakeConnection().connection);

      await harness.run(ENABLED_ENV, { startPanel, startWhatsApp });

      expect(startWhatsApp.mock.invocationCallOrder[0]).toBeLessThan(
        startPanel.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it('слабый пароль не на 127.0.0.1: остановка сразу после настроек, до замка, базы, WhatsApp и QR; пароля в логе нет', async () => {
      const harness = useHarness();
      const { startPanel } = recordingPanel();
      const startWhatsApp = fakeStart(fakeConnection().connection);
      const env = { ...ENABLED_ENV, PANEL_HOST: '0.0.0.0', ADMIN_PASSWORD: WEAK_PASSWORD };

      const error = await errorOf(harness.run(env, { startPanel, startWhatsApp }));

      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('PANEL_HOST');
      expect(startWhatsApp).not.toHaveBeenCalled();
      expect(startPanel).not.toHaveBeenCalled();
      expect(existsSync(harness.dbPath)).toBe(false);
      expect(existsSync(harness.lockPath)).toBe(false);
      expect(harness.records()).toContainEqual(
        expect.objectContaining({ level: ERROR, msg: (error as SafeError).message }),
      );
      expect(JSON.stringify(harness.records())).not.toContain(WEAK_PASSWORD);
    });

    it('сильный пароль: на чужом адресе панель запускается, пароля в логе нет', async () => {
      const harness = useHarness();
      const { startPanel } = recordingPanel();
      const env = { ...DISABLED_ENV, PANEL_HOST: '0.0.0.0', ADMIN_PASSWORD: STRONG_PASSWORD };

      await harness.run(env, { startPanel });

      expect(startPanel).toHaveBeenCalledWith(expect.anything(), {
        host: '0.0.0.0',
        port: 3100,
        password: STRONG_PASSWORD,
      });
      expect(JSON.stringify(harness.records())).not.toContain(STRONG_PASSWORD);
    });

    it('панель собрана на настройках: пароль входа, порт и домены за Caddy', async () => {
      const harness = useHarness();
      const panel = recordingPanel();
      const env = {
        ...DISABLED_ENV,
        PANEL_PORT: PORT,
        ADMIN_PASSWORD: STRONG_PASSWORD,
        PANEL_ALLOWED_HOSTS: 'panel.example.kz',
      };
      await harness.run(env, { startPanel: panel.startPanel });
      const app = panel.app();
      const page = (host: string, headers: Record<string, string> = {}) =>
        app.inject({ url: '/login', headers: { host, ...headers } });
      const viaCaddy = { 'x-forwarded-proto': 'https' };

      expect((await page(HOST_HEADER)).statusCode).toBe(200);
      expect((await page('panel.example.kz', viaCaddy)).statusCode).toBe(200);
      // На VPS только HTTPS: домен по обычному HTTP закрыт, как и чужой домен.
      expect((await page('panel.example.kz')).statusCode).toBe(403);
      expect((await page('evil.example', viaCaddy)).statusCode).toBe(403);
      expect((await signIn(app, 'неверный-пароль-123')).length).toBe(0);
      expect((await signIn(app, STRONG_PASSWORD)).startsWith('tanbala_sid=')).toBe(true);
    });

    it('ответ из панели и возврат боту идут через общие службы и подключение WhatsApp', async () => {
      const harness = useHarness();
      const panel = recordingPanel();
      const { connection, sendText } = sendingConnection();
      const startWhatsApp = fakeStart(connection);
      await harness.run(
        { ...ENABLED_ENV, PANEL_PORT: PORT },
        { startPanel: panel.startPanel, startWhatsApp },
      );
      await depsOf(startWhatsApp).onEvent(CLIENT_EVENT);
      const app = panel.app();
      const cookie = await signIn(app, 'admin');
      const csrf = /name="csrf" value="([^"]+)"/.exec(
        (await app.inject({ url: '/chats/1', headers: { host: HOST_HEADER, cookie } })).body,
      )?.[1];
      if (csrf === undefined) throw new Error('В странице нет токена CSRF');
      const text = 'Добрый день, это менеджер из панели';

      const reply = await formPost(app, '/chats/1/reply', cookie, { csrf, text });

      expect(reply.statusCode).toBe(303);
      expect(sendText).toHaveBeenCalledWith(CLIENT_JID, text, 'OUT-1');
      expect(chatRow(harness.dbPath)).toEqual({ status: 'manager', statusBy: 'panel' });
      expect(
        rows(harness.dbPath, 'SELECT reason FROM handoffs WHERE resolved_at_ms IS NULL'),
      ).toEqual([{ reason: 'human_took_over' }]);

      const returned = await formPost(app, '/chats/1/return', cookie, { csrf });

      expect(returned.statusCode).toBe(303);
      expect(chatRow(harness.dbPath)).toEqual({ status: 'bot', statusBy: 'panel' });
      expect(
        rows(harness.dbPath, 'SELECT reason FROM handoffs WHERE resolved_at_ms IS NULL'),
      ).toEqual([]);
      const logged = JSON.stringify(harness.records());
      expect(logged).not.toContain(text);
      expect(logged).not.toContain('"admin"');
    });

    it('возврат боту из панели: бот отвечает на сообщение, пришедшее, пока чат вёл менеджер', async () => {
      const harness = useHarness();
      writeKnowledge(harness.root);
      const panel = recordingPanel();
      const { connection, sendText } = sendingConnection();
      const startWhatsApp = fakeStart(connection);
      const answer = 'Расскажите, пожалуйста, что вы храните?';
      const { llm } = scriptedLlm({ replies: [answer] });
      await harness.run(
        { ...KEY_ENV, PANEL_PORT: PORT },
        {
          startPanel: panel.startPanel,
          startWhatsApp,
          clock: IMMEDIATE_CLOCK,
          createLlm: () => llm,
        },
      );
      const deps = depsOf(startWhatsApp);
      const clientEvent = (waId: string, text: string): WaEvent => ({
        type: 'client',
        message: {
          ...CLIENT_EVENT.message,
          waId: waId as WaMessageId,
          content: { kind: 'text', text },
          tsMs: Date.now(),
        },
      });
      const app = panel.app();
      const cookie = await signIn(app, 'admin');
      await deps.onEvent(clientEvent('WA-1', 'Здравствуйте'));
      await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
      const csrf = /name="csrf" value="([^"]+)"/.exec(
        (await app.inject({ url: '/chats/1', headers: { host: HOST_HEADER, cookie } })).body,
      )?.[1];
      if (csrf === undefined) throw new Error('В странице нет токена CSRF');
      await formPost(app, '/chats/1/reply', cookie, { csrf, text: 'Добрый день, это менеджер' });
      await deps.onEvent(clientEvent('WA-2', 'А с 1С работаете?'));

      const returned = await formPost(app, '/chats/1/return', cookie, { csrf });

      expect(returned.headers['location']).toBe('/chats/1?notice=returned_answering');
      await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(3));
      expect(sendText.mock.calls.map(([jid, text]) => [jid, text])).toEqual([
        [CLIENT_JID, answer],
        [CLIENT_JID, 'Добрый день, это менеджер'],
        [CLIENT_JID, answer],
      ]);
      expect(chatRow(harness.dbPath)).toEqual({ status: 'bot', statusBy: 'panel' });
    });

    it('остановка закрывает панель первой: до остановки WhatsApp и до закрытия базы', async () => {
      const harness = useHarness();
      const events: string[] = [];
      const dbState = (): string =>
        databaseOpen(harness.dbPath) ? 'база открыта' : 'база закрыта';
      const panel = recordingPanel((app) => {
        app.addHook('onClose', () => {
          events.push(`панель: ${dbState()}`);
          return Promise.resolve();
        });
      });
      const { connection } = sendingConnection();
      const startWhatsApp = fakeStart({
        ...connection,
        stop: () => {
          events.push(`WhatsApp: ${dbState()}`);
          return Promise.resolve();
        },
      });
      const app = await harness.run(ENABLED_ENV, { startPanel: panel.startPanel, startWhatsApp });

      await app.stop();

      expect(events).toEqual(['панель: база открыта', 'WhatsApp: база открыта']);
      expect(databaseOpen(harness.dbPath)).toBe(false);
    });

    it('панель не запустилась (порт занят): остановка целиком, WhatsApp остановлен, ошибка всплывает', async () => {
      const harness = useHarness();
      const failure = new Error('listen EADDRINUSE');
      const startPanel = vi.fn<PanelStarter>(() => Promise.reject(failure));
      const { connection, stop } = sendingConnection();

      const error = await errorOf(
        harness.run(ENABLED_ENV, { startPanel, startWhatsApp: fakeStart(connection) }),
      );

      expect(error).toBe(failure);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(databaseOpen(harness.dbPath)).toBe(false);
      expect(lockFree(harness.lockPath)).toBe(true);
      expect(harness.records()).toContainEqual(
        expect.objectContaining({ level: ERROR, msg: 'Бот не запущен' }),
      );
    });
  });

  describe('службы этапа 5: повтор уведомлений и список простоя', () => {
    const MANAGER_ENV: EnvInput = { ...ENABLED_ENV, MANAGER_WHATSAPP: MANAGER_PHONE };

    function notifications(dbPath: string): unknown[] {
      return rows(dbPath, 'SELECT kind, status, attempts FROM manager_notifications ORDER BY id');
    }

    it('после офлайн-очереди менеджеру уходит одно уведомление со списком простоя (и без ключа Claude); повтор не дублирует', async () => {
      const harness = useHarness();
      const { connection, sendText } = sendingConnection();
      const startWhatsApp = fakeStart(connection);
      await harness.run(MANAGER_ENV, { startWhatsApp });
      const deps = depsOf(startWhatsApp);
      await deps.onEvent(STALE_EVENT);

      await deps.onOfflineQueueDone();
      await deps.onOfflineQueueDone();

      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith(MANAGER_JID, expect.any(String), 'OUT-1');
      expect(notifications(harness.dbPath)).toEqual([
        { kind: 'backlog', status: 'sent', attempts: 1 },
      ]);
      expect(
        rows(harness.dbPath, 'SELECT notified_at_ms IS NOT NULL AS notified FROM backlog_chats'),
      ).toEqual([{ notified: 1 }]);
    });

    it('номера менеджера нет: список простоя остаётся в панели со статусом no_manager, отправки нет', async () => {
      const harness = useHarness();
      const { connection, sendText } = sendingConnection();
      const startWhatsApp = fakeStart(connection);
      await harness.run(ENABLED_ENV, { startWhatsApp });
      const deps = depsOf(startWhatsApp);
      await deps.onEvent(STALE_EVENT);

      await deps.onOfflineQueueDone();

      expect(sendText).not.toHaveBeenCalled();
      expect(notifications(harness.dbPath)).toEqual([
        { kind: 'backlog', status: 'no_manager', attempts: 1 },
      ]);
      expect(JSON.stringify(harness.records())).not.toContain(CLIENT_PHONE);
    });

    it('таймер повтора: с первого открытия подключения, раз в 5 минут; неотправленное уходит, остановка снимает таймер', async () => {
      useFakeIntervals();
      const harness = useHarness();
      const { connection, sendText } = sendingConnection();
      const startWhatsApp = fakeStart(connection);
      const app = await harness.run(MANAGER_ENV, { startWhatsApp });
      const deps = depsOf(startWhatsApp);
      await deps.onEvent(STALE_EVENT);
      // Пока подключение не открывалось, живёт только таймер сводки пропусков.
      expect(vi.getTimerCount()).toBe(1);
      sendText.mockRejectedValueOnce(new Error('Connection Closed'));

      await deps.onOfflineQueueDone();

      expect(vi.getTimerCount()).toBe(2);
      expect(notifications(harness.dbPath)).toEqual([
        { kind: 'backlog', status: 'failed', attempts: 1 },
      ]);
      await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS - 1);
      expect(sendText).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await nextTurn();

      expect(sendText).toHaveBeenCalledTimes(2);
      expect(notifications(harness.dbPath)).toEqual([
        { kind: 'backlog', status: 'sent', attempts: 2 },
      ]);
      await app.stop();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('остановка снимает таймер повтора до остановки WhatsApp и до закрытия базы', async () => {
      useFakeIntervals();
      const harness = useHarness();
      let timersWhenWhatsAppStops = -1;
      const { connection } = sendingConnection();
      const stoppable: WhatsAppConnection = {
        ...connection,
        stop: () => {
          timersWhenWhatsAppStops = vi.getTimerCount();
          return Promise.resolve();
        },
      };
      const startWhatsApp = fakeStart(stoppable);
      const app = await harness.run(MANAGER_ENV, { startWhatsApp });
      await depsOf(startWhatsApp).onOfflineQueueDone();
      expect(vi.getTimerCount()).toBe(2);

      await app.stop();

      // К остановке WhatsApp остаётся только таймер сводки: повтор уже снят.
      expect(timersWhenWhatsAppStops).toBe(1);
      expect(databaseOpen(harness.dbPath)).toBe(false);
      await depsOf(startWhatsApp).onOfflineQueueDone();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('ключ OpenRouter задан: расшифровка голосовых включена, ключи в лог не попадают', async () => {
    const harness = useHarness();
    writeKnowledge(harness.root);

    await harness.run(
      { ...KEY_ENV, WA_ENABLED: 'false', OPENROUTER_API_KEY: OPENROUTER_KEY },
      { createLlm: llmOf(() => Promise.resolve(UNAVAILABLE)) },
    );

    expect(harness.records()).toContainEqual(expect.objectContaining({ level: INFO, voice: true }));
    const logged = JSON.stringify(harness.records());
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(OPENROUTER_KEY);
  });

  it('с ключом, но без файлов знаний: запуск отклонён понятной ошибкой, база закрыта, замок снят', async () => {
    const harness = useHarness();

    const error = await errorOf(harness.run(KEY_ENV));

    expect(error).toBeInstanceOf(SafeError);
    expect(harness.records()).toContainEqual(
      expect.objectContaining({ level: ERROR, msg: (error as SafeError).message }),
    );
    expect(databaseOpen(harness.dbPath)).toBe(false);
    expect(lockFree(harness.lockPath)).toBe(true);
  });

  describe('определение компании клиента', () => {
    const TOKEN = 'internal-token-0123456789-0123456789-abcdef';
    const ENABLED_TEXT = 'Определение компании клиента включено: внутренний API почтового проекта';
    const DISABLED_TEXT = 'Определение компании клиента выключено: INTERNAL_API_TOKEN не задан';
    const PHOTO: ImageInput = { data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' };

    /** Внутренний API почтового проекта отвечает «никого не нашли»; сеть по-прежнему закрыта. */
    function stubCompanyApi(): Mock<typeof fetch> {
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(JSON.stringify({ candidates: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );
      vi.stubGlobal('fetch', fetchMock);
      onTestFinished(() => {
        vi.unstubAllGlobals();
      });
      return fetchMock;
    }

    it('без INTERNAL_API_TOKEN: при старте одна строка «выключено»', async () => {
      const harness = useHarness();

      await harness.run(DISABLED_ENV);

      const lines = harness.records().filter((record) => 'companyApi' in record);
      expect(lines).toEqual([
        expect.objectContaining({ level: INFO, companyApi: false, msg: DISABLED_TEXT }),
      ]);
    });

    it('с токеном: строка «включено» без адреса и токена; профиль из подключения, поиск в API, логотип через агента', async () => {
      const harness = useHarness();
      writeKnowledge(harness.root);
      const fetchMock = stubCompanyApi();
      const businessProfile = vi.fn<WhatsAppConnection['businessProfile']>(() =>
        Promise.resolve({ kind: 'business', websites: [], email: null }),
      );
      const profilePhoto = vi.fn<WhatsAppConnection['profilePhoto']>(() => Promise.resolve(PHOTO));
      const { connection, sendText } = sendingConnection();
      const startWhatsApp = fakeStart({ ...connection, businessProfile, profilePhoto });
      const { llm, purposes } = scriptedLlm({
        replies: ['Расскажите, пожалуйста, что вы храните?'],
      });
      await harness.run(
        { ...KEY_ENV, INTERNAL_API_TOKEN: TOKEN },
        { startWhatsApp, clock: IMMEDIATE_CLOCK, createLlm: () => llm },
      );

      await depsOf(startWhatsApp).onEvent(CLIENT_EVENT);
      // После ответа: шаг д (логотип) у бизнес-аккаунта, у которого бесплатные шаги ничего не нашли.
      await vi.waitFor(() => expect(purposes()).toContain('logo'));

      expect(sendText).toHaveBeenCalledTimes(1);
      expect(businessProfile).toHaveBeenCalledWith(CLIENT_JID);
      expect(profilePhoto).toHaveBeenCalledWith(CLIENT_JID, expect.any(Number));
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe(`http://127.0.0.1:8000/internal/lookup?phone=${CLIENT_PHONE}`);
      expect(new Headers(init?.headers).get('X-Internal-Token')).toBe(TOKEN);
      const lines = harness.records().filter((record) => 'companyApi' in record);
      expect(lines).toEqual([
        expect.objectContaining({ level: INFO, companyApi: true, msg: ENABLED_TEXT }),
      ]);
      expect(JSON.stringify(lines)).not.toMatch(/127\.0\.0\.1|:8000/);
      expect(JSON.stringify(harness.records())).not.toContain(TOKEN);
    });
  });
});
