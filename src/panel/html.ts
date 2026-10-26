/**
 * Фрагмент HTML, который уже безопасен: собран через markup`` или помечен raw(). Только такой фрагмент выводится
 * как есть; любая строка, попавшая в markup``, экранируется. Так текст из WhatsApp не может стать разметкой.
 */
export class SafeHtml {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

/** Что можно подставить в markup``: строки экранируются, пустые значения ничего не выводят. */
export type Fragment =
  SafeHtml | string | number | boolean | null | undefined | readonly Fragment[];

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Экранирование текста для содержимого элемента и для значения атрибута в кавычках. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

function renderFragment(fragment: Fragment): string {
  if (fragment instanceof SafeHtml) return fragment.value;
  if (typeof fragment === 'string') return escapeHtml(fragment);
  if (typeof fragment === 'number') return String(fragment);
  if (Array.isArray(fragment)) return fragment.map(renderFragment).join('');
  return '';
}

/**
 * Шаблон HTML с экранированием всех подстановок: markup`<td>${name}</td>`. Подстановка SafeHtml (результат другого
 * markup``) и массивы фрагментов выводятся без повторного экранирования; null, undefined и булевы значения пусты.
 * Атрибуты в шаблонах всегда в двойных кавычках: экранирование рассчитано на них.
 * Тег назван не html: Prettier форматирует шаблоны с тегом html как разметку и меняет пробелы внутри текста.
 */
export function markup(strings: TemplateStringsArray, ...values: readonly Fragment[]): SafeHtml {
  const parts = strings.map((part, index) => part + renderFragment(values[index]));
  return new SafeHtml(parts.join(''));
}

/** Помечает строку безопасной без экранирования. Только для своих констант, не для данных из WhatsApp. */
export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

/** Горизонтальная табуляция, перевод строки и возврат каретки: единственные управляющие символы, нужные тексту. */
const KEPT_CONTROLS: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0d]);

/** Управляющие символы C0 и C1, DEL, переопределение направления текста и изоляты (подмена вида строки). */
function isHiddenCodePoint(codePoint: number): boolean {
  if (KEPT_CONTROLS.has(codePoint)) return false;
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

/**
 * Текст из WhatsApp перед выводом: без управляющих символов и без символов, меняющих направление текста
 * (имя могло бы выглядеть как чужой статус или номер). Переводы строк и табуляция остаются.
 * Экранирование делает markup``.
 */
export function cleanText(text: string): string {
  return Array.from(text)
    .filter((char) => !isHiddenCodePoint(char.codePointAt(0) ?? 0))
    .join('');
}
