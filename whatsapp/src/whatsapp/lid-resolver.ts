import type { WAMessageKey } from 'baileys';
import type { Logger } from '../domain/ports.js';
import type { Jid, PhoneDigits } from '../domain/types.js';
import type { WaSocket } from './connection-types.js';
import { jidToPhone, normalizeJid, phoneToJid } from './jid.js';

/** Адреса и номера одного сокета: сопоставление @lid и номера, адреса самого бота и менеджера. */
export interface LidResolver {
  /** Номер самого бота из sock.user.id; null, пока номер не привязан. */
  botPhone(): PhoneDigits | null;
  /** Адреса самого бота: sock.user.id и sock.user.lid без суффикса устройства. */
  selfJids(): ReadonlySet<Jid>;
  /**
   * Номер собеседника для ClassifyContext.chatPhone: у адреса с номером он в самом remoteJid, у @lid в remoteJidAlt
   * или через getPNForLID. У своих сообщений remoteJidAlt может оказаться адресом самого бота, поэтому только
   * getPNForLID. Номер самого бота отбрасывается: он не собеседник.
   */
  chatPhone(key: WAMessageKey): Promise<PhoneDigits | null>;
  /** Номер для адреса: из самого адреса с номером или через getPNForLID для @lid; иначе null. */
  phoneOf(rawJid: string): Promise<PhoneDigits | null>;
  /** Адреса менеджера: номер и @lid, если WhatsApp его сообщил; номер не задан => пустой набор. */
  managerJids(phone: PhoneDigits | null): Promise<ReadonlySet<Jid>>;
}

/** Адрес личного чата без суффикса устройства (whatsapp/jid.normalizeJid); не строка или не личный чат => null. */
export function jidOf(raw: string | null | undefined): Jid | null {
  return typeof raw === 'string' ? normalizeJid(raw) : null;
}

/** Разбор адресов для сокета; sock.user читается при каждом вызове (в Baileys это геттер, номер появляется после входа). */
export function createLidResolver(
  sock: Pick<WaSocket, 'user' | 'signalRepository'>,
  logger: Logger,
): LidResolver {
  const mapping = sock.signalRepository.lidMapping;
  const lookup = async (query: () => Promise<string | null>): Promise<string | null> => {
    try {
      return await query();
    } catch (error: unknown) {
      // Текст ошибки сопоставления может содержать адрес: в лог только тип ошибки.
      logger.warn(
        { err: error instanceof Error ? error.name : typeof error },
        'Не удалось сопоставить адрес @lid и номер',
      );
      return null;
    }
  };
  const phoneForLid = async (lid: Jid): Promise<PhoneDigits | null> => {
    const pnJid = jidOf(await lookup(() => mapping.getPNForLID(lid)));
    return pnJid === null ? null : jidToPhone(pnJid);
  };
  const botPhone = (): PhoneDigits | null => {
    const self = jidOf(sock.user?.id);
    return self === null ? null : jidToPhone(self);
  };
  return {
    botPhone,
    selfJids: () => jidSet([sock.user?.id, sock.user?.lid]),
    async chatPhone(key: WAMessageKey): Promise<PhoneDigits | null> {
      const chatJid = jidOf(key.remoteJid);
      if (chatJid === null) return null;
      const altJid = key.fromMe === true ? null : jidOf(key.remoteJidAlt);
      const known = jidToPhone(chatJid) ?? (altJid === null ? null : jidToPhone(altJid));
      const phone = known ?? (await phoneForLid(chatJid));
      return phone === botPhone() ? null : phone;
    },
    async phoneOf(rawJid: string): Promise<PhoneDigits | null> {
      const jid = jidOf(rawJid);
      if (jid === null) return null;
      return jidToPhone(jid) ?? (await phoneForLid(jid));
    },
    async managerJids(phone: PhoneDigits | null): Promise<ReadonlySet<Jid>> {
      if (phone === null) return new Set();
      const pnJid = phoneToJid(phone);
      return jidSet([pnJid, await lookup(() => mapping.getLIDForPN(pnJid))]);
    },
  };
}

function jidSet(raw: readonly (string | null | undefined)[]): ReadonlySet<Jid> {
  return new Set(raw.map(jidOf).filter((jid) => jid !== null));
}
