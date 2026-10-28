import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvironment } from './config/dotenv.js';
import { loadConfig, type EnvVars } from './config/env.js';
import { formatFatalError } from './config/errors.js';
import { readModelsJson } from './config/models-file.js';
import { acquireProcessLock, ProcessLockBusyError } from './db/process-lock.js';
import type { ProcessLock } from './domain/ports.js';
import { createSystemClock } from './shared/clock.js';
import { createLogger } from './shared/logger.js';
import {
  parseProbeNumber,
  PROBE_TIMEOUT_MS,
  PROBE_USAGE,
  runBusinessProbe,
} from './whatsapp/probe.js';

// Вторая точка входа: проба бизнес-профиля, `npm run probe:business -- <номер>`. Один запуск по разрешению владельца.
// stdout отдан под одну строку JSON с итогом; лог (через фильтр createLogger) и причины отказа идут в stderr.
// Проба запускается, только когда файл запущен как программа: импорт (проверка модулей в тестах) ничего не делает.

/** Тот же замок, что держит бот (main.ts): проба не работает с сессией, пока бот запущен. */
const PROCESS_LOCK_FILE = join('data', 'process.lock');

/** Уровень лога пробы, как у бота; у Baileys свой уровень warn (whatsapp/socket-config.ts). */
const LOG_LEVEL = 'info';

/**
 * Предохранитель сверх общего срока пробы: если закрытие сокета или запись сессии зависнут, процесс всё равно
 * завершится. Таймер снят с учёта (unref): сам он процесс не держит.
 */
const HARD_EXIT_MS = PROBE_TIMEOUT_MS + 30_000;

/** Что точка входа передаёт пробе. */
export interface ProbeCliOptions {
  /** Аргументы командной строки после имени скрипта. */
  readonly args: readonly string[];
  /** Переменные процесса; .env из корня проекта читается так же, как у бота (cli.ts). */
  readonly env: EnvVars;
  /** Абсолютный путь к корню проекта: от него считаются data/process.lock, .env и пути из него. */
  readonly root: string;
  /** Одна строка JSON с итогом. */
  readonly stdout: (text: string) => void;
  /** Причины отказа и строки лога. */
  readonly stderr: (text: string) => void;
}

/** Замок бота; занят (бот запущен): null. Прочие сбои замка пробрасываются. */
function acquireBotLock(root: string): ProcessLock | null {
  try {
    return acquireProcessLock(join(root, PROCESS_LOCK_FILE));
  } catch (error: unknown) {
    if (error instanceof ProcessLockBusyError) return null;
    throw error;
  }
}

/** Отказ при WA_ENABLED=false: подключаться к WhatsApp нельзя ни боту, ни пробе. */
const WA_DISABLED = 'WA_ENABLED=false: подключение к WhatsApp выключено, проба не запускается\n';

/**
 * Что пробе нужно из настроек: папка сессии и WA_ENABLED. Те же .env, config/models.json и проверка настроек, что у
 * бота (config/env.ts).
 */
function settingsOf(options: ProbeCliOptions): {
  readonly sessionDir: string;
  readonly waEnabled: boolean;
} {
  const { root } = options;
  const env = loadEnvironment(root, options.env);
  const { config } = loadConfig(env, readModelsJson(root), root);
  return { sessionDir: config.waSessionDir, waEnabled: config.waEnabled };
}

/**
 * Проба из командной строки: неверный номер => подсказка и код 1 до чтения .env, замка и сессии; настройки не прошли
 * проверку => их список (formatFatalError, как у бота) и код 1; WA_ENABLED=false => отказ и код 1 до замка и сессии;
 * дальше runBusinessProbe с замком бота, системными часами и логом в stderr. Возвращает код выхода.
 */
export async function runProbeCli(options: ProbeCliOptions): Promise<number> {
  if (parseProbeNumber(options.args) === null) {
    options.stderr(`${PROBE_USAGE}\n`);
    return 1;
  }
  let settings: ReturnType<typeof settingsOf>;
  try {
    settings = settingsOf(options);
  } catch (error: unknown) {
    options.stderr(formatFatalError(error));
    return 1;
  }
  if (!settings.waEnabled) {
    options.stderr(WA_DISABLED);
    return 1;
  }
  return runBusinessProbe(options.args, {
    sessionDir: settings.sessionDir,
    logger: createLogger({ level: LOG_LEVEL, destination: { write: options.stderr } }),
    clock: createSystemClock(),
    acquireLock: () => acquireBotLock(options.root),
    out: { stdout: options.stdout, stderr: options.stderr },
  });
}

/** Выход с кодом после того, как stdout и stderr дописаны (на Windows и в каналах запись асинхронная). */
function exitWith(code: number): void {
  process.stdout.write('', () => {
    process.stderr.write('', () => process.exit(code));
  });
}

/** Причина в stderr без текста посторонней ошибки (formatFatalError, как в cli.ts) и выход 1. */
function exitWithError(error: unknown): void {
  process.stderr.write(formatFatalError(error), () => process.exit(1));
}

/** Файл запущен как программа (node dist/probe-cli.js), а не импортирован. Пути сравниваются после разрешения ссылок. */
function isMainModule(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

function startFromCommandLine(): void {
  // Необработанные ошибки: иначе Node напечатает их целиком, с текстом и JID, в обход фильтра.
  process.on('uncaughtException', exitWithError);
  process.on('unhandledRejection', exitWithError);
  setTimeout(() => {
    process.stderr.write('Проба не завершилась вовремя: выход без ожидания\n', () =>
      process.exit(1),
    );
  }, HARD_EXIT_MS).unref();
  runProbeCli({
    args: process.argv.slice(2),
    env: process.env,
    // Корень проекта считается от этого файла (src/ или dist/), а не от текущей папки процесса.
    root: fileURLToPath(new URL('..', import.meta.url)),
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  }).then(exitWith, exitWithError);
}

if (isMainModule()) startFromCommandLine();
