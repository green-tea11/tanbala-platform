import { codePointLength } from '../shared/text.js';

/** Имя пользователя консоли: строчная латиница, цифры, точка, подчёркивание, дефис; до 32 символов. */
export const USER_NAME_PATTERN = /^[a-z0-9._-]{1,32}$/;
/** Пароль от 9 символов (требование владельца; сверху пароль Caddy и ограничение попыток). */
export const PASSWORD_MIN_LENGTH = 9;
/** Верхний предел ограничивает цену расчёта хэша. */
export const PASSWORD_MAX_LENGTH = 256;

export function isValidUserName(name: string): boolean {
  return USER_NAME_PATTERN.test(name);
}

/** Имя, как его ввели при входе: без пробелов по краям, строчными. */
export function normalizeUserName(name: string): string {
  return name.trim().toLowerCase();
}

/** Что не так с паролем; годится: null. Длина в символах Unicode. */
export function passwordProblem(password: string): string | null {
  const length = codePointLength(password);
  if (length < PASSWORD_MIN_LENGTH) return `Пароль короче ${PASSWORD_MIN_LENGTH} символов`;
  if (length > PASSWORD_MAX_LENGTH) return `Пароль длиннее ${PASSWORD_MAX_LENGTH} символов`;
  return null;
}
