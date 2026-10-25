import type { Clock, TokenLog } from '../domain/ports.js';
import { notImplemented } from '../shared/todo.js';

/**
 * Лог расхода API в файл TOKEN_LOG_PATH: одна строка JSON (TokenUsage) на вызов.
 * appendLine и clock передаются параметрами, чтобы тесты обходились без диска и без реального времени.
 * TODO(этап 3): ts ставить из clock.now() в ISO 8601 UTC; дальше провайдер, тип вызова, модель, токены (input, output, cacheRead, cacheWrite), ID чата и успех.
 * TODO(этап 3): только числа и ID чата: без текста сообщений, номеров и ключей.
 * TODO(этап 8): ротация файла на VPS.
 */
export function createJsonlTokenLog(
  path: string,
  appendLine: (path: string, line: string) => Promise<void>,
  clock: Clock,
): TokenLog {
  return notImplemented('этап 3', 'llm/token-log.createJsonlTokenLog');
}
