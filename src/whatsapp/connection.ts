import type { makeWASocket } from 'baileys';
import type {
  AppStateRepo,
  Clock,
  Logger,
  PairingGuard,
  WhatsAppGateway,
} from '../domain/ports.js';
import type { Jid, PhoneDigits, WaMessageId } from '../domain/types.js';
import { notImplemented } from '../shared/todo.js';
import type { WaEvent } from './inbound.js';

/** Зависимости подключения к WhatsApp. */
export interface WhatsAppDeps {
  /** WHATSAPP_SESSION_DIR: папка авторизации Baileys, даёт полный доступ к номеру. */
  sessionDir: string;
  logger: Logger;
  clock: Clock;
  /** Момент первой привязки номера: отсечка старых сообщений (whatsapp/inbound.ts). */
  appState: AppStateRepo;
  /** Не больше двух привязок по QR за 24 часа: третью попытку запрещает код. */
  pairingGuard: PairingGuard;
  /** MANAGER_WHATSAPP: из него и lidMapping.getLIDForPN собираются ClassifyContext.managerJids. */
  managerPhone: PhoneDigits | null;
  /** Закрытый режим: номера из TEST_ALLOWLIST; null, если режим выключен. */
  testAllowlist: ReadonlySet<PhoneDigits> | null;
  /** BACKLOG_MAX_AGE_HOURS в мс: порог для сообщений, пришедших за время простоя. */
  backlogMaxAgeMs: number;
  /**
   * Фабрика сокета для тестов. В рабочем режиме не передаётся: main не может импортировать Baileys
   * (границы модулей), сокет создаёт сам адаптер.
   */
  createSocket?: typeof makeWASocket;
  /** Получает каждое разобранное событие (whatsapp/inbound.ts). */
  onEvent(event: WaEvent): Promise<void>;
  /** Офлайн-очередь после подключения разобрана: можно отправить менеджеру список простоя (pipeline/backlog.ts). */
  onOfflineQueueDone(): Promise<void>;
  /**
   * Текст отправленного сообщения из outbound_ids для повторной отправки Baileys (getMessage).
   * Отдаёт текст, только если jid совпадает с outbound_ids.jid: по угаданному ID чужой чат его не получит.
   */
  getSentText(waId: WaMessageId, jid: Jid): Promise<string | null>;
}

/** Подключённый номер: шлюз для приложения плюс остановка. */
export type WhatsAppConnection = WhatsAppGateway & { stop(): Promise<void> };

/**
 * Подключает номер к WhatsApp через Baileys как связанное устройство и превращает события сокета в WaEvent.
 * Запускается только явно из main и только при WA_ENABLED=true (главный выключатель); импорт модуля ничего не делает.
 * TODO(этап 2, только с разрешения владельца): сокет через deps.createSocket ?? makeWASocket (тогда импорт значения); useMultiFileAuthState(sessionDir), событие creds.update => saveCreds.
 * TODO(этап 2): привязка по QR: если сессии нет (в creds нет me, номер не привязан), вызвать pairingGuard.tryBeginAttempt(clock.now()) ДО запуска сокета и первого QR; отказ => сокет не запускать, в лог время следующей попытки (сейчас + retryAfterMs), без цикла повторов. Одна попытка = один сеанс привязки: QR внутри него обновляется сам, новые QR попыткой не считаются (решение владельца: не больше двух попыток за 24 часа, третью запрещает код).
 * TODO(этап 2): version из fetchLatestBaileysVersion: функция берёт версию из ветки master Baileys на GitHub и при сбое молча отдаёт встроенную, поэтому при isLatest: false писать warn; если WhatsApp отклонит версию, сравнить с fetchLatestWaWebVersion.
 * TODO(этап 2): browser Browsers.ubuntu('Chrome'), по опыту сообщества (на 25.10.2026); 'Desktop' меняет тип клиента-компаньона.
 * TODO(этап 2): markOnlineOnConnect: false (иначе телефон не получает уведомлений), syncFullHistory: false, shouldSyncHistoryMessage: () => false.
 * TODO(этап 2): shouldIgnoreJid(jid) => !whatsapp/jid.isPersonalJid(jid): это единственное место, где виден сырой адрес до нормализации.
 * TODO(этап 2): QR брать из поля qr события connection.update и показывать только по команде владельца; printQRInTerminal в rc14 лишь предупреждает.
 * TODO(этап 2): риск rc14 (на 25.10.2026): с 28.07.2026 привязка нового номера проходит не всегда (companion_reg_refresh, issue #2737, PR #2765 не слит); частые неудачи WhatsApp наказывает блокировкой привязки, поэтому лимит попыток в pairingGuard.
 * TODO(этап 2): граница старых сообщений: connection.update с isNewLogin: true (первая или новая привязка по QR) => appState.setLinkedAtMs(clock.now()) с перезаписью; обычные переподключения границу не сдвигают. ClassifyContext.linkedAtMs брать из appState.getLinkedAtMs(). Всё, что отправлено до привязки, пропускается полностью (решение владельца).
 * TODO(этап 2): linkedAtMs нет в базе, а в сессии уже есть creds.me (номер привязан раньше) => отказ в запуске с понятной ошибкой: база потеряна или подменена, граница неизвестна.
 * TODO(этап 8): часы VPS синхронизировать (chrony): при отстающих или спешащих часах свежие сообщения уйдут в before_link или stale.
 * TODO(этап 2): до classifyUpsert определить номер собеседника для ClassifyContext.chatPhone: из key.remoteJidAlt (адрес с номером) или через sock.signalRepository.lidMapping.getPNForLID, ответ пропустить через whatsapp/jid.jidToPhone; не определён => null (в закрытом режиме такой чат игнорируется). ClassifyContext собирать здесь: managerJids (managerPhone плюс @lid через getLIDForPN), selfJids, linkedAtMs, nowMs = clock.now(), backlogMaxAgeMs, testAllowlist.
 * TODO(этап 2): messages.upsert: type 'notify' живые, 'append' история и офлайн-очередь; из 'append' после привязки брать свои сообщения (перехват чата) и клиентские с дедупликацией по waId; отсечку по linkedAtMs и порогу простоя делает whatsapp/inbound.ts.
 * TODO(этап 2): все события сокета обрабатывать одной очередью строго по порядку (разбор асинхронный: getPNForLID). connection.update с receivedPendingNotifications: true => поставить onOfflineQueueDone в ту же очередь, чтобы flush списка простоя шёл после всех начатых разборов; плюс страховочный таймер, если признак не придёт.
 * TODO(этап 2): закрытый режим: пропуски 'not_allowlisted' писать в лог только счётчиком, без JID и номеров; события call, receipts, presence, contacts не обрабатывать и не логировать; rejectCall не вызывать никогда (сбросит звонок на телефоне компании); кэш голосовых заполнять только после события 'client' (чужие голосовые в память не попадают).
 * TODO(этап 2): закрытый режим: markRead и setTyping повторно проверяют номер чата по testAllowlist, не только отправка (outbox): чужой чат не получит ни отметки прочтения, ни статуса «печатает».
 * TODO(этап 2): getMessage(key) отдаёт getSentText(key.id, key.remoteJid); логгер Baileys: logger.child({ module: 'baileys' }, { level: 'warn' }).
 * TODO(этап 2): разрывы через whatsapp/reconnect.ts с признаком pairing (номер не привязан, pair-success не пришёл): истёкший QR (408) останавливает сеанс без переподключения; замок на папку сессии против второго экземпляра; на VPS права 700, новая привязка, сессию не копировать.
 * TODO(этап 2): newMessageId через generateMessageIDV2(sock.user.id); sendText через sendMessage(jid, { text, linkPreview: null }, { messageId }): иначе при пакете link-preview-js Baileys сам скачает ссылку из текста; перед отправкой повторить проверку isPersonalJid.
 * TODO(этап 2): resolvePhone через sock.signalRepository.lidMapping.getPNForLID, ответ пропустить через whatsapp/jid.jidToPhone; setTyping через sendPresenceUpdate('composing' | 'paused', jid).
 * TODO(этап 7): WAMessage голосового держать только в памяти (кэш с коротким TTL и потолком размера) под ключом MediaRef; downloadAudio качает потоком через downloadMediaMessage и обрывает на maxBytes; не нашлось => передача менеджеру; сырые WAMessage в базу не писать (по mediaKey и directPath можно расшифровать медиа).
 * TODO(этап 2): известные проблемы rc14 (на 25.10.2026): зависание буфера событий (issue #2810), только @lid без номера у пользователей с username (issue #2742).
 */
export function startWhatsApp(deps: WhatsAppDeps): Promise<WhatsAppConnection> {
  return notImplemented('этап 2', 'whatsapp/connection.startWhatsApp');
}
