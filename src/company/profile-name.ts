import { clipText } from './clip-text.js';
import { OWNERSHIP_FORMS } from './normalize-name.js';

/** Длиннее имя для поиска не берётся: так же ограничивает название проект B. */
const MAX_NAME_CHARS = 200;

/** Форма собственности отдельным словом: слева и справа не буква и не цифра. Регистр не важен. */
const OWNERSHIP_WORD = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${OWNERSHIP_FORMS.join('|')})(?![\\p{L}\\p{N}])`,
  'iu',
);

/** Имя в кавычках «...» или "...": между кавычками есть хоть один знак, не только пробелы. */
const QUOTED_NAME = /«[^»]*\S[^»]*»|"[^"]*\S[^"]*"/u;

/** Что известно об аккаунте, чтобы выбрать имя для поиска (шаг в). Строки недоверенные. */
export interface ProfileNameInput {
  /** Подтверждённое имя бизнес-аккаунта (verifiedName последнего сообщения). */
  readonly verifiedName: string | null;
  /** Имя из профиля WhatsApp (pushName последнего сообщения). */
  readonly pushName: string | null;
  /** Вид аккаунта из шага а; null: бизнес-профиль не запрашивали. */
  readonly profileKind: 'business' | 'personal' | 'unknown' | null;
}

function looksLikeCompany(name: string): boolean {
  return OWNERSHIP_WORD.test(name) || QUOTED_NAME.test(name);
}

/**
 * Имя профиля для поиска компании по названию (шаг в). verifiedName, если оно не пустое; иначе pushName, но только
 * у бизнес-аккаунта или если в нём есть признак компании (форма собственности отдельным словом либо кавычки);
 * обычное человеческое имя искать нельзя. Не длиннее 200 знаков; подходящего имени нет => null.
 */
export function profileNameForSearch(input: ProfileNameInput): string | null {
  const verified = clipText(input.verifiedName, MAX_NAME_CHARS);
  if (verified !== null) return verified;
  const pushName = clipText(input.pushName, MAX_NAME_CHARS);
  if (pushName === null) return null;
  return input.profileKind === 'business' || looksLikeCompany(pushName) ? pushName : null;
}
