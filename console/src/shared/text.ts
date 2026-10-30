/**
 * Управляющие символы (кроме перевода строки и табуляции) и символы смены направления текста: в сообщениях
 * от почты и бота они не нужны, а смена направления может перевернуть видимый смысл строки.
 */
// Управляющие символы здесь и ищутся: правило no-control-regex для этих выражений не к месту.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g;
// eslint-disable-next-line no-control-regex
const ANY_CONTROL = /[\u0000-\u001F\u007F]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F]/;
const LINE_BREAKS = /[\t\r\n]+/g;
const SPACES = /\s{2,}/g;

/** Есть ли в строке управляющие символы (с allowNewlines перевод строки \n допускается). */
export function hasControlChars(text: string, allowNewlines = false): boolean {
  return (allowNewlines ? CONTROL_EXCEPT_NEWLINE : ANY_CONTROL).test(text);
}

/** Длина строки в символах Unicode (эмодзи = 1), как считает бот длину заметки. */
export function codePointLength(text: string): number {
  let length = 0;
  for (const _char of text) length += 1;
  return length;
}

/** Первые max символов Unicode строки: суррогатная пара не разрывается. */
export function cutCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join('');
}

/**
 * Одна строка для показа: без управляющих символов и смены направления, переводы строк и табуляция становятся
 * пробелом, пробелы схлопываются, по краям обрезаются, длина не больше max символов.
 */
export function cleanLine(text: string, max: number): string {
  const flat = text.replace(CONTROL_CHARS, '').replace(LINE_BREAKS, ' ').replace(SPACES, ' ');
  return cutCodePoints(flat.trim(), max);
}

/** Переводы строк Windows и старого Mac приводятся к \n: так считают длину бот и почта. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}
