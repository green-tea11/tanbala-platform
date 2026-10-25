import type { WAMessage } from 'baileys';
import type { InboundMessage, Jid, OwnMessage, PhoneDigits } from '../domain/types.js';
import { notImplemented } from '../shared/todo.js';

/**
 * Почему сообщение пропущено без обработки.
 * before_link: отправлено до привязки номера к боту.
 * not_allowlisted: закрытый режим включён, а номер собеседника не из TEST_ALLOWLIST или не определён.
 */
export type IgnoreReason =
  'service' | 'manager' | 'self' | 'protocol' | 'before_link' | 'not_allowlisted';

/**
 * Результат разбора одного сообщения из события messages.upsert.
 * stale: сообщение клиента после привязки, но старше порога простоя: без ответа, в список для менеджера.
 */
export type WaEvent =
  | { readonly type: 'client'; readonly message: InboundMessage }
  | { readonly type: 'stale'; readonly message: InboundMessage }
  | { readonly type: 'own'; readonly message: OwnMessage }
  | { readonly type: 'ignore'; readonly reason: IgnoreReason };

/** Что нужно для разбора, кроме самого сообщения. Собирает адаптер (whatsapp/connection.ts). */
export interface ClassifyContext {
  /** Адреса менеджера: номер и @lid (дополненный через lidMapping.getLIDForPN). */
  readonly managerJids: ReadonlySet<Jid>;
  /** Адреса самого номера бота: sock.user.id и sock.user.lid. */
  readonly selfJids: ReadonlySet<Jid>;
  /**
   * Момент первой привязки номера, мс UTC (AppStateRepo.getLinkedAtMs). Всё, что отправлено раньше,
   * пропускается полностью: без ответа и без отметки для менеджера (решение владельца).
   */
  readonly linkedAtMs: number;
  /** Текущее время, мс UTC: от него считается возраст сообщения для порога простоя. */
  readonly nowMs: number;
  /** BACKLOG_MAX_AGE_HOURS в мс: сообщение клиента старше порога => событие stale. */
  readonly backlogMaxAgeMs: number;
  /** Закрытый режим: номера из TEST_ALLOWLIST; null, если режим выключен. */
  readonly testAllowlist: ReadonlySet<PhoneDigits> | null;
  /**
   * Номер собеседника, который адаптер определил до разбора (key.remoteJidAlt или
   * lidMapping.getPNForLID); null, если номер неизвестен.
   */
  readonly chatPhone: PhoneDigits | null;
}

/**
 * Разбирает сообщение Baileys: клиент, старое сообщение клиента, своё сообщение с номера бота или пропуск.
 * Чистая функция: не ходит в сеть и в базу.
 * TODO(этап 2): только личные чаты по whatsapp/jid.isPersonalJid(key.remoteJid); остальное => ignore 'service'. Здесь JID уже нормализован (cleanMessage: c.us => s.whatsapp.net), сырой адрес отсекает shouldIgnoreJid сокета.
 * TODO(этап 2): закрытый режим (testAllowlist не null) проверять сразу после отсева групп и рассылок, раньше всего остального: chatPhone нет в списке или он null (адрес @lid без сопоставления) => ignore 'not_allowlisted'. Касается и клиентских, и своих сообщений: на рабочем номере люди продолжают переписку сами, такие чаты бот не сохраняет, не читает, не отмечает прочитанными, не отвечает, не уведомляет менеджера и не меняет их статус (решение владельца).
 * TODO(этап 8): при переходе TEST_MODE true => false граница: момент перехода записывается в app_state, и сообщения чатов не из списка, отправленные раньше, не обрабатываются (как before_link); сценарий запуска в main.ts.
 * TODO(этап 2): protocolMessage, реакции, правки, удаления, звонки => ignore 'protocol'.
 * TODO(этап 2): сообщения клиента и свои с tsMs < linkedAtMs => ignore 'before_link': старые чаты рабочего номера бот пропускает полностью: не отвечает, не отмечает для менеджера и не отмечает прочитанными (решение владельца). Проверка раньше разбора содержимого.
 * TODO(этап 2): после привязки сообщение клиента с nowMs - tsMs > backlogMaxAgeMs (пришло за время простоя и старше порога BACKLOG_MAX_AGE_HOURS) => 'stale': без ответа и без отметки прочтения, в список для менеджера (pipeline/backlog.ts); не старше порога => обычный 'client'.
 * TODO(этап 2): после привязки обрабатывается всё, в том числе type 'append' после разрывов связи.
 * TODO(этап 2): key.fromMe после привязки => 'own' вместе с содержимым, в том числе из 'append' и независимо от возраста: сообщение менеджера с телефона, отправленное, пока бот был выключен, всё равно включает перехват чата. Бот это или человек, решает pipeline/takeover.ts.
 * TODO(этап 2): своё сообщение никогда не идёт в LLM как реплика клиента и не запускает ответ; в истории остаётся с ролью assistant (автор bot или human_phone).
 * TODO(этап 2): messageTimestamp в rc14 имеет тип number | Long | null и хранится в секундах: перевести в number и умножить на 1000, иначе сравнение с linkedAtMs отбросит все входящие; нет времени => ignore 'before_link' (безопаснее промолчать).
 * TODO(этап 2): адреса: replyJid = key.remoteJid; в key.remoteJidAlt второй адрес: при addressingMode 'lid' это номер, при 'pn' адрес @lid. Тип адреса определять через isLidUser и isPnUser.
 * TODO(этап 2): managerJids и selfJids сравнивать и с remoteJid, и с remoteJidAlt после jidNormalizedUser; сообщение менеджера => ignore 'manager', чат с самим собой => ignore 'self'.
 * TODO(этап 2): текст и pushName недоверенные: удалить символы Cc (кроме \n в тексте) и Cf (zero-width, U+FEFF, bidi U+202A..U+202E и U+2066..U+2069), нормализовать NFKC, лимит длины ставить ПОСЛЕ NFKC.
 * TODO(этап 2): audioMessage с ptt => content 'voice' с MediaRef от адаптера; прочие медиа => content 'other'.
 */
export function classifyUpsert(message: WAMessage, context: ClassifyContext): WaEvent {
  return notImplemented('этап 2', 'whatsapp/inbound.classifyUpsert');
}
