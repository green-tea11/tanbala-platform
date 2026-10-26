import type { ChatId, ChatStatus } from '../domain/types.js';

/** Сколько чатов и уведомлений на одной странице списка. */
export const LIST_PAGE_SIZE = 30;
/** Сколько сообщений переписки на одной странице чата. */
export const HISTORY_PAGE_SIZE = 50;

/** Пометка после действия: фиксированный набор, чужой текст из адреса на страницу не попадает. */
export type NoticeKey = 'sent' | 'returned' | 'already_bot';

const NOTICE_KEYS: readonly NoticeKey[] = ['sent', 'returned', 'already_bot'];
const CHAT_STATUSES: readonly ChatStatus[] = ['bot', 'manager'];
/** Целое без нулей в начале; до 15 цифр, чтобы число оставалось точным. */
const ID_PATTERN = /^[1-9]\d{0,14}$/;
/** Номер страницы: до миллиона, дальше страниц не бывает. */
const PAGE_PATTERN = /^[1-9]\d{0,5}$/;

/** Значение параметра запроса. Повтор параметра (массив), отсутствие и не строка дают null. */
function queryValue(query: unknown, name: string): string | null {
  if (typeof query !== 'object' || query === null || !Object.hasOwn(query, name)) return null;
  const value: unknown = (query as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

/** Номер страницы списка из ?page=; неверный или отсутствующий => 1. */
export function parsePage(query: unknown): number {
  const value = queryValue(query, 'page');
  return value !== null && PAGE_PATTERN.test(value) ? Number(value) : 1;
}

/** Фильтр списка чатов из ?status=; любое значение кроме bot и manager игнорируется. */
export function parseStatusFilter(query: unknown): ChatStatus | undefined {
  const value = queryValue(query, 'status');
  return CHAT_STATUSES.find((status) => status === value);
}

/** Курсор «показать раньше» из ?before=: ID сообщения; неверный => нет курсора. */
export function parseBeforeId(query: unknown): number | undefined {
  const value = queryValue(query, 'before');
  return value !== null && ID_PATTERN.test(value) ? Number(value) : undefined;
}

/** Пометка из ?notice=: только из набора, иначе null. */
export function parseNotice(query: unknown): NoticeKey | null {
  const value = queryValue(query, 'notice');
  return NOTICE_KEYS.find((key) => key === value) ?? null;
}

/**
 * ID чата из адреса /chats/:id. Граница панели: строка из адреса становится ChatId только после проверки
 * формата (целое без нулей в начале, до 15 цифр); существование чата проверяет репозиторий.
 */
export function parseChatId(raw: unknown): ChatId | null {
  return typeof raw === 'string' && ID_PATTERN.test(raw) ? (Number(raw) as ChatId) : null;
}
