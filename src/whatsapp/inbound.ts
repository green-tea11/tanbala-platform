import {
  getContentType,
  isLidUser,
  isPnUser,
  normalizeMessageContent,
  proto,
  toNumber,
  type WAMessage,
  type WAMessageContent,
  type WAMessageKey,
} from 'baileys';
import type {
  ChatIdentity,
  InboundMessage,
  Jid,
  MediaRef,
  MessageContent,
  OwnMessage,
  PhoneDigits,
  WaMessageId,
} from '../domain/types.js';
import { jidToPhone, normalizeJid, phoneToJid } from './jid.js';

/**
 * Почему сообщение пропущено без обработки.
 * service: не личный чат (группа, статус, рассылка, канал) или нет адреса.
 * protocol: служебное (удаление, правка, реакция, голос в опросе, звонок, заглушка Baileys, кроме
 * CIPHERTEXT) или без годного ID.
 * not_allowlisted: закрытый режим включён, а номер собеседника не из TEST_ALLOWLIST, не определён
 * или совпал с номером самого бота.
 * before_link: отправлено до привязки номера к боту или без годного времени в 'append'.
 * self: чат с самим собой; manager: чат с менеджером.
 * undecryptable: заглушка CIPHERTEXT: сообщение не расшифровалось или ждёт пересылки с телефона.
 */
export type IgnoreReason =
  'service' | 'manager' | 'self' | 'protocol' | 'before_link' | 'not_allowlisted' | 'undecryptable';

/**
 * Пропуски, после которых адаптер всё равно запоминает чат в known_chats (этап 8):
 * JID и время последней активности, без текста.
 */
export type TracedIgnoreReason = Extract<
  IgnoreReason,
  'before_link' | 'not_allowlisted' | 'undecryptable'
>;

/**
 * Результат разбора одного сообщения из события messages.upsert.
 * stale: сообщение клиента после привязки, но старше порога простоя: без ответа, в список для менеджера.
 * ignore с chatJid (before_link, not_allowlisted, undecryptable): JID только для known_chats; в лог
 * его не писать, пропуски считать только счётчиком.
 */
export type WaEvent =
  | { readonly type: 'client'; readonly message: InboundMessage }
  | { readonly type: 'stale'; readonly message: InboundMessage }
  | { readonly type: 'own'; readonly message: OwnMessage }
  | { readonly type: 'ignore'; readonly reason: Exclude<IgnoreReason, TracedIgnoreReason> }
  | {
      readonly type: 'ignore';
      readonly reason: TracedIgnoreReason;
      /** JID чата после нормализации (как key.remoteJid после cleanMessage). */
      readonly chatJid: Jid;
      /** Время сообщения, мс UTC; если времени нет или оно испорчено, момент разбора (nowMs). */
      readonly tsMs: number;
    };

/** Что нужно для разбора, кроме самого сообщения. Собирает адаптер (whatsapp/connection.ts). */
export interface ClassifyContext {
  /**
   * Адреса менеджера: номер и @lid (дополненный через lidMapping.getLIDForPN). Можно с суффиксом
   * устройства: разбор сравнивает их после whatsapp/jid.normalizeJid и с remoteJid, и с remoteJidAlt.
   */
  readonly managerJids: ReadonlySet<Jid>;
  /** Адреса самого номера бота: sock.user.id и sock.user.lid, можно как есть, с суффиксом устройства. */
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
  /**
   * Закрытый режим: номера из TEST_ALLOWLIST; null, если режим выключен. Номер самого бота (из selfJids)
   * не проходит, даже если попал в список.
   */
  readonly testAllowlist: ReadonlySet<PhoneDigits> | null;
  /**
   * Номер собеседника, который адаптер определил до разбора (key.remoteJidAlt или
   * lidMapping.getPNForLID); null, если номер неизвестен. Нужен для чатов @lid: у адреса с номером
   * номер берётся из самого key.remoteJid. Для своих сообщений надёжнее getPNForLID(remoteJid):
   * remoteJidAlt Baileys rc14 берёт из первого найденного атрибута participant_*, sender_*,
   * peer_recipient_* (extractAddressingContext), и там может оказаться адрес самого бота.
   */
  readonly chatPhone: PhoneDigits | null;
  /**
   * type события messages.upsert: 'notify' живые сообщения, 'append' офлайн-очередь и история.
   * Без годного времени живое сообщение получает nowMs (иначе лид молча пропадёт), а из 'append'
   * уходит в before_link: старое ли оно, неизвестно.
   */
  readonly upsertType: 'notify' | 'append';
}

/** Лимит текста сообщения в символах (кодовых точках) после NFKC: длиннее обрезается. */
export const MAX_TEXT_CHARS = 4096;

/** Лимит имени из профиля WhatsApp в символах после NFKC. */
export const MAX_PUSH_NAME_CHARS = 64;

/** Тип голосовых WhatsApp: подставляется вместо пустого или подозрительного типа от отправителя. */
const DEFAULT_VOICE_MIME_TYPE = 'audio/ogg; codecs=opus';
const MAX_MIME_TYPE_CHARS = 100;
/** Тип/подтип и параметры «; ключ=значение» только из безопасных символов. */
const MIME_TYPE_PATTERN = /^[a-z0-9.+-]+\/[a-z0-9.+-]+(?:; ?[a-z0-9.+-]+=[a-z0-9.+-]+)*$/i;

/** ID сообщения: печатные символы ASCII без пробелов, не длиннее 128. Иное значит испорченное сообщение. */
const MESSAGE_ID_PATTERN = /^[\x21-\x7E]{1,128}$/;

const MS_PER_SECOND = 1000;

/** Заглушка «не расшифровалось или ждёт пересылки с телефона»: считается и попадает в known_chats. */
const CIPHERTEXT_STUB = proto.WebMessageInfo.StubType.CIPHERTEXT;

/** Управляющие Cc и невидимые Cf: zero-width, U+FEFF, мягкий перенос, bidi U+202A..U+202E и U+2066..U+2069. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;
/** То же, но перенос строки в тексте клиента остаётся. */
const INVISIBLE_EXCEPT_NEWLINE = /(?!\n)[\p{Cc}\p{Cf}]/gu;

/**
 * Служебное содержимое: удаления и правки (protocolMessage; обёртку editedMessage снимает
 * normalizeMessageContent), реакции, голоса в опросах и ответы на события, отметки «оставить»
 * и «закрепить», зашифрованные правки, звонки.
 */
const SERVICE_CONTENT_KEYS = [
  'protocolMessage',
  'reactionMessage',
  'encReactionMessage',
  'pollUpdateMessage',
  'encEventResponseMessage',
  'keepInChatMessage',
  'pinInChatMessage',
  'secretEncryptedMessage',
  'call',
  'callLogMesssage',
  'bcallMessage',
  'scheduledCallCreationMessage',
  'scheduledCallEditMessage',
] as const satisfies readonly (keyof WAMessageContent)[];

/**
 * Разбирает сообщение Baileys: клиент, старое сообщение клиента, своё сообщение с номера бота или пропуск.
 * Чистая функция: не ходит в сеть и в базу. Порядок проверок:
 * 1. Не личный чат (группы, статусы, рассылки, каналы) или нет адреса => 'service': whatsapp/jid.normalizeJid
 *    проверяет тем же белым списком, что isPersonalJid, и снимает суффикс устройства.
 *    Здесь JID уже нормализован (cleanMessage: c.us => s.whatsapp.net), сырой адрес отсекает shouldIgnoreJid сокета.
 * 2. Служебное сообщение (кроме CIPHERTEXT) или без годного ID => 'protocol': до закрытого режима, служебное
 *    не считается перепиской.
 * 3. Закрытый режим: номер чата не из TEST_ALLOWLIST, не определён или это номер самого бота => 'not_allowlisted',
 *    и для клиентских, и для своих сообщений: такие чаты бот не сохраняет, не читает, не отмечает прочитанными,
 *    не отвечает, не уведомляет менеджера и не меняет их статус (решение владельца). В событии только JID и время
 *    для known_chats.
 * 4. Отправлено до привязки => 'before_link', тоже с JID и временем. Без годного времени живое сообщение ('notify')
 *    получает nowMs, иначе лид молча пропадёт; из 'append' => 'before_link' (безопаснее промолчать).
 * 5. Чат с самим собой => 'self'; чат менеджера (по remoteJid или remoteJidAlt) => 'manager'.
 * 6. Заглушка CIPHERTEXT (не расшифровалось или ждёт пересылки с телефона) => 'undecryptable' с JID и временем:
 *    для счётчика и known_chats, содержимое не берётся.
 * 7. key.fromMe => 'own' с содержимым, в том числе из 'append' и независимо от возраста: сообщение менеджера
 *    с телефона, отправленное, пока бот был выключен, всё равно включает перехват чата. Бот это или человек,
 *    решает pipeline/takeover.ts; своё сообщение никогда не идёт в LLM как реплика клиента и не запускает ответ.
 * 8. Сообщение клиента старше порога простоя (nowMs - tsMs > backlogMaxAgeMs) => 'stale', иначе 'client'.
 * Тип upsert важен только для сообщений без годного времени (п. 4): после привязки обрабатывается всё,
 * в том числе 'append' после разрывов связи.
 * Текст и pushName недоверенные: без Cc (кроме \n в тексте) и Cf, NFKC, лимит длины после NFKC.
 * TODO(этап 8): при переходе TEST_MODE true => false граница: момент перехода записывается в app_state, и сообщения чатов не из списка, отправленные раньше, не обрабатываются (как before_link); сценарий запуска в main.ts.
 */
export function classifyUpsert(message: WAMessage, context: ClassifyContext): WaEvent {
  const key: WAMessageKey | null | undefined = message.key;
  const chatJid = key?.remoteJid ? normalizeJid(key.remoteJid) : null;
  if (!key || chatJid === null) return { type: 'ignore', reason: 'service' };
  const content = normalizeMessageContent(message.message);
  const waId = messageIdOf(key.id);
  const undecryptable = message.messageStubType === CIPHERTEXT_STUB;
  if (waId === null || (!undecryptable && isServiceMessage(message, key, content))) {
    return { type: 'ignore', reason: 'protocol' };
  }
  const tsMs = messageTimeMs(message, context);
  const traced = (reason: TracedIgnoreReason): WaEvent => ({
    type: 'ignore',
    reason,
    chatJid,
    tsMs: tsMs ?? context.nowMs,
  });
  if (!isAllowlisted(chatJid, context)) return traced('not_allowlisted');
  if (tsMs === null || tsMs < context.linkedAtMs) return traced('before_link');
  const altJid = key.remoteJidAlt ? normalizeJid(key.remoteJidAlt) : null;
  const fromMe = key.fromMe === true;
  // У своего сообщения remoteJidAlt может оказаться адресом самого бота, а не собеседника.
  if (matchesAny(context.selfJids, fromMe ? [chatJid] : [chatJid, altJid])) {
    return { type: 'ignore', reason: 'self' };
  }
  if (matchesAny(context.managerJids, [chatJid, altJid])) {
    return { type: 'ignore', reason: 'manager' };
  }
  if (undecryptable) return traced('undecryptable');
  const parsedContent = contentOf(content, waId);
  if (fromMe) return { type: 'own', message: { waId, chatJid, content: parsedContent, tsMs } };
  const inbound: InboundMessage = {
    waId,
    identity: identityOf(chatJid, altJid, context.chatPhone),
    pushName: cleanUntrusted(message.pushName, INVISIBLE, MAX_PUSH_NAME_CHARS),
    content: parsedContent,
    tsMs,
  };
  const stale = tsMs < context.nowMs - context.backlogMaxAgeMs;
  return { type: stale ? 'stale' : 'client', message: inbound };
}

function messageIdOf(raw: string | null | undefined): WaMessageId | null {
  return typeof raw === 'string' && MESSAGE_ID_PATTERN.test(raw) ? (raw as WaMessageId) : null;
}

/**
 * Служебное ли сообщение: заглушка Baileys (messageStubType не 0; CIPHERTEXT разбирается до вызова),
 * служебное содержимое или нет содержимого вовсе. Исключение: просмотр один раз, недоступный связанному
 * устройству (key.isViewOnce без содержимого): это настоящее сообщение собеседника.
 */
function isServiceMessage(
  message: WAMessage,
  key: WAMessageKey,
  content: WAMessageContent | undefined,
): boolean {
  if (message.messageStubType) return true;
  if (!content) return key.isViewOnce !== true;
  if (getContentType(content) === undefined) return true;
  return SERVICE_CONTENT_KEYS.some((name) => Boolean(content[name]));
}

/** messageTimestamp в секундах (number или Long) => мс; нет времени, не число или не больше 0 => null. */
function timestampMsOf(raw: WAMessage['messageTimestamp']): number | null {
  if (raw === null || raw === undefined) return null;
  const seconds = toNumber(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * MS_PER_SECOND : null;
}

/**
 * Время сообщения, мс UTC. Без годного времени живое сообщение ('notify') получает nowMs, иначе лид
 * молча пропадёт; из 'append' (офлайн-очередь, история) null: неизвестно, не старое ли оно.
 */
function messageTimeMs(message: WAMessage, context: ClassifyContext): number | null {
  const tsMs = timestampMsOf(message.messageTimestamp);
  if (tsMs !== null) return tsMs;
  return context.upsertType === 'notify' ? context.nowMs : null;
}

/**
 * Закрытый режим: номер берётся из самого адреса с номером, для @lid номер определяет адаптер.
 * Номер самого бота не проходит никогда: иначе, попади он в список, прошли бы свои сообщения
 * из чужих чатов (remoteJidAlt своего сообщения может оказаться адресом бота).
 */
function isAllowlisted(chatJid: Jid, context: ClassifyContext): boolean {
  if (context.testAllowlist === null) return true;
  const phone = jidToPhone(chatJid) ?? context.chatPhone;
  if (phone === null || isOwnPhone(phone, context.selfJids)) return false;
  return context.testAllowlist.has(phone);
}

/** Номер самого бота по адресам с номером из selfJids; суффикс устройства не мешает. */
function isOwnPhone(phone: PhoneDigits, selfJids: ReadonlySet<Jid>): boolean {
  return Array.from(selfJids).some((jid) => jidToPhone(jid) === phone);
}

/** Есть ли среди адресов сообщения адрес из набора; адреса набора сравниваются после нормализации. */
function matchesAny(known: ReadonlySet<Jid>, candidates: readonly (Jid | null)[]): boolean {
  const normalized = new Set(Array.from(known, (jid) => normalizeJid(jid)));
  return candidates.some((jid) => jid !== null && normalized.has(jid));
}

/**
 * Отвечать на remoteJid; @lid и адрес с номером берутся из remoteJid и remoteJidAlt по их серверу. Адреса с номером
 * в ключе нет, а номер определил адаптер (getPNForLID): адрес с номером из него, иначе закрытый режим outbox
 * не узнал бы номер чата и отсёк ответ уже после оплаченных вызовов API.
 */
function identityOf(chatJid: Jid, altJid: Jid | null, chatPhone: PhoneDigits | null): ChatIdentity {
  const addresses = altJid === null ? [chatJid] : [chatJid, altJid];
  const pnJid = addresses.find((jid) => isPnUser(jid)) ?? null;
  return {
    replyJid: chatJid,
    lidJid: addresses.find((jid) => isLidUser(jid)) ?? null,
    pnJid: pnJid ?? (chatPhone === null ? null : phoneToJid(chatPhone)),
  };
}

/** Текст (conversation или extendedTextMessage.text), голосовое (audioMessage с ptt) или 'other'. */
function contentOf(content: WAMessageContent | undefined, waId: WaMessageId): MessageContent {
  const rawText = content?.conversation || content?.extendedTextMessage?.text;
  const text = cleanUntrusted(rawText, INVISIBLE_EXCEPT_NEWLINE, MAX_TEXT_CHARS);
  if (text !== null) return { kind: 'text', text };
  const audio = content?.audioMessage;
  if (audio?.ptt !== true) return { kind: 'other' };
  return {
    kind: 'voice',
    media: mediaRefOf(waId),
    mimeType: voiceMimeType(audio.mimetype),
    seconds: voiceSeconds(audio.seconds),
  };
}

/** Ключ голосового в памяти адаптера: ID сообщения, для остального кода непрозрачный. */
function mediaRefOf(waId: WaMessageId): MediaRef {
  const ref: string = waId;
  return ref as MediaRef;
}

function voiceMimeType(raw: string | null | undefined): string {
  return typeof raw === 'string' && raw.length <= MAX_MIME_TYPE_CHARS && MIME_TYPE_PATTERN.test(raw)
    ? raw
    : DEFAULT_VOICE_MIME_TYPE;
}

/** Длительность со слов отправителя: целое число секунд не меньше 0, иначе null. */
function voiceSeconds(raw: number | null | undefined): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

/**
 * Недоверенный текст (сообщение, имя из профиля): удалить Cc и Cf, затем NFKC, обрезать пробелы,
 * затем лимит в символах. Удаление идёт до NFKC: после неё могла бы остаться ненормализованная
 * последовательность (e, U+200B, U+0301), а сама NFKC символов Cc и Cf не порождает (проверено
 * по всем кодовым точкам в Node 22). Лимит после NFKC: она удлиняет строку (U+FDFA даёт 18 символов).
 * Пусто после очистки или не строка: null.
 */
function cleanUntrusted(
  raw: string | null | undefined,
  invisible: RegExp,
  maxChars: number,
): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = limitChars(raw.replace(invisible, '').normalize('NFKC').trim(), maxChars);
  return cleaned === '' ? null : cleaned;
}

/** Обрезает до maxChars кодовых точек, не разрывая суррогатные пары. */
function limitChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return Array.from(text).slice(0, maxChars).join('').trimEnd();
}
