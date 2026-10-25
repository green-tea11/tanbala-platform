import type { Jid, PhoneDigits } from '../domain/types.js';
import { notImplemented } from '../shared/todo.js';

// Граница адресов: здесь сырые строки Baileys и номера приводятся к брендам Jid и PhoneDigits.

/**
 * JID WhatsApp из номера (MANAGER_WHATSAPP, номер клиента).
 * TODO(этап 2): результат вида <цифры>@s.whatsapp.net.
 */
export function phoneToJid(digits: PhoneDigits): Jid {
  return notImplemented('этап 2', 'whatsapp/jid.phoneToJid');
}

/**
 * Номер из JID. Для адреса @lid номера в JID нет: вернуть null, номер ищет WhatsAppInbox.resolvePhone.
 * TODO(этап 2): отбрасывать суффикс устройства «:N» перед @ (вида 7XXXXXXXXXX:0@s.whatsapp.net): так отвечает и lidMapping.getPNForLID.
 */
export function jidToPhone(jid: Jid): PhoneDigits | null {
  return notImplemented('этап 2', 'whatsapp/jid.jidToPhone');
}

/**
 * Белый список: личный ли это чат 1:1. Бот отвечает только в таких чатах, всё остальное пропускает
 * (группы, статусы, рассылки, каналы, боты, звонки, c.us и прочие серверы JID).
 * TODO(этап 2): true, только если сервер JID ровно один из личных: 's.whatsapp.net', 'lid', 'hosted', 'hosted.lid' (их же считает личными decode-wa-message в rc14).
 * TODO(этап 2): сырой адрес до нормализации видит только shouldIgnoreJid сокета: в messages.upsert JID уже нормализован (cleanMessage: c.us => s.whatsapp.net). Поэтому c.us отсекать в shouldIgnoreJid, а в inbound и перед каждой отправкой проверять тем же белым списком.
 */
export function isPersonalJid(rawJid: string): rawJid is Jid {
  return notImplemented('этап 2', 'whatsapp/jid.isPersonalJid');
}
