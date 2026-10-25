import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type AppConfig, type TestMode } from './config/env.js';
import { ConfigError } from './config/errors.js';
import { createUnitOfWork, openDatabase } from './db/connection.js';
import { runMigrations } from './db/migrations.js';
import { acquireProcessLock } from './db/process-lock.js';
import { createAppStateRepo } from './db/repos/app-state.js';
import { createBacklogRepo } from './db/repos/backlog.js';
import { createChatsRepo } from './db/repos/chats.js';
import { createKnownChatsRepo } from './db/repos/known-chats.js';
import { createMessagesRepo } from './db/repos/messages.js';
import { createPairingGuard } from './db/repos/pairing-attempts.js';
import type {
  AppStateRepo,
  BacklogRepo,
  Clock,
  Logger,
  PairingGuard,
  ProcessLock,
} from './domain/ports.js';
import type { PhoneDigits } from './domain/types.js';
import { createInboundRecorder, type InboundRecorder } from './pipeline/recorder.js';
import { createSystemClock } from './shared/clock.js';
import { createLogger, type LogDestination } from './shared/logger.js';
import { SafeError } from './shared/safe-error.js';
import {
  PairingLimitError,
  startWhatsApp,
  type WhatsAppConnection,
  type WhatsAppDeps,
  type WhatsAppStopReason,
} from './whatsapp/connection.js';
import { createQrPresenter } from './whatsapp/qr.js';

/** Что точка входа передаёт в main. */
export interface MainOptions {
  /** Переменные окружения после загрузки .env. Разбирает их только config/env.ts. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Абсолютный путь к корню проекта: от него считаются пути из .env. */
  readonly root: string;
  /** Шов для тестов, в рабочем режиме не передаётся: подключение к WhatsApp (по умолчанию startWhatsApp). */
  readonly startWhatsApp?: (deps: WhatsAppDeps) => Promise<WhatsAppConnection>;
  /** Шов для тестов, в рабочем режиме не передаётся: приёмник строк лога (по умолчанию stdout). */
  readonly logDestination?: LogDestination;
}

/** Запущенное приложение. */
export interface RunningApp {
  /**
   * Корректная остановка: WhatsApp, база, замок процесса (очередь сообщений с этапа 3, панель с этапа 6).
   * Повторный вызов отдаёт тот же промис.
   */
  stop(): Promise<void>;
}

/** Уровень лога приложения; у Baileys свой уровень warn (whatsapp/connection.ts). */
const LOG_LEVEL = 'info';
/** Модели LLM: файл в корне проекта, меняется без правки кода. */
const MODELS_FILE = 'config/models.json';
/** Замок «бот уже запущен» в папке данных (все пути данных обязаны лежать в data/): один на корень проекта. */
const PROCESS_LOCK_FILE = join('data', 'process.lock');
/** Картинка QR привязки: внутри data/ и под qr*.png в .gitignore. */
const QR_PNG_FILE = join('data', 'qr.png');
/** Метка порядка байтов UTF-8: её ставит Блокнот Windows, а JSON.parse на ней падает. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
/** Весь Казахстан с 01.03.2024 живёт по UTC+5 без летнего времени: смещение Алматы постоянное. */
const ALMATY_OFFSET_MS = 5 * MS_PER_HOUR;

/** Что владелец читает в логе, когда WhatsApp остановился сам (WhatsAppDeps.onStopped). */
const STOP_MESSAGES: Readonly<Record<WhatsAppStopReason, string>> = {
  logged_out:
    'WhatsApp остановлен: сессия отозвана в телефоне (устройство отвязано), нужна новая привязка по QR. ' +
    'Удалите папку сессии (WHATSAPP_SESSION_DIR, по умолчанию data/whatsapp-session) и запустите бота снова',
  pairing_timeout:
    'WhatsApp остановлен: привязка не завершена, QR не отсканирован вовремя или связь оборвалась при привязке. ' +
    'Попытка засчитана (не больше двух за 24 часа): запустите бота снова вручную, когда будете готовы сканировать QR',
  replaced:
    'WhatsApp остановлен: номер подключён в другом месте с этой же сессией (например, запущен второй экземпляр бота). ' +
    'Остановите лишний экземпляр и запустите бота снова',
  forbidden:
    'WhatsApp остановлен: сервер отказал в доступе (код 403), возможна блокировка номера. ' +
    'Проверьте номер в телефоне; сам бот не переподключается',
  gave_up:
    'WhatsApp остановлен: переподключиться не удалось после нескольких попыток. ' +
    'Проверьте интернет и запустите бота снова',
  reconnect_failed:
    'WhatsApp остановлен: сбой при переподключении (подробности выше в логе). Запустите бота снова',
  version_rejected:
    'WhatsApp остановлен: сервер WhatsApp отклонил версию клиента (код 405). ' +
    'Нужно обновить Baileys отдельным коммитом после проверки: передайте разработчику, затем запустите бота снова',
  session_save_failed:
    'WhatsApp остановлен: сессия не сохранилась на диск, переподключение прочитало бы устаревшую. ' +
    'Проверьте свободное место и права на папку сессии (WHATSAPP_SESSION_DIR) и запустите бота снова',
  link_save_failed:
    'WhatsApp остановлен: номер привязан, но момент привязки не записался в базу. Проверьте место на диске ' +
    'и доступ к папке data/, затем удалите папку сессии (WHATSAPP_SESSION_DIR) и привяжите номер заново',
  handler_failed:
    'WhatsApp остановлен: несколько сбоев подряд при разборе или записи сообщений (подробности выше в логе). ' +
    'Проверьте базу и место на диске, затем запустите бота снова',
};

type Database = ReturnType<typeof openDatabase>;

/** База и всё, что на ней собрано для этапа 2. */
interface Storage {
  readonly appState: AppStateRepo;
  readonly pairingGuard: PairingGuard;
  readonly backlog: BacklogRepo;
  readonly recorder: InboundRecorder;
  isOpen(): boolean;
  /** Закрывает базу; повторный вызов ничего не делает. */
  close(): void;
}

/** Всё, что собрано до подключения к WhatsApp. */
interface AppContext {
  readonly config: AppConfig;
  readonly root: string;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly storage: Storage;
}

/** Подключение к WhatsApp этого запуска: меняется только в main. */
interface WhatsAppLink {
  connection: WhatsAppConnection | null;
  /** Остановилось само (onStopped): сокет уже закрыт, stop() его не трогает. */
  stoppedBySelf: boolean;
}

/** Тот же отказ PairingLimitError, но текст для владельца: время следующей попытки по Алматы. */
class PairingLimitExplained extends PairingLimitError {
  constructor(retryAtMs: number) {
    super(retryAtMs);
    this.message = pairingLimitText(retryAtMs);
  }
}

/**
 * Собирает и запускает приложение: здесь создаются все зависимости (composition root).
 * Порядок этапа 2: логгер, loadConfig (переменные и config/models.json, предупреждения в лог), сводка настроек
 * в лог (без номеров), замок процесса data/process.lock (второй экземпляр падает ProcessLockBusyError до базы
 * и WhatsApp), база и миграции, репозитории и запись входящих (pipeline/recorder.ts), затем WhatsApp: onEvent
 * готов до первого события. WA_ENABLED=false: к WhatsApp не подключаться и QR не показывать, только предупреждение.
 * В whatsapp/connection.ts уходят: состояние приложения (граница привязки, отметка неполной истории), PairingGuard
 * (не больше двух привязок по QR за 24 часа, копия счётчика .pairing-attempts.json в корне проекта), список
 * закрытого режима, порог простоя в мс и показ QR в терминал и в data/qr.png. WhatsApp остановился сам =>
 * понятный лог владельцу и та же остановка, что у stop().
 * Ошибка запуска: SafeError (ConfigError, ProcessLockBusyError, LinkBoundaryMissingError, PairingLimitError
 * со временем следующей попытки по Алматы) пишется в лог своим текстом, прочие без текста в сообщении; база
 * закрывается, замок снимается, ошибка всплывает в cli.ts.
 * stop: WhatsApp (он дожидается своей очереди событий, паузы прерывает AbortSignal), база, затем замок.
 * TODO(этап 3): знания, LLM и конвейер собрать после базы и до WhatsApp: события client в pipeline/batcher.ts, own в pipeline/takeover.ts вместо простой записи pipeline/recorder.ts.
 * TODO(этап 3): если ключ Claude пуст, LLM не создавать: вызовов API нет, агент отвечает LlmResult 'disabled', чаты отмечаются для менеджера.
 * TODO(этап 8): переход TEST_MODE true => false: записать момент перехода в app_state как границу (сообщения чатов не из списка до неё не обрабатывать); до перехода предупредить менеджеров; как не ответить поверх менеджера в живых чатах рабочего номера: вопрос владельцу перед запуском.
 * TODO(этап 3): список закрытого режима передать и в messaging/outbox.ts (выключен => null).
 * TODO(этап 3): pipeline/backlog.ts: события 'stale' в add, onOfflineQueueDone в flush (одно уведомление менеджеру); пока stale пишет pipeline/recorder.ts, а onOfflineQueueDone только пишет в лог число чатов простоя.
 * TODO(этап 3): getSentText из outbound_ids: текст только при совпадении jid.
 * TODO(этап 3): собрать CallBudget (db/repos/call-budget.ts, лимиты из AppConfig.limits) и передать в адаптеры Anthropic и OpenRouter: дневной предохранитель расходов.
 * TODO(этап 3): stop дожидается очереди сообщений (pipeline/batcher.ts drain) до закрытия базы.
 * TODO(этап 6): панель запускать после WhatsApp; stop закрывает её до базы.
 */
export async function main(options: MainOptions): Promise<RunningApp> {
  const logger = createLogger({ level: LOG_LEVEL, destination: options.logDestination });
  try {
    return await startApp(options, logger);
  } catch (error: unknown) {
    return failStart(logger, error);
  }
}

async function startApp(options: MainOptions, logger: Logger): Promise<RunningApp> {
  const { root } = options;
  const { config, warnings } = loadConfig(options.env, readModelsJson(root), root);
  for (const warning of warnings) logger.warn({}, warning);
  logStartup(config, logger);
  // Второй экземпляр падает здесь: до базы, сессии WhatsApp и счётчика привязок.
  const lock = acquireProcessLock(join(root, PROCESS_LOCK_FILE));
  try {
    return await startLocked(config, options, logger, lock);
  } catch (error: unknown) {
    lock.release();
    throw error;
  }
}

async function startLocked(
  config: AppConfig,
  options: MainOptions,
  logger: Logger,
  lock: ProcessLock,
): Promise<RunningApp> {
  const clock = createSystemClock();
  const storage = openStorage(config, logger, clock);
  const link: WhatsAppLink = { connection: null, stoppedBySelf: false };
  const app = runningApp(link, storage, lock, logger);
  try {
    if (!config.waEnabled) {
      logger.warn({}, 'WhatsApp выключен (WA_ENABLED=false)');
      return app;
    }
    const context: AppContext = { config, root: options.root, logger, clock, storage };
    const start = options.startWhatsApp ?? startWhatsApp;
    link.connection = await start(whatsAppDeps(context, onStoppedOf(link, app, logger)));
    return app;
  } catch (error: unknown) {
    storage.close();
    throw error;
  }
}

/** Почему бот не запустился, в лог: SafeError своим текстом (лимит привязок со временем по Алматы), прочие без. */
function failStart(logger: Logger, error: unknown): never {
  const shown =
    error instanceof PairingLimitError ? new PairingLimitExplained(error.retryAtMs) : error;
  if (shown instanceof SafeError) {
    logger.error({ errorName: shown.name }, shown.message);
  } else {
    logger.error({ err: shown }, 'Бот не запущен');
  }
  throw shown;
}

/** Сводка настроек при старте: только флаги и число номеров, без самих номеров. */
function logStartup(config: AppConfig, logger: Logger): void {
  const allowlist = allowlistOf(config.testMode);
  const whatsapp = `Запуск: WhatsApp ${config.waEnabled ? 'включён' : 'выключен'}`;
  if (allowlist === null) {
    // До этапа 8 сюда не попасть: loadConfig не пропускает TEST_MODE=false.
    logger.warn({ waEnabled: config.waEnabled }, `${whatsapp}, закрытый режим выключен`);
    return;
  }
  logger.info(
    { waEnabled: config.waEnabled, allowlistSize: allowlist.size },
    `${whatsapp}, закрытый режим включён, номеров в TEST_ALLOWLIST: ${allowlist.size}`,
  );
}

function allowlistOf(testMode: TestMode): ReadonlySet<PhoneDigits> | null {
  return testMode.enabled ? testMode.allowlist : null;
}

// Конфигурация и база.

function readModelsJson(root: string): unknown {
  const text = readModelsText(join(root, MODELS_FILE));
  try {
    const data: unknown = JSON.parse(text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text);
    return data;
  } catch {
    throw new ConfigError([`${MODELS_FILE}: файл не в формате JSON`]);
  }
}

function readModelsText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error: unknown) {
    const code =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'неизвестная ошибка';
    throw new ConfigError([`${MODELS_FILE}: файл не читается (${code})`]);
  }
}

/** База с миграциями; сбой миграции закрывает её до выхода ошибки. */
function openStorage(config: AppConfig, logger: Logger, clock: Clock): Storage {
  const db = openDatabase(config.databasePath);
  try {
    runMigrations(db);
    return assembleStorage(db, config.pairingMirrorPath, logger, clock);
  } catch (error: unknown) {
    db.close();
    throw error;
  }
}

function assembleStorage(
  db: Database,
  pairingMirrorPath: string,
  logger: Logger,
  clock: Clock,
): Storage {
  const backlog = createBacklogRepo(db);
  const recorder = createInboundRecorder({
    chats: createChatsRepo(db),
    messages: createMessagesRepo(db),
    backlog,
    knownChats: createKnownChatsRepo(db),
    unitOfWork: createUnitOfWork(db),
    logger,
    clock,
  });
  return {
    appState: createAppStateRepo(db),
    pairingGuard: createPairingGuard(db, pairingMirrorPath),
    backlog,
    recorder,
    isOpen: () => db.open,
    // close в better-sqlite3 сам ничего не делает с уже закрытой базой.
    close: () => {
      db.close();
    },
  };
}

// WhatsApp.

/** WhatsApp остановился сам: понятный лог владельцу и та же остановка, что у stop(), без повторной остановки сокета. */
function onStoppedOf(
  link: WhatsAppLink,
  app: RunningApp,
  logger: Logger,
): (reason: WhatsAppStopReason) => Promise<void> {
  return (reason) => {
    link.stoppedBySelf = true;
    logger.error({ reason }, STOP_MESSAGES[reason]);
    return app.stop();
  };
}

function whatsAppDeps(
  context: AppContext,
  onStopped: (reason: WhatsAppStopReason) => Promise<void>,
): WhatsAppDeps {
  const { config, root, logger, clock, storage } = context;
  const { recorder } = storage;
  return {
    sessionDir: config.waSessionDir,
    logger,
    clock,
    appState: storage.appState,
    pairingGuard: storage.pairingGuard,
    managerPhone: config.managerPhone,
    testAllowlist: allowlistOf(config.testMode),
    backlogMaxAgeMs: config.backlogMaxAgeHours * MS_PER_HOUR,
    onEvent: (event) => whileOpen(storage, () => recorder.onEvent(event)),
    onHistoryChats: (chats) =>
      whileOpen(storage, () => settle(() => recorder.onHistoryChats(chats))),
    onOfflineQueueDone: () =>
      whileOpen(storage, () => settle(() => logBacklog(storage.backlog, logger))),
    onStopped,
    // Этап 2 ничего не отправляет: повторно отправлять нечего.
    getSentText: () => Promise.resolve(null),
    presenter: createQrPresenter({
      output: process.stdout,
      pngPath: join(root, QR_PNG_FILE),
      logger,
    }),
  };
}

/** Офлайн-очередь разобрана (после каждого подключения, иногда дважды): пока только число чатов простоя в лог. */
function logBacklog(backlog: BacklogRepo, logger: Logger): void {
  const count = backlog.listPending().length;
  logger.info(
    { count },
    `Офлайн-очередь разобрана: чатов простоя без уведомления менеджеру: ${count}`,
  );
}

/** WhatsApp остановился сам и база закрыта: поздние события некуда записать, они пропускаются. */
function whileOpen(storage: Storage, work: () => Promise<void>): Promise<void> {
  return storage.isOpen() ? work() : Promise.resolve();
}

/** Синхронная работа как промис для портов WhatsAppDeps: исключение становится отказом промиса. */
function settle(work: () => void): Promise<void> {
  return new Promise<void>((resolve) => {
    work();
    resolve();
  });
}

// Остановка.

function runningApp(
  link: WhatsAppLink,
  storage: Storage,
  lock: ProcessLock,
  logger: Logger,
): RunningApp {
  let stopping: Promise<void> | null = null;
  return {
    stop: () => {
      stopping ??= shutdown(link, storage, lock, logger);
      return stopping;
    },
  };
}

async function shutdown(
  link: WhatsAppLink,
  storage: Storage,
  lock: ProcessLock,
  logger: Logger,
): Promise<void> {
  try {
    if (link.connection !== null && !link.stoppedBySelf) await link.connection.stop();
  } finally {
    closeStorage(storage, lock);
  }
  logger.info({ ignored: storage.recorder.ignoredCount() }, 'Бот остановлен');
}

/** Замок снимается после закрытия базы: следующий экземпляр не начнёт, пока эта ещё открыта. */
function closeStorage(storage: Storage, lock: ProcessLock): void {
  try {
    storage.close();
  } finally {
    lock.release();
  }
}

// Время для владельца.

function pairingLimitText(retryAtMs: number): string {
  return (
    'Привязка по QR запрещена: лимит попыток за 24 часа исчерпан. ' +
    `Следующая попытка не раньше ${formatAlmatyTime(retryAtMs)} по времени Алматы (UTC+5): тогда запустите бота снова`
  );
}

/** ДД.ММ.ГГГГ ЧЧ:ММ по Алматы; секунды округляются вверх: раньше этой минуты попытка ещё запрещена. */
function formatAlmatyTime(ms: number): string {
  const local = new Date(Math.ceil(ms / MS_PER_MINUTE) * MS_PER_MINUTE + ALMATY_OFFSET_MS);
  const two = (value: number): string => String(value).padStart(2, '0');
  const date = `${two(local.getUTCDate())}.${two(local.getUTCMonth() + 1)}.${local.getUTCFullYear()}`;
  return `${date} ${two(local.getUTCHours())}:${two(local.getUTCMinutes())}`;
}
