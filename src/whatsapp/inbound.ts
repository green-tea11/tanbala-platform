import type { WAMessage } from 'baileys';
import type { InboundMessage, Jid, OwnMessage } from '../domain/types.js';
import { notImplemented } from '../shared/todo.js';

/** Почему сообщение пропущено без обработки. */
export type IgnoreReason = 'service' | 'manager' | 'self' | 'protocol' | 'stale';

/** Результат разбора одного сообщения из события messages.upsert. */
export type WaEvent =
  | { readonly type: 'client'; readonly message: InboundMessage }
  | { readonly type: 'own'; readonly message: OwnMessage }
  | { readonly type: 'ignore'; readonly reason: IgnoreReason };

/** Что нужно для разбора, кроме самого сообщения. */
export interface ClassifyContext {
  /** Адреса менеджера: номер и @lid (дополненный через lidMapping.getLIDForPN). */
  readonly managerJids: ReadonlySet<Jid>;
  /** Адреса самого номера бота: sock.user.id и sock.user.lid. */
  readonly selfJids: ReadonlySet<Jid>;
  /** Текущее время, мс UTC. */
  readonly nowMs: number;
  /** Порог свежести для сообщений клиента, мс. */
  readonly freshMs: number;
}

/**
 * Разбирает сообщение Baileys: клиент, своё сообщение с номера бота или пропуск.
 * Чистая функция: не ходит в сеть и в базу.
 * TODO(этап 2): только личные чаты по whatsapp/jid.isPersonalJid(key.remoteJid); остальное => ignore 'service'. Здесь JID уже нормализован (cleanMessage: c.us => s.whatsapp.net), сырой адрес отсекает shouldIgnoreJid сокета.
 * TODO(этап 2): protocolMessage, реакции, правки, удаления, звонки => ignore 'protocol'.
 * TODO(этап 2): key.fromMe => 'own' вместе с содержимым, в том числе из type 'append': сообщение менеджера с телефона, отправленное, пока бот был выключен, всё равно включает перехват чата. Бот это или человек, решает pipeline/takeover.ts.
 * TODO(этап 2): своё сообщение никогда не идёт в LLM как реплика клиента и не запускает ответ; в истории остаётся с ролью assistant (автор bot или human_phone).
 * TODO(этап 2): порог freshMs только для сообщений клиента: старше => ignore 'stale', чтобы после привязки рабочего номера бот не ответил во все старые чаты.
 * TODO(этап 2): messageTimestamp в rc14 имеет тип number | Long | null и хранится в секундах: перевести в number и умножить на 1000, иначе фильтр 'stale' отбросит все входящие.
 * TODO(этап 2): адреса: replyJid = key.remoteJid; в key.remoteJidAlt второй адрес: при addressingMode 'lid' это номер, при 'pn' адрес @lid. Тип адреса определять через isLidUser и isPnUser. Номера нет => позже resolvePhone.
 * TODO(этап 2): managerJids и selfJids сравнивать и с remoteJid, и с remoteJidAlt после jidNormalizedUser; сообщение менеджера => ignore 'manager', чат с самим собой => ignore 'self'.
 * TODO(этап 2): текст и pushName недоверенные: удалить символы Cc (кроме \n в тексте) и Cf (zero-width, U+FEFF, bidi U+202A..U+202E и U+2066..U+2069), нормализовать NFKC, лимит длины ставить ПОСЛЕ NFKC.
 * TODO(этап 2): audioMessage с ptt => content 'voice' с MediaRef от адаптера; прочие медиа => content 'other'.
 */
export function classifyUpsert(message: WAMessage, context: ClassifyContext): WaEvent {
  return notImplemented('этап 2', 'whatsapp/inbound.classifyUpsert');
}
