import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { SafeError } from '../shared/safe-error.js';

/** Тексты трёх файлов знаний и их общая версия. */
export interface Knowledge {
  /** knowledge/tanbala-agent.md: документ владельца, тот же файл, что в B-web-email. */
  readonly owner: string;
  /** knowledge/whatsapp.md: правила только для WhatsApp, при расхождении главнее документа. */
  readonly whatsapp: string;
  /**
   * knowledge/consult.md: как вести разговор, сильные стороны F1–F10, боли с плюсами (решение владельца 30.10.2026).
   * В том, как вести разговор, главнее whatsapp.md и документа.
   */
  readonly consult: string;
  /** Хэш всех трёх текстов: видно, когда знания поменялись и кэш промпта начался заново. */
  readonly version: string;
}

/** Пути к трём файлам знаний. */
export interface KnowledgePaths {
  readonly owner: string;
  readonly whatsapp: string;
  readonly consult: string;
}

/**
 * Читает все файлы знаний целиком (раздел плана «Знания агента»: без RAG, весь текст в промпте).
 * readText передаётся параметром, чтобы тесты обходились без диска (в рабочем режиме readFile в utf8).
 * Тексты байт в байт, без обрезки и правок: любая разница ломает кэш промпта.
 * version: sha256 от текстов по порядку. Пустой, пробельный или нечитаемый файл => SafeError
 * с именем файла при старте; исходная ошибка чтения лежит в cause.
 */
export async function loadKnowledge(
  paths: KnowledgePaths,
  readText: (path: string) => Promise<string>,
): Promise<Knowledge> {
  const [owner, whatsapp, consult] = await Promise.all([
    readKnowledgeFile(paths.owner, readText),
    readKnowledgeFile(paths.whatsapp, readText),
    readKnowledgeFile(paths.consult, readText),
  ]);
  return { owner, whatsapp, consult, version: knowledgeVersion([owner, whatsapp, consult]) };
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
function knowledgeVersion(texts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(texts)).digest('hex');
}
