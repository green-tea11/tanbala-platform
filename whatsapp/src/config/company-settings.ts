// Настройки связи с почтовым проектом (проект B): адрес и токен внутреннего API, адрес интерфейса для ссылок.
// Чистые функции без доступа к окружению: значения читает и проверяет config/env.ts.

/** Адрес внутреннего API по умолчанию: API проекта B слушает только 127.0.0.1. */
export const EMAIL_API_DEFAULT_URL = 'http://127.0.0.1:8000';

/** Токен внутреннего API: видимые символы ASCII без пробелов, не короче 32 (короче проект B считает API выключенным). */
export const INTERNAL_API_TOKEN_PATTERN = /^[\x21-\x7E]{32,512}$/;

/**
 * Хост внутреннего API: только 127.0.0.1. Проект B слушает только его, а localhost может разрешиться в ::1, где никто
 * не слушает; токен наружу уйти не должен.
 */
const API_HOST = '127.0.0.1';

/** Хосты интерфейса, для которых годится http: только эта машина. Остальные только по https. */
const UI_PLAIN_HTTP_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost']);

/**
 * Вид адреса до разбора: схема и хост без пробелов, обратного слэша, «?» и «#». Пустые «?» и «#» в разборе URL
 * не видны (search и hash пусты), поэтому запрещаются здесь; обратный слэш URL считает за «/».
 */
const API_URL_FORM = /^http:\/\/[^\s\\?#]+$/i;
const UI_URL_FORM = /^https?:\/\/[^\s\\?#]+$/i;

const TRAILING_SLASHES = /\/+$/;

/** Прокси Node для fetch из окружения: NODE_USE_ENV_PROXY со значением 1 или true. */
const ENV_PROXY_ON = /^(?:1|true)$/i;

/** Флаг --use-env-proxy в NODE_OPTIONS (Node принимает и подчёркивания вместо дефисов), в том числе с «=значение». */
const USE_ENV_PROXY_FLAG = /(?:^|\s)--use[-_]env[-_]proxy(?:=\S*)?(?=\s|$)/i;

/** Переменные окружения: имя и значение (как EnvVars в config/env.ts). */
type Env = Readonly<Record<string, string | undefined>>;

function parseUrl(value: string, form: RegExp): URL | null {
  if (!form.test(value)) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Адрес внутреннего API (EMAIL_API_URL): только http, без логина и пароля, путь пустой или «/», хост только 127.0.0.1.
 * Возвращает нормализованный адрес без хвостового «/» (схема, хост, порт); неверный: null.
 */
export function parseEmailApiUrl(value: string): string | null {
  const url = parseUrl(value, API_URL_FORM);
  if (url === null || url.username !== '' || url.password !== '' || url.pathname !== '/') {
    return null;
  }
  return url.hostname === API_HOST ? url.origin : null;
}

/**
 * Адрес интерфейса почтового проекта (EMAIL_UI_URL) для ссылок менеджеру: https, а http только для 127.0.0.1 и
 * localhost; без логина и пароля, путь допустим (интерфейс за прокси). Хвостовые «/» убираются; неверный: null.
 */
export function parseEmailUiUrl(value: string): string | null {
  const url = parseUrl(value, UI_URL_FORM);
  if (url === null || url.username !== '' || url.password !== '') return null;
  if (url.protocol === 'http:' && !UI_PLAIN_HTTP_HOSTS.has(url.hostname)) return null;
  return `${url.origin}${url.pathname.replace(TRAILING_SLASHES, '')}`;
}

/**
 * Значения переменной name. Регистр имени не важен: на Windows имена переменных окружения от регистра не зависят,
 * и Node увидит любой вариант.
 */
function valuesOf(env: Env, name: string): readonly string[] {
  return Object.entries(env).flatMap(([key, value]) =>
    key.toUpperCase() === name && value !== undefined ? [value.trim()] : [],
  );
}

/**
 * Включён ли в окружении прокси Node для fetch: NODE_USE_ENV_PROXY равна 1 или true либо в NODE_OPTIONS есть
 * --use-env-proxy. Тогда fetch пошёл бы через HTTP_PROXY, и токен внутреннего API ушёл бы с этой машины.
 */
export function isNodeEnvProxyOn(env: Env): boolean {
  return (
    valuesOf(env, 'NODE_USE_ENV_PROXY').some((value) => ENV_PROXY_ON.test(value)) ||
    valuesOf(env, 'NODE_OPTIONS').some((value) => USE_ENV_PROXY_FLAG.test(value))
  );
}
