// Настройки связи с почтовым проектом (проект B): адрес и токен внутреннего API, адрес интерфейса для ссылок.
// Чистые функции без доступа к окружению: значения читает и проверяет config/env.ts.

/** Адрес внутреннего API по умолчанию: API проекта B слушает только 127.0.0.1. */
export const EMAIL_API_DEFAULT_URL = 'http://127.0.0.1:8000';

/** Токен внутреннего API: видимые символы ASCII без пробелов, не короче 32 (короче проект B считает API выключенным). */
export const INTERNAL_API_TOKEN_PATTERN = /^[\x21-\x7E]{32,512}$/;

/** Хосты, на которые токен можно отправить: только эта машина, наружу он уйти не должен. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost']);

/**
 * Вид адреса до разбора: схема и хост без пробелов, обратного слэша, «?» и «#». Пустые «?» и «#» в разборе URL
 * не видны (search и hash пусты), поэтому запрещаются здесь; обратный слэш URL считает за «/».
 */
const API_URL_FORM = /^http:\/\/[^\s\\?#]+$/i;
const UI_URL_FORM = /^https?:\/\/[^\s\\?#]+$/i;

const TRAILING_SLASHES = /\/+$/;

function parseUrl(value: string, form: RegExp): URL | null {
  if (!form.test(value)) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Адрес внутреннего API (EMAIL_API_URL): только http, без логина и пароля, путь пустой или «/», хост 127.0.0.1,
 * localhost (проект B принимает только такой заголовок Host). Возвращает нормализованный адрес без хвостового «/» (схема, хост, порт); неверный: null.
 */
export function parseEmailApiUrl(value: string): string | null {
  const url = parseUrl(value, API_URL_FORM);
  if (url === null || url.username !== '' || url.password !== '' || url.pathname !== '/') {
    return null;
  }
  return LOOPBACK_HOSTS.has(url.hostname) ? url.origin : null;
}

/**
 * Адрес интерфейса почтового проекта (EMAIL_UI_URL) для ссылок менеджеру: http или https, без логина и пароля,
 * путь допустим (интерфейс за прокси). Хвостовые «/» убираются; неверный: null.
 */
export function parseEmailUiUrl(value: string): string | null {
  const url = parseUrl(value, UI_URL_FORM);
  if (url === null || url.username !== '' || url.password !== '') return null;
  return `${url.origin}${url.pathname.replace(TRAILING_SLASHES, '')}`;
}
