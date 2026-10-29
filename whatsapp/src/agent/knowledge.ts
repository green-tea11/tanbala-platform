import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { SafeError } from '../shared/safe-error.js';

/** Тексты двух файлов знаний и их общая версия. */
export interface Knowledge {
  /** knowledge/tanbala-agent.md: документ владельца, тот же файл, что в B-web-email. */
  readonly owner: string;
  /** knowledge/whatsapp.md: правила только для WhatsApp, при расхождении главнее документа. */
  readonly whatsapp: string;
  /** Хэш обоих текстов: видно, когда знания поменялись и кэш промпта начался заново. */
  readonly version: string;
}

/**
 * Читает оба файла знаний целиком (раздел плана «Знания агента»: без RAG, весь текст в промпте).
 * readText передаётся параметром, чтобы тесты обходились без диска (в рабочем режиме readFile в utf8).
 * Тексты байт в байт, без обрезки и правок: любая разница ломает кэш промпта.
 * version: sha256 от обоих текстов по порядку. Пустой, пробельный или нечитаемый файл => SafeError
 * с именем файла при старте; исходная ошибка чтения лежит в cause.
 */
export async function loadKnowledge(
  paths: { readonly owner: string; readonly whatsapp: string },
  readText: (path: string) => Promise<string>,
): Promise<Knowledge> {
  const [owner, whatsapp] = await Promise.all([
    readKnowledgeFile(paths.owner, readText),
    readKnowledgeFile(paths.whatsapp, readText),
  ]);
  return { owner, whatsapp, version: knowledgeVersion(owner, whatsapp) };
}

async function readKnowledgeFile(
  path: string,
  readText: (path: string) => Promise<string>,
): Promise<string> {
  let text: string;
  try {
    text = await readText(path);
  } catch (error: unknown) {
    throw new SafeError(`Файл знаний не прочитан: ${basename(path)}`, { cause: error });
  }
  if (text.trim() === '') {
    throw new SafeError(`Файл знаний пуст: ${basename(path)}`);
  }
  return text;
}

/** JSON-массив вместо склейки: тексты «ab» + «c» и «a» + «bc» дают разные версии. */
function knowledgeVersion(owner: string, whatsapp: string): string {
  return createHash('sha256')
    .update(JSON.stringify([owner, whatsapp]))
    .digest('hex');
}
