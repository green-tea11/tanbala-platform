import type { ChatIdentity, PhoneDigits } from '../domain/types.js';
import { jidToPhone } from '../whatsapp/jid.js';

/**
 * Закрытый режим (TEST_ALLOWLIST): номер чата из его адреса с номером должен быть в списке; чат только с @lid
 * (номер неизвестен) не проходит. Одно правило для outbox (перед отправкой) и конвейера (до оплачиваемых вызовов
 * API, иначе ответ отсекался бы уже после них). Режим выключен (null) => любой чат.
 */
export function isChatAllowlisted(
  allowlist: ReadonlySet<PhoneDigits> | null,
  identity: ChatIdentity,
): boolean {
  if (allowlist === null) return true;
  const phone = identity.pnJid === null ? null : jidToPhone(identity.pnJid);
  return phone !== null && allowlist.has(phone);
}
