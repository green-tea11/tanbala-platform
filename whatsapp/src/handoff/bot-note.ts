/**
 * Заметка для бота при возврате чата из панели (решение владельца 29.10.2026). Её пишет менеджер, клиент её не видит;
 * она хранится в чате до следующей передачи и идёт в промпт ответа и проверки отдельным доверенным блоком. Текст
 * доверенный, но чистится одинаково в панели и в сервисе передачи: без управляющих и невидимых символов, с пределом
 * длины.
 */

/** Наибольшая длина заметки, в символах Unicode. */
export const BOT_NOTE_MAX_LENGTH = 1000;

/** Управляющие, невидимые (Cf), суррогаты, частные и неназначенные символы, кроме перевода строки. */
const HIDDEN = /[^\P{C}\n]/gu;

/** Три перевода строки и больше подряд: не больше одной пустой строки. */
const BLANK_LINES = /\n{3,}/g;

/** Замена угловых скобок (‹ и ›): заметка не закроет свой блок в промпте и не откроет чужой. */
const SAFE_LEFT_ANGLE = String.fromCharCode(0x2039);
const SAFE_RIGHT_ANGLE = String.fromCharCode(0x203a);

/**
 * Заметка после чистки: NFC, переводы строк браузера (CRLF, CR) как LF, табуляция пробелом, без управляющих
 * и невидимых символов, не больше одной пустой строки подряд, без пробелов по краям. Пустая => пустая строка.
 */
export function cleanBotNote(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(HIDDEN, '')
    .replace(BLANK_LINES, '\n\n')
    .trim();
}

/** Что не так с очищенной заметкой: длиннее BOT_NOTE_MAX_LENGTH символов. null: годится. */
export function botNoteProblem(cleaned: string): string | null {
  return [...cleaned].length > BOT_NOTE_MAX_LENGTH
    ? `Заметка длиннее ${BOT_NOTE_MAX_LENGTH} символов: сократите её`
    : null;
}

/** Текст заметки для промпта: угловые скобки заменены, как в словах клиента. */
export function noteForPrompt(text: string): string {
  return text.replaceAll('<', SAFE_LEFT_ANGLE).replaceAll('>', SAFE_RIGHT_ANGLE);
}
