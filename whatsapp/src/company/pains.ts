import type { CompanyBrief } from '../domain/company.js';

/** Сколько болей клиента хранится в состоянии чата (для уведомления и панели). */
const MAX_CLIENT_PAINS = 5;

/** Сколько болей справки уходит в промпт модели (решение владельца 30.10.2026: до трёх). */
const MAX_PROMPT_PAINS = 3;

/** Любая цифра Unicode, в том числе арабско-индийская, и числовые знаки вроде «²» и «½». */
const HAS_NUMBER = /\p{N}/u;

function painKey(pain: string): string {
  return pain.toLowerCase();
}

/**
 * Объединение болей клиента: старые и новые без повторов (регистр не важен), не больше пяти. Свежие не теряются:
 * повторённая боль считается новой (старая запись заменяется и уходит в конец), а при переполнении отбрасываются
 * самые старые. Пустые строки и пробелы по краям убираются. Входные списки не меняются.
 */
export function mergeClientPains(
  known: readonly string[],
  fresh: readonly string[],
): readonly string[] {
  const all = [...known, ...fresh].map((pain) => pain.trim()).filter((pain) => pain !== '');
  const lastIndex = new Map(all.map((pain, index) => [painKey(pain), index]));
  return all
    .filter((pain, index) => lastIndex.get(painKey(pain)) === index)
    .slice(-MAX_CLIENT_PAINS);
}

/**
 * Боли справки для промпта: только тексты pain (цитата и источник модели не передаются), без строк с цифрами и не
 * больше трёх. Справки нет => пусто.
 */
export function promptPains(brief: CompanyBrief | null): readonly string[] {
  return (brief?.pains ?? [])
    .map((item) => item.pain)
    .filter((pain) => !HAS_NUMBER.test(pain))
    .slice(0, MAX_PROMPT_PAINS);
}

/** Рубрика справки для промпта: с цифрами (цифры о клиенте) не идёт, как и боли с цифрами. Справки нет => null. */
export function promptRubric(brief: CompanyBrief | null): string | null {
  const rubric = brief?.rubric ?? null;
  return rubric === null || HAS_NUMBER.test(rubric) ? null : rubric;
}
