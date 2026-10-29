import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import type { EnvVars } from './env.js';
import { ConfigError } from './errors.js';

/** Файл настроек в корне проекта. */
const DOTENV_FILE = '.env';

/** Метка порядка байтов UTF-8: Блокнот Windows ставит её в начало файла, и она прилипла бы к первому имени. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** Текст файла; null, если файла нет. Другая ошибка чтения: ConfigError с кодом, без содержимого. */
function readOptionalFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error: unknown) {
    const code: unknown = (error as { code?: unknown }).code;
    if (code === 'ENOENT') {
      return null;
    }
    const reason = typeof code === 'string' ? code : 'неизвестная ошибка';
    throw new ConfigError([`${DOTENV_FILE}: файл не читается (${reason})`]);
  }
}

/** Переменные из .env через util.parseEnv; файла нет: пустой набор. */
function readDotEnv(path: string): EnvVars {
  const text = readOptionalFile(path);
  if (text === null) {
    return {};
  }
  return parseEnv(text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text);
}

/**
 * Закрытый режим и подключение к WhatsApp задаются только в .env: переменная процесса (например, глобальная
 * переменная Windows) не должна молча перебить значение из .env или подставиться, когда в .env строки нет.
 */
const GUARDED_VARIABLES = ['TEST_MODE', 'TEST_ALLOWLIST', 'WA_ENABLED'] as const;

const CONFLICT_PROBLEM =
  'задана и в окружении процесса, и в .env, значения разные: оставьте одно место ' +
  '(переменная процесса молча перебила бы .env)';

const PROCESS_ONLY_PROBLEM =
  'задана в окружении процесса, а в .env её нет: перенесите её в .env и уберите из окружения ' +
  '(иначе режим бота менялся бы мимо .env)';

/** Значения переменной без учёта регистра имени: на Windows имена переменных от регистра не зависят. */
function valuesOf(env: EnvVars, name: string): string[] {
  return Object.entries(env).flatMap(([key, value]) =>
    key.toUpperCase() === name && value !== undefined ? [value.trim()] : [],
  );
}

/**
 * Защищённые переменные, у которых процесс и .env расходятся: разные значения или значение только в процессе.
 * Значения в текст не попадают.
 */
function conflictProblems(fileEnv: EnvVars, processEnv: EnvVars): string[] {
  return GUARDED_VARIABLES.flatMap((name) => {
    const fromProcess = valuesOf(processEnv, name);
    if (fromProcess.length === 0) return [];
    const fromFile = valuesOf(fileEnv, name);
    if (fromFile.length === 0) return [`${name}: ${PROCESS_ONLY_PROBLEM}`];
    return fromProcess.some((value) => !fromFile.includes(value))
      ? [`${name}: ${CONFLICT_PROBLEM}`]
      : [];
  });
}

/**
 * Окружение приложения: переменные из .env в корне проекта, поверх них переменные процесса (они главнее).
 * Файла нет: только переменные процесса. Аргументы не меняются, результат: новый объект;
 * process.env не трогается. Незаданные (undefined) переменные процесса значения из .env не затирают.
 * TEST_MODE, TEST_ALLOWLIST или WA_ENABLED в процессе с другим значением, чем в .env, или в процессе при отсутствии
 * в .env (в том числе без файла): ConfigError. Совпадающее значение в процессе ошибкой не считается.
 */
export function loadEnvironment(root: string, processEnv: EnvVars): EnvVars {
  const fileEnv = readDotEnv(join(root, DOTENV_FILE));
  const conflicts = conflictProblems(fileEnv, processEnv);
  if (conflicts.length > 0) {
    throw new ConfigError(conflicts);
  }
  const fromProcess = Object.entries(processEnv).filter(([, value]) => value !== undefined);
  return { ...fileEnv, ...Object.fromEntries(fromProcess) };
}
