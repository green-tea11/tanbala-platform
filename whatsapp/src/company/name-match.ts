import { normalizeName } from './normalize-name.js';

// Сравнение названий и городов для подтверждения компании без вопроса (решение владельца 30.10.2026): клиент сам
// назвал компанию, а поиск по его словам нашёл карточку с тем же названием в том же городе.

/** Порог похожести названий: от него название карточки считается тем, что назвал клиент. */
export const MIN_CONFIRM_SIMILARITY = 0.9;

/** Слова, которые в названии города не в счёт: «г. Алматы», «город Астана». */
const CITY_PREFIXES: ReadonlySet<string> = new Set(['г', 'город']);

/**
 * Другие написания городов, которые понимает проверка новой компании (коды 2ГИС из контракта INTERNAL_API.md) и
 * прежнее название Алматы: сводятся к названию по-русски после нормализации.
 */
const CITY_SPELLINGS: ReadonlyMap<string, string> = new Map([
  ['almaty', 'алматы'],
  ['алма ата', 'алматы'],
  ['astana', 'астана'],
  ['shymkent', 'шымкент'],
  ['karaganda', 'караганда'],
  ['aktobe', 'актобе'],
  ['atyrau', 'атырау'],
  ['pavlodar', 'павлодар'],
  ['ust kamenogorsk', 'усть каменогорск'],
]);

/**
 * Название для сравнения: часть до первой запятой (хвост карточки 2ГИС «Т-Банк, банк» не в счёт, так нормализует и
 * проект B), без регистра, «ё», кавычек, знаков, форм собственности и пробелов (normalizeName).
 */
function nameKey(name: string): readonly string[] {
  const head = name.split(',')[0] ?? '';
  return Array.from(normalizeName(head).replaceAll(' ', ''));
}

/** Расстояние Левенштейна между двумя строками по символам Unicode. */
function editDistance(first: readonly string[], second: readonly string[]): number {
  let previous = Array.from({ length: second.length + 1 }, (_value, index) => index);
  first.forEach((char, row) => {
    const current = [row + 1];
    second.forEach((other, column) => {
      const replace = (previous[column] ?? 0) + (char === other ? 0 : 1);
      const remove = (previous[column + 1] ?? 0) + 1;
      const insert = (current[column] ?? 0) + 1;
      current.push(Math.min(replace, remove, insert));
    });
    previous = current;
  });
  return previous[second.length] ?? 0;
}

/**
 * Похожесть двух названий от 0 до 1: 1 минус расстояние Левенштейна, делённое на длину более длинного (после nameKey).
 * Название, пустое после нормализации (только «ТОО» или знаки), ни с чем не совпадает: 0.
 */
export function nameSimilarity(first: string, second: string): number {
  const a = nameKey(first);
  const b = nameKey(second);
  if (a.length === 0 || b.length === 0) return 0;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

function cityKey(city: string): string {
  const words = normalizeName(city)
    .split(' ')
    .filter((word) => word !== '' && !CITY_PREFIXES.has(word));
  const key = words.join(' ');
  return CITY_SPELLINGS.get(key) ?? key;
}

/** Один и тот же город: без регистра, «ё», знаков и «г.», с кодами 2ГИС. Пустой или неизвестный город: false. */
export function sameCity(first: string | null, second: string | null): boolean {
  if (first === null || second === null) return false;
  const a = cityKey(first);
  return a !== '' && a === cityKey(second);
}
