// Очистка недоверенных строк: имя из профиля WhatsApp, текст клиента, поля ответа внутреннего API почтового проекта.

/** Управляющие Cc и невидимые Cf: zero-width, U+FEFF, мягкий перенос, bidi U+202A..U+202E и U+2066..U+2069. */
export const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

/** То же, но перенос строки в тексте клиента остаётся. */
export const INVISIBLE_EXCEPT_NEWLINE = /(?!\n)[\p{Cc}\p{Cf}]/gu;

/**
 * Недоверенный текст (сообщение, имя из профиля, строка из API): удалить Cc и Cf (invisible), затем NFKC, обрезать
 * пробелы, затем лимит в символах. Удаление идёт до NFKC: после неё могла бы остаться ненормализованная
 * последовательность (e, U+200B, U+0301), а сама NFKC символов Cc и Cf не порождает (проверено
 * по всем кодовым точкам в Node 22). Лимит после NFKC: она удлиняет строку (U+FDFA даёт 18 символов).
 * Пусто после очистки или не строка: null.
 */
export function cleanUntrusted(
  raw: string | null | undefined,
  invisible: RegExp,
  maxChars: number,
): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = limitChars(raw.replace(invisible, '').normalize('NFKC').trim(), maxChars);
  return cleaned === '' ? null : cleaned;
}

/** Обрезает до maxChars кодовых точек, не разрывая суррогатные пары. */
export function limitChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return Array.from(text).slice(0, maxChars).join('').trimEnd();
}
