/** Имя cookie сессии панели. */
export const SESSION_COOKIE = 'tanbala_sid';

/** Поля формы application/x-www-form-urlencoded; Map, а не объект: имя поля не может задеть прототип. */
export type FormFields = ReadonlyMap<string, string>;

/** Что нужно, чтобы решить, пришёл ли изменяющий запрос с нашей же страницы. */
export interface OriginCheckInput {
  readonly origin: string | undefined;
  readonly referer: string | undefined;
  /** Заголовок Host запроса (уже проверен guard.hostHeaderAllowed). */
  readonly hostHeader: string | undefined;
  /** 'http' или 'https': за Caddy из X-Forwarded-Proto доверенного прокси. */
  readonly protocol: string;
}

const COOKIE_FLAGS = 'Path=/; HttpOnly; SameSite=Strict';
const EXPIRED = 'Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
const HSTS_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** Значение cookie по имени из заголовка Cookie. Берётся первое; нет, пусто или мусор => null. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value === '' ? null : value;
  }
  return null;
}

/**
 * Set-Cookie сессии: HttpOnly (скрипту недоступна), SameSite=Strict (чужие сайты её не отправят),
 * на весь сайт; Secure, когда запрос пришёл по HTTPS. Срок не задан: cookie живёт до закрытия браузера,
 * а срок сессии ведёт сервер (sessions.ts).
 */
export function sessionCookie(id: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${id}; ${COOKIE_FLAGS}${secure ? '; Secure' : ''}`;
}

/** Set-Cookie, который стирает cookie сессии (выход). */
export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; ${COOKIE_FLAGS}; ${EXPIRED}${secure ? '; Secure' : ''}`;
}

/** Разбирает тело формы. Повторное поле игнорируется: берётся первое. */
export function parseForm(body: string): FormFields {
  const fields = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(body)) {
    if (!fields.has(name)) fields.set(name, value);
  }
  return fields;
}

/** Поле из request.body, которое разобрал parseForm; нет поля или тело не форма => null. */
export function formField(body: unknown, name: string): string | null {
  if (!(body instanceof Map)) return null;
  const value: unknown = body.get(name);
  return typeof value === 'string' ? value : null;
}

/**
 * Пришёл ли изменяющий запрос с нашей же страницы. Origin должен совпасть с адресом самой панели
 * (схема и Host); без Origin смотрится адрес из Referer; нет ни того ни другого => отказ.
 * 'null', путь, имя пользователя и чужой сайт в Origin не проходят.
 */
export function originAllowed(input: OriginCheckInput): boolean {
  const host = input.hostHeader?.toLowerCase();
  if (host === undefined || host === '') return false;
  const own = `${input.protocol}://${host}`;
  if (input.origin !== undefined) return input.origin.toLowerCase() === own;
  if (input.referer === undefined) return false;
  try {
    return new URL(input.referer).origin === own;
  } catch {
    return false;
  }
}

/** Политика содержимого: ни скриптов, ни чужих ресурсов; стили только с нашего адреса (отдельный файл CSS). */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * Заголовки безопасности каждого ответа: CSP без inline-скриптов, запрет показа во фреймах, nosniff,
 * no-store (переписка не оседает в кэше браузера и прокси), Referrer-Policy same-origin (с no-referrer браузер
 * шлёт «Origin: null» с форм и проверка Origin отказала бы), изоляция окна и ресурсов; HSTS только по HTTPS.
 */
export function securityHeaders(secure: boolean): Readonly<Record<string, string>> {
  return {
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'cache-control': 'no-store',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    ...(secure ? { 'strict-transport-security': `max-age=${HSTS_MAX_AGE_SECONDS}` } : {}),
  };
}
