import { notImplemented } from '../shared/todo.js';

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
 * readText передаётся параметром, чтобы тесты обходились без диска.
 * TODO(этап 3): тексты байт в байт, без обрезки и правок: любая разница ломает кэш промпта.
 * TODO(этап 3): version: sha256 от обоих текстов; пустой или отсутствующий файл => понятная ошибка при старте.
 */
export function loadKnowledge(
  paths: { readonly owner: string; readonly whatsapp: string },
  readText: (path: string) => Promise<string>,
): Promise<Knowledge> {
  return notImplemented('этап 3', 'agent/knowledge.loadKnowledge');
}
