import { SESSION_LIMITS } from '../auth/sessions.js';

/** Cookie сессии по HTTPS: __Host- запрещает Domain и требует Secure и Path=/. */
export const SECURE_COOKIE = '__Host-tanbala_console';
/** На локальном HTTP (ПК) __Host- браузер не примет: обычное имя. */
export const LOCAL_COOKIE = 'tanbala_console';

const FLAGS = 'Path=/; HttpOnly; SameSite=Strict';
const MAX_AGE_SECONDS = Math.floor(SESSION_LIMITS.maxAgeMs / 1000);

export function cookieName(secure: boolean): string {
  return secure ? SECURE_COOKIE : LOCAL_COOKIE;
}

/** Значение cookie по имени из заголовка Cookie; берётся первое. Нет или пусто: null. */
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

/** Set-Cookie сессии: HttpOnly, SameSite=Strict, на весь сайт, 30 дней; Secure по HTTPS. */
export function sessionCookie(token: string, secure: boolean): string {
  return `${cookieName(secure)}=${token}; ${FLAGS}; Max-Age=${MAX_AGE_SECONDS}${secure ? '; Secure' : ''}`;
}

/** Set-Cookie, стирающий cookie сессии (выход). */
export function clearedSessionCookie(secure: boolean): string {
  return `${cookieName(secure)}=; ${FLAGS}; Max-Age=0${secure ? '; Secure' : ''}`;
}
