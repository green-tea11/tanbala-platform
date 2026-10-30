import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { ConfigError } from './errors.js';

/** Переменные окружения: имя и значение. */
export type EnvVars = Readonly<Record<string, string | undefined>>;

const DOTENV_FILE = '.env';
/** Метка порядка байтов UTF-8: Блокнот Windows ставит её в начало файла, и она прилипла бы к первому имени. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** Текст файла; null, если файла нет. Другая ошибка чтения: ConfigError с кодом, без содержимого. */
function readOptionalFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error: unknown) {
    const code: unknown = (error as { code?: unknown }).code;
    if (code === 'ENOENT') return null;
    const reason = typeof code === 'string' ? code : 'неизвестная ошибка';
    throw new ConfigError([`${DOTENV_FILE}: файл не читается (${reason})`]);
  }
}

/**
 * Окружение консоли: переменные из .env в корне консоли, поверх них переменные процесса (они главнее).
 * Файла нет: только переменные процесса. Аргументы не меняются, результат: новый объект.
 */
export function loadEnvironment(root: string, processEnv: EnvVars): EnvVars {
  const text = readOptionalFile(join(root, DOTENV_FILE));
  const fileEnv: EnvVars =
    text === null ? {} : parseEnv(text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text);
  const fromProcess = Object.entries(processEnv).filter(([, value]) => value !== undefined);
  return { ...fileEnv, ...Object.fromEntries(fromProcess) };
}
