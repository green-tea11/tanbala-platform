import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { SafeError } from '../shared/safe-error.js';

/** Знания бота: текст knowledge/bot.md и его версия. */
export interface Knowledge {
  /**
   * knowledge/bot.md: кто мы, что умеем (сильные стороны F1–F10), боли с плюсами, ход разговора и что нельзя (просьба
   * владельца 03.11.2026: один короткий файл вместо трёх).
   */
  readonly text: string;
  /** sha256 текста: видно, когда знания поменялись и кэш промпта начался заново. */
  readonly version: string;
}

/**
 * Читает файл знаний целиком (раздел плана «Знания агента»: без RAG, весь текст в промпте).
 * readText передаётся параметром, чтобы тесты обходились без диска (в рабочем режиме readFile в utf8).
 * Текст байт в байт, без обрезки и правок: любая разница ломает кэш промпта.
 * Пустой, пробельный или нечитаемый файл => SafeError с именем файла при старте; исходная ошибка чтения лежит в cause.
 */
export async function loadKnowledge(
  path: string,
  readText: (path: string) => Promise<string>,
): Promise<Knowledge> {
  let text: string;
  try {
    text = await readText(path);
  } catch (error: unknown) {
    throw new SafeError(`Файл знаний не прочитан: ${basename(path)}`, { cause: error });
  }
  if (text.trim() === '') {
    throw new SafeError(`Файл знаний пуст: ${basename(path)}`);
  }
  return { text, version: createHash('sha256').update(text).digest('hex') };
}
