import type { Jid, PhoneDigits } from '../domain/types.js';

/** Номер из адреса с номером: цифры до «@» без суффиксов агента «_N» и устройства «:N». В адресе @lid номера нет. */
const PN_JID = /^(\d+)(?:_\d+)?(?::\d+)?@(?:s\.whatsapp\.net|hosted)$/;

/** Номер, который понимает поиск в проекте B: 7XXXXXXXXXX, ровно 11 цифр. */
const SEARCHABLE_PHONE = /^7\d{10}$/;

/**
 * Номер клиента для поиска компании (шаг б) и для проверки новой компании: цифры из адреса с номером вида
 * 7XXXXXXXXXX (11 цифр). Адреса нет, он вида @lid или номер другого вида => null: по такому не ищем.
 * Бренд PhoneDigits ставится здесь: номер только что проверен регулярным выражением (правило то же, что у
 * whatsapp/jid.jidToPhone, но адаптер WhatsApp ядру компании не нужен).
 */
export function searchPhone(pnJid: Jid | null): PhoneDigits | null {
  if (pnJid === null) return null;
  const digits = PN_JID.exec(pnJid)?.[1];
  return digits !== undefined && SEARCHABLE_PHONE.test(digits) ? (digits as PhoneDigits) : null;
}
