import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from './errors.js';

/** Модели LLM: файл в корне проекта, меняется без правки кода. */
const MODELS_FILE = 'config/models.json';

/** Метка порядка байтов UTF-8: её ставит Блокнот Windows, а JSON.parse на ней падает. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** Чтение текстового файла; в рабочем режиме readFileSync, в тестах подмена. */
export type ReadText = (path: string) => string;

const readUtf8: ReadText = (path) => readFileSync(path, 'utf8');

function readModelsText(path: string, readText: ReadText): string {
  try {
    return readText(path);
  } catch (error: unknown) {
    const code =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'неизвестная ошибка';
    throw new ConfigError([`${MODELS_FILE}: файл не читается (${code})`]);
  }
}

/**
 * Содержимое config/models.json как есть (форму проверяет loadConfig). Файл не читается или не JSON: ConfigError с кодом
 * ошибки, без пути и без текста файла. Так читают файл все точки входа: бот (main.ts) и проба бизнес-профиля.
 */
export function readModelsJson(root: string, readText: ReadText = readUtf8): unknown {
  const text = readModelsText(join(root, MODELS_FILE), readText);
  try {
    const data: unknown = JSON.parse(text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text);
    return data;
  } catch {
    throw new ConfigError([`${MODELS_FILE}: файл не в формате JSON`]);
  }
}
