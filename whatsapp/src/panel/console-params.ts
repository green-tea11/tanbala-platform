import type { ChatSearch, CompanyLinkState, ConsoleChatFilter } from '../domain/console.js';
import type { ChatStatus, InterestLevel, ManagerNotificationStatus } from '../domain/types.js';
import { badRequest } from './console-http.js';
import { consoleText } from './console-json.js';

// Разбор параметров запросов консоли. В отличие от старой панели неверное значение не игнорируется, а даёт 400:
// консоль — программа, ошибка в адресе должна быть видна сразу.

/** Целое без нулей в начале; до 15 цифр, чтобы число оставалось точным (как parseChatId). */
const ID_PATTERN = /^[1-9]\d{0,14}$/;
/** Номер страницы: до миллиона. */
const PAGE_PATTERN = /^[1-9]\d{0,5}$/;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Поиск по имени или номеру: не длиннее этого. */
export const SEARCH_MAX_LENGTH = 64;
/** Цифры номера в поиске: от 3 до 15. */
const PHONE_DIGITS = /^\d{3,15}$/;
/** Разделители, которые люди ставят в номер: пробелы, плюс, скобки, дефисы, точки. */
const PHONE_SEPARATORS = /[\s+().-]/g;
/** Расход за период не больше 62 дней (контракт). */
export const SPEND_MAX_DAYS = 62;
const DAY_MS = 24 * 60 * 60_000;

const CHAT_STATUSES: readonly ChatStatus[] = ['bot', 'manager'];
const LEVELS: readonly InterestLevel[] = ['cold', 'warm', 'hot'];
const COMPANY_STATES: readonly CompanyLinkState[] = ['confirmed', 'candidate', 'none'];
const NOTIFICATION_STATUSES: readonly ManagerNotificationStatus[] = [
  'pending',
  'sent',
  'no_manager',
  'skipped_limit',
  'failed',
];

/**
 * Значение параметра запроса: нет или пусто => null; повтор параметра (массив) или не строка => 400.
 * Пустое значение (status=) значит «не задано», как в примерах контракта.
 */
export function queryValue(query: unknown, name: string): string | null {
  if (typeof query !== 'object' || query === null || !Object.hasOwn(query, name)) return null;
  const value: unknown = (query as Record<string, unknown>)[name];
  if (typeof value !== 'string') throw badRequest(`Параметр ${name}: одно значение строкой.`);
  return value === '' ? null : value;
}

/** Значение из белого списка; нет => undefined, чужое => 400 с перечнем допустимых. */
function oneOfQuery<T extends string>(
  query: unknown,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = queryValue(query, name);
  if (value === null) return undefined;
  const found = allowed.find((item) => item === value);
  if (found === undefined) throw badRequest(`Параметр ${name}: одно из ${allowed.join(', ')}.`);
  return found;
}

/** Номер страницы ?page= (с 1); нет => 1, неверный => 400. */
export function parseConsolePage(query: unknown): number {
  const value = queryValue(query, 'page');
  if (value === null) return 1;
  if (!PAGE_PATTERN.test(value)) throw badRequest('Параметр page: целое число от 1.');
  return Number(value);
}

/** Курсор ?before= (ID сообщения); нет => undefined, неверный => 400. */
export function parseBefore(query: unknown): number | undefined {
  const value = queryValue(query, 'before');
  if (value === null) return undefined;
  if (!ID_PATTERN.test(value)) throw badRequest('Параметр before: ID сообщения, целое число от 1.');
  return Number(value);
}

/** ?companyId= для связей чатов с компаниями; нет => undefined, неверный => 400. */
export function parseCompanyId(query: unknown): number | undefined {
  const value = queryValue(query, 'companyId');
  if (value === null) return undefined;
  if (!ID_PATTERN.test(value)) throw badRequest('Параметр companyId: целое число от 1.');
  return Number(value);
}

export function parseNotificationStatus(query: unknown): ManagerNotificationStatus | undefined {
  return oneOfQuery(query, 'status', NOTIFICATION_STATUSES);
}

/** Строчные, ПРОПИСНЫЕ и С заглавной: SQLite сравнивает регистр кириллицы точно, поэтому варианты считаются здесь. */
function nameVariantsOf(text: string): readonly string[] {
  const lower = text.toLocaleLowerCase('ru');
  const capitalized = lower.replace(
    /(^|\s)(\p{L})/gu,
    (_match, space: string, letter: string) => `${space}${letter.toLocaleUpperCase('ru')}`,
  );
  return [text, lower, text.toLocaleUpperCase('ru'), capitalized];
}

/** Поиск ?q=: имя или цифры номера. Скрытые символы убираются, пусто => нет поиска, длиннее 64 => 400. */
export function parseSearch(query: unknown): ChatSearch | undefined {
  const raw = queryValue(query, 'q');
  if (raw === null) return undefined;
  const text = consoleText(raw).trim();
  if ([...text].length > SEARCH_MAX_LENGTH) {
    throw badRequest(`Параметр q: не длиннее ${SEARCH_MAX_LENGTH} символов.`);
  }
  if (text === '') return undefined;
  const digits = text.replace(PHONE_SEPARATORS, '');
  return { nameVariants: nameVariantsOf(text), digits: PHONE_DIGITS.test(digits) ? digits : null };
}

/** ?waiting=1 — только ждущие ответа; 0 или нет — все; другое => 400. */
function parseWaiting(query: unknown): boolean {
  const value = oneOfQuery(query, 'waiting', ['0', '1'] as const);
  return value === '1';
}

/** Фильтр списка чатов: status, level, company, waiting, q. */
export function parseChatFilter(query: unknown, nowMs: number): ConsoleChatFilter {
  const status = oneOfQuery(query, 'status', CHAT_STATUSES);
  const level = oneOfQuery(query, 'level', LEVELS);
  const company = oneOfQuery(query, 'company', COMPANY_STATES);
  const search = parseSearch(query);
  return {
    nowMs,
    waitingOnly: parseWaiting(query),
    ...(status === undefined ? {} : { status }),
    ...(level === undefined ? {} : { level }),
    ...(company === undefined ? {} : { company }),
    ...(search === undefined ? {} : { search }),
  };
}

/** Период расхода: дни по Алматы ГГГГ-ММ-ДД включительно. */
export interface DayRange {
  readonly from: string;
  readonly to: string;
}

/** День ГГГГ-ММ-ДД, который существует в календаре; мс UTC полуночи этого дня или null. */
function dayStartMs(value: string): number | null {
  const match = DAY_PATTERN.exec(value);
  if (match === null) return null;
  const [, year = '', month = '', day = ''] = match;
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

/** ?from=&to= обязательны, from не позже to, не больше 62 дней. */
export function parseDayRange(query: unknown): DayRange {
  const from = queryValue(query, 'from');
  const to = queryValue(query, 'to');
  const fromMs = from === null ? null : dayStartMs(from);
  const toMs = to === null ? null : dayStartMs(to);
  if (from === null || to === null || fromMs === null || toMs === null) {
    throw badRequest('Параметры from и to: дни в виде ГГГГ-ММ-ДД.');
  }
  if (fromMs > toMs) throw badRequest('Параметр from не может быть позже to.');
  if ((toMs - fromMs) / DAY_MS + 1 > SPEND_MAX_DAYS) {
    throw badRequest(`Период не больше ${SPEND_MAX_DAYS} дней.`);
  }
  return { from, to };
}
