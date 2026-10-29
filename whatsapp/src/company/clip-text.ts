/**
 * Короткий текст: без пробелов и переносов по краям, не длиннее maxChars знаков; нечего оставлять => null.
 * Режет по знакам, а не по кодовым единицам UTF-16: пара суррогатов (эмодзи) не рвётся пополам, иначе одинокая
 * половинка уронила бы кодирование адреса запроса к API. После обрезки пробелы на конце снова убираются.
 */
export function clipText(raw: string | null, maxChars: number): string | null {
  if (raw === null) return null;
  const text = Array.from(raw.trim()).slice(0, maxChars).join('').trimEnd();
  return text === '' ? null : text;
}
