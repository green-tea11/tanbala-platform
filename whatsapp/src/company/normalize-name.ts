/**
 * Формы собственности. Для сравнения названий они отбрасываются, а в имени профиля отдельное слово из этого списка
 * (без учёта регистра) считается признаком компании.
 */
export const OWNERSHIP_FORMS: readonly string[] = [
  'ТОО',
  'ИП',
  'АО',
  'ООО',
  'ЗАО',
  'ОАО',
  'LLP',
  'LLC',
  'Ltd',
  'JSC',
  'Inc',
  'GmbH',
];

const OWNERSHIP_WORDS: ReadonlySet<string> = new Set(
  OWNERSHIP_FORMS.map((form) => form.toLowerCase()),
);

/** Всё, кроме букв, знаков к ним и цифр: кавычки, скобки, точки, запятые, дефисы и пробелы. */
const NOT_WORD = /[^\p{L}\p{M}\p{N}]+/u;

/**
 * Название для сравнения: нижний регистр, ё => е, без кавычек, знаков препинания и форм собственности, пробелы
 * схлопнуты в один. По результату решают, искали ли уже по этому названию (ChatCompanyState.lookedUpName).
 * Название из одних форм собственности и знаков даёт пустую строку.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .split(NOT_WORD)
    .filter((word) => word !== '' && !OWNERSHIP_WORDS.has(word))
    .join(' ');
}
