/** Общий префикс эндпоинтов консоли у почты и бота. */
export const CONSOLE_PREFIX = '/internal/console';

/** Неизменяемая часть шаблона адреса: латиница и дефис (summary, companies, send-test). */
const STATIC_SEGMENT = /^[a-z][a-z-]{0,39}$/;
/** Имя параметра строки запроса. */
const QUERY_NAME = /^[A-Za-z]{1,20}$/;

/** Адрес к приложению, собранный только из шаблона: путь и строка запроса уже закодированы. */
export interface BackendPath {
  /** Путь без строки запроса: идёт в лог (в нём только id). */
  readonly pathname: string;
  /** Путь со строкой запроса: идёт в запрос и в ключ кэша. */
  readonly full: string;
}

export type QueryValue = string | number | undefined;

/** Ошибка шаблона: адрес собран из чего-то, кроме слов шаблона и целых id. Это ошибка кода консоли. */
export class PathTemplateError extends Error {
  override readonly name = 'PathTemplateError';
}

function encodeSegment(segment: string | number): string {
  if (typeof segment === 'number') {
    if (!Number.isSafeInteger(segment) || segment < 1) {
      throw new PathTemplateError('id в адресе только целое больше нуля');
    }
    return encodeURIComponent(String(segment));
  }
  if (!STATIC_SEGMENT.test(segment)) throw new PathTemplateError('часть шаблона не из слов');
  return encodeURIComponent(segment);
}

function encodeQuery(query: Readonly<Record<string, QueryValue>>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (!QUERY_NAME.test(name)) throw new PathTemplateError('имя параметра не из букв');
    if (value === undefined || value === '') continue;
    params.append(name, String(value));
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/**
 * Адрес эндпоинта консоли: /internal/console/<части>?<параметры>. Части — слова шаблона из кода или целые id
 * (уже проверены zod), каждая через encodeURIComponent; параметры через URLSearchParams, пустые пропускаются.
 */
export function consolePath(
  segments: readonly (string | number)[],
  query: Readonly<Record<string, QueryValue>> = {},
): BackendPath {
  const pathname = `${CONSOLE_PREFIX}/${segments.map(encodeSegment).join('/')}`;
  return { pathname, full: `${pathname}${encodeQuery(query)}` };
}
