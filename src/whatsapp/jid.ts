import type { Jid, PhoneDigits } from '../domain/types.js';

// Граница адресов: здесь сырые строки Baileys и номера приводятся к брендам Jid и PhoneDigits.

/** Сервер нормализованного адреса: с номером телефона или @lid. */
type CanonicalServer = 's.whatsapp.net' | 'lid';

/**
 * Белый список серверов личных чатов 1:1 (их же считает личными decode-wa-message в Baileys rc14)
 * и сервер, к которому адрес сводится при нормализации: hosted-варианты Baileys (cleanMessage)
 * переводит в s.whatsapp.net и lid. Map, а не объект: ключ вроде «constructor» не найдётся в прототипе.
 */
const PERSONAL_SERVERS: ReadonlyMap<string, CanonicalServer> = new Map([
  ['s.whatsapp.net', 's.whatsapp.net'],
  ['lid', 'lid'],
  ['hosted', 's.whatsapp.net'],
  ['hosted.lid', 'lid'],
]);

/** <пользователь>[_агент][:устройство]@<сервер>; пользователь, агент и устройство из цифр ASCII. */
const JID_PATTERN = /^(\d+)(?:_\d+)?(?::\d+)?@([a-z.]+)$/;

const DIGITS_ONLY = /^\d+$/;

/** Разобранный адрес личного чата. */
interface PersonalAddress {
  readonly user: string;
  readonly server: CanonicalServer;
}

function parsePersonal(raw: string): PersonalAddress | null {
  const match = JID_PATTERN.exec(raw);
  if (match === null) return null;
  const [, user = '', server = ''] = match;
  const canonical = PERSONAL_SERVERS.get(server);
  return canonical === undefined ? null : { user, server: canonical };
}

/**
 * JID WhatsApp из номера (MANAGER_WHATSAPP, номер клиента): <цифры>@s.whatsapp.net.
 * Номер не из одних цифр ASCII значит ошибку в коде (бренд приведён без проверки): RangeError без номера в тексте.
 */
export function phoneToJid(digits: PhoneDigits): Jid {
  if (!DIGITS_ONLY.test(digits)) {
    throw new RangeError('phoneToJid: номер должен состоять только из цифр');
  }
  return `${digits}@s.whatsapp.net` as Jid;
}

/**
 * Номер из JID без суффикса устройства «:N» и агента «_N» (так отвечает и lidMapping.getPNForLID).
 * Для адреса @lid номера в JID нет: null, номер ищет WhatsAppInbox.resolvePhone.
 */
export function jidToPhone(jid: Jid): PhoneDigits | null {
  const address = parsePersonal(jid);
  return address?.server === 's.whatsapp.net' ? (address.user as PhoneDigits) : null;
}

/**
 * Белый список: личный ли это чат 1:1. Бот отвечает только в таких чатах, всё остальное пропускает
 * (группы, статусы, рассылки, каналы, боты, звонки, c.us и прочие серверы JID).
 * true, только если сервер ровно один из личных ('s.whatsapp.net', 'lid', 'hosted', 'hosted.lid'),
 * а пользователь из цифр; суффиксы устройства и агента допустимы: так выглядят сырые адреса в shouldIgnoreJid.
 * Сырой адрес до нормализации видит только shouldIgnoreJid сокета: в messages.upsert JID уже нормализован
 * (cleanMessage: c.us => s.whatsapp.net). Поэтому c.us отсекается в shouldIgnoreJid, а в inbound и перед
 * каждой отправкой адрес проверяется тем же белым списком.
 */
export function isPersonalJid(rawJid: string): rawJid is Jid {
  return parsePersonal(rawJid) !== null;
}

/**
 * Адрес личного чата без суффиксов устройства и агента, hosted-варианты сведены к s.whatsapp.net и lid
 * (как key.remoteJid после cleanMessage в Baileys). Так сравниваются адреса менеджера, самого бота и чата.
 * Не личный чат: null.
 */
export function normalizeJid(rawJid: string): Jid | null {
  const address = parsePersonal(rawJid);
  return address === null ? null : (`${address.user}@${address.server}` as Jid);
}
