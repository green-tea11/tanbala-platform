// Очистка недоверенных строк: имя из профиля WhatsApp, текст клиента, поля ответа внутреннего API почтового проекта.

/**
 * Управляющие Cc, невидимые Cf (zero-width, U+FEFF, мягкий перенос, bidi U+202A..U+202E и U+2066..U+2069) и
 * разрывы строки и абзаца Zl и Zp (U+2028, U+2029): в однострочном поле их быть не должно.
 */
export const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Для многострочного текста клиента: Cc и Cf, кроме переноса строки \n (Zl и Zp не трогаются, как и раньше). */
export const INVISIBLE_EXCEPT_NEWLINE = /(?!\n)[\p{Cc}\p{Cf}]/gu;

/**
 * Разрывы строк по Unicode (UTS #18, RL1.6): LF, VT, FF, CR, NEL и Zl, Zp (U+2028, U+2029); идущие подряд берутся
 * вместе. NFKC ни один из них не порождает (проверено по всем кодовым точкам в Node 22).
 */
const LINE_BREAKS = /[\n\v\f\r\x85\p{Zl}\p{Zp}]+/gu;

/**
 * Недоверенный текст (сообщение, имя из профиля, строка из API): удалить символы invisible, затем NFKC, обрезать
 * пробелы, затем лимит в символах. Удаление идёт до NFKC: после неё могла бы остаться ненормализованная
 * последовательность (e, U+200B, U+0301), а сама NFKC символов Cc, Cf, Zl и Zp не порождает (проверено
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

/**
 * Однострочное поле (название, город, рубрика, боль, цитата, тема письма, сайт и почта профиля): разрывы строк и
 * абзацев сначала становятся одним пробелом, чтобы слова по обе стороны не склеились, затем cleanUntrusted с
 * INVISIBLE. В результате нет ни переводов строк, ни U+2028 и U+2029. Пусто после очистки или не строка: null.
 */
export function cleanSingleLine(raw: string | null | undefined, maxChars: number): string | null {
  if (typeof raw !== 'string') return null;
  return cleanUntrusted(raw.replace(LINE_BREAKS, ' '), INVISIBLE, maxChars);
}

/** Обрезает до maxChars кодовых точек, не разрывая суррогатные пары. */
export function limitChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return Array.from(text).slice(0, maxChars).join('').trimEnd();
}
