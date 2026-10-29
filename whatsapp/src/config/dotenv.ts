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
 * Закрытый режим и подключение к WhatsApp: переменная процесса (например, глобальная переменная Windows)
 * не должна молча перебить значение из .env.
 */
const GUARDED_VARIABLES = ['TEST_MODE', 'TEST_ALLOWLIST', 'WA_ENABLED'] as const;

const CONFLICT_PROBLEM =
  'задана и в окружении процесса, и в .env, значения разные: оставьте одно место ' +
  '(переменная процесса молча перебила бы .env)';

/** Значения переменной без учёта регистра имени: на Windows имена переменных от регистра не зависят. */
function valuesOf(env: EnvVars, name: string): string[] {
  return Object.entries(env).flatMap(([key, value]) =>
    key.toUpperCase() === name && value !== undefined ? [value.trim()] : [],
  );
}

/** Защищённые переменные, у которых процесс и .env расходятся. Значения в текст не попадают. */
function conflictProblems(fileEnv: EnvVars, processEnv: EnvVars): string[] {
  return GUARDED_VARIABLES.filter((name) => {
    const fromFile = valuesOf(fileEnv, name);
    return (
      fromFile.length > 0 && valuesOf(processEnv, name).some((value) => !fromFile.includes(value))
    );
  }).map((name) => `${name}: ${CONFLICT_PROBLEM}`);
}

/**
 * Окружение приложения: переменные из .env в корне проекта, поверх них переменные процесса (они главнее).
 * Файла нет: только переменные процесса. Аргументы не меняются, результат: новый объект;
 * process.env не трогается. Незаданные (undefined) переменные процесса значения из .env не затирают.
 * TEST_MODE, TEST_ALLOWLIST или WA_ENABLED и в процессе, и в .env с разными значениями: ConfigError.
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
