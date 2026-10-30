import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  fetchLatestBaileysVersion,
  generateMessageIDV2,
  makeWASocket,
  useMultiFileAuthState,
  type BaileysEventMap,
  type ConnectionState,
  type WAConnectionState,
  type WAVersion,
} from 'baileys';
import type { PairingDecision } from '../domain/ports.js';
import type { Jid, WaMessageId } from '../domain/types.js';
import {
  LinkBoundaryMissingError,
  PairingLimitError,
  type LoadedAuthState,
  type WaSocket,
  type WhatsAppConnection,
  type WhatsAppDeps,
  type WhatsAppStopReason,
} from './connection-types.js';
import { createWhatsAppContacts, type ContactsSocket } from './contacts.js';
import { classifyUpsert } from './inbound.js';
import { isPersonalJid } from './jid.js';
import { createLidResolver, type LidResolver } from './lid-resolver.js';
import { createMessageIntake, type MessageIntake } from './message-intake.js';
import {
  createOfflineQueueWatch,
  type OfflineQueueSource,
  type OfflineQueueWatch,
} from './offline-queue.js';
import { createQrPresenter } from './qr.js';
import { createReconnectPolicy, type ReconnectPolicy } from './reconnect-policy.js';
import { decideOnDisconnect } from './reconnect.js';
import { buildSocketConfig, fetchVersionWithTimeout } from './socket-config.js';
import { createVoiceStore, createWhatsAppAudioDownload, type VoiceStore } from './voice-media.js';

export type {
  FetchedVersion,
  HistoryChat,
  LidMapping,
  LoadedAuthState,
  WaSocket,
  WhatsAppAppState,
  WhatsAppConnection,
  WhatsAppDeps,
  WhatsAppStopReason,
} from './connection-types.js';
export { LinkBoundaryMissingError, PairingLimitError } from './connection-types.js';

/** Граница привязки сдвигается назад на столько: запас на расхождение часов телефона, WhatsApp и сервера. */
export const LINKED_AT_SKEW_MS = 120_000;

/** Картинка QR по умолчанию: data/qr.png рядом с папкой сессии (в .gitignore). */
const DEFAULT_QR_FILE = 'qr.png';
/** Папка сессии даёт полный доступ к номеру: только владелец процесса. */
const SESSION_DIR_MODE = 0o700;

type Seams = Required<
  Pick<
    WhatsAppDeps,
    | 'createSocket'
    | 'loadAuthState'
    | 'fetchVersion'
    | 'presenter'
    | 'classify'
    | 'decide'
    | 'downloadMedia'
  >
>;

/** Кому шлюз может писать в закрытом режиме: клиенту из списка или ещё и менеджеру (только отправка). */
type Audience = 'client' | 'client_or_manager';

/** Один сокет: разбор адресов, офлайн-очередь, таймеры и отписка от его событий. */
interface Link {
  readonly sock: WaSocket;
  readonly resolver: LidResolver;
  /** Прерывает таймеры этого сокета: офлайн-очередь и стабильность связи. */
  readonly abort: AbortController;
  readonly offline: OfflineQueueWatch;
  unsubscribe: () => void;
}

/** Состояние одного запуска: меняется только внутри адаптера и наружу не отдаётся. */
interface Session {
  readonly deps: WhatsAppDeps;
  readonly seams: Seams;
  /** Прерывает паузу перед переподключением при остановке. */
  readonly abort: AbortController;
  readonly policy: ReconnectPolicy;
  readonly intake: MessageIntake;
  /** Голосовые клиентов в памяти до скачивания (whatsapp/voice-media.ts). */
  readonly voices: VoiceStore;
  /** Версия WhatsApp Web: запрашивается один раз на запуск. */
  version: Promise<WAVersion | null> | null;
  link: Link | null;
  /** Сокет открыт для привязки по QR: номер не привязан, pair-success не пришёл. */
  pairing: boolean;
  linkedAtMs: number | null;
  qrShown: boolean;
  /** Сохранение сессии своей цепочкой: не ждёт очередь событий и не теряется при её задержке. */
  credsSaving: Promise<void>;
  credsSaveFailed: boolean;
  stopped: boolean;
  /** Единая очередь событий всех сокетов этого запуска. */
  queue: Promise<void>;
  released: Promise<void> | null;
}

/** Переподключение без привязанной сессии: новый QR без нового запуска не показывается. */
class PairingEndedError extends Error {
  override name = 'PairingEndedError';
}

/** Последнее сохранение сессии не удалось: перечитанная с диска сессия была бы устаревшей. */
class SessionSaveFailedError extends Error {
  override name = 'SessionSaveFailedError';
}

/**
 * Подключает номер к WhatsApp через Baileys как связанное устройство и превращает события сокета в WaEvent.
 * Запускается только явно из main и только при WA_ENABLED=true (главный выключатель); импорт модуля ничего не делает.
 * Замок против второго экземпляра держит main (db acquireProcessLock), не адаптер.
 * Запуск: папка сессии с правами 700, сессия Baileys, версия WhatsApp Web (whatsapp/socket-config.ts, с таймаутом,
 * до засчёта попытки: сбой сети не сжигает попытку). Номер привязан, а момента привязки в базе нет =>
 * LinkBoundaryMissingError. Номер не привязан => pairingGuard.tryBeginAttempt до сокета; отказ =>
 * PairingLimitError. Попытка засчитывается только при запуске: переподключение без привязанной сессии
 * останавливается (pairing_timeout), новый QR только при новом запуске.
 * События: одна очередь строго по порядку (ev.process обработчик не ждёт). Синхронно при получении: creds.update
 * сохраняется своей цепочкой, пачки 'append' считаются для тишины офлайн-очереди, при закрытии буфер Baileys
 * выдаётся (end() его стирает). В очереди: qr => presenter.show только в сеансе привязки, в лог QR не пишется;
 * isNewLogin => граница привязки (сейчас минус LINKED_AT_SKEW_MS) с перезаписью, сбой записи => стоп;
 * messaging-history.set и messages.upsert => whatsapp/message-intake.ts; receivedPendingNotifications =>
 * onOfflineQueueDone после тишины (whatsapp/offline-queue.ts); close => whatsapp/reconnect-policy.ts.
 * События call, receipts, presence, contacts не обрабатываются; rejectCall не вызывается никогда (сбросит звонок
 * на телефоне компании).
 * Риски rc14 на 25.10.2026: привязка нового номера проходит не всегда (companion_reg_refresh, issue #2737, PR #2765
 * не слит), частые неудачи WhatsApp наказывает блокировкой привязки, поэтому лимит попыток; зависание буфера событий
 * (issue #2810) страхует таймер офлайн-очереди; у пользователей с username бывает только @lid без номера (issue #2742),
 * в закрытом режиме такой чат пропускается.
 * Шлюз (этап 3): sendText через sendMessage(jid, { text, linkPreview: null }, { messageId }), иначе при пакете
 * link-preview-js Baileys сам скачает ссылку из текста; setTyping через sendPresenceUpdate('composing' | 'paused');
 * markRead через readMessages. Перед каждым действием адрес проверяется isPersonalJid, а в закрытом режиме номер
 * чата по TEST_ALLOWLIST (отправка ещё и на номер менеджера): чужой чат не получит ни сообщения, ни отметки прочтения,
 * ни статуса «печатает». Не подключено => ошибка. Голосовые: сырой WAMessage только в памяти (whatsapp/voice-media.ts:
 * TTL и потолок, в базу не пишется), запоминается сразу после разбора и только для события client; downloadAudio
 * качает потоком только по directPath с сервера медиа WhatsApp (url отправителя не используется), обрывает на maxBytes
 * и по сроку; не нашлось => ошибка, конвейер ответит фразой про голосовое.
 * Профиль собеседника (определение компании): businessProfile и profilePhoto (whatsapp/contacts.ts) только читают
 * профиль и ничего не отправляют; адрес проверяется так же, как перед «печатает» (личный чат, в закрытом режиме номер
 * из TEST_ALLOWLIST), поэтому у чужого чата профиль не запрашивается; не прошёл проверку или нет подключения => failed
 * у businessProfile и null у profilePhoto, без обращения к WhatsApp.
 * TODO(этап 8): часы VPS синхронизировать (chrony): при отстающих или спешащих часах свежие сообщения уйдут в before_link или stale.
 * TODO(этап 8): на VPS права 700 на папку сессии, новая привязка, сессию не копировать.
 */
export async function startWhatsApp(deps: WhatsAppDeps): Promise<WhatsAppConnection> {
  const session = createSession(deps);
  try {
    await mkdir(deps.sessionDir, { recursive: true, mode: SESSION_DIR_MODE });
    await openSocket(session, 'start');
  } catch (error: unknown) {
    markStopped(session);
    await releaseResources(session);
    throw error;
  }
  return createConnection(session);
}

function createSession(deps: WhatsAppDeps): Session {
  const seams = resolveSeams(deps);
  const voices = createVoiceStore({ clock: deps.clock, download: seams.downloadMedia });
  const session: Session = {
    deps,
    seams,
    abort: new AbortController(),
    policy: createReconnectPolicy({ decide: seams.decide, clock: deps.clock, logger: deps.logger }),
    intake: createMessageIntake({
      deps,
      // Голосовое запоминается сразу после разбора и только для события client: до onEvent и конвейера.
      classify: (message, context) => {
        const event = seams.classify(message, context);
        voices.remember(message, event);
        return event;
      },
      onTooManyFailures: () => stopBySelf(session, 'handler_failed'),
    }),
    voices,
    version: null,
    link: null,
    pairing: false,
    linkedAtMs: null,
    qrShown: false,
    credsSaving: Promise.resolve(),
    credsSaveFailed: false,
    stopped: false,
    queue: Promise.resolve(),
    released: null,
  };
  return session;
}

function resolveSeams(deps: WhatsAppDeps): Seams {
  return {
    createSocket: deps.createSocket ?? makeWASocket,
    loadAuthState: deps.loadAuthState ?? useMultiFileAuthState,
    fetchVersion: deps.fetchVersion ?? fetchLatestBaileysVersion,
    presenter:
      deps.presenter ??
      createQrPresenter({
        output: process.stdout,
        pngPath: join(dirname(resolve(deps.sessionDir)), DEFAULT_QR_FILE),
        logger: deps.logger,
      }),
    classify: deps.classify ?? classifyUpsert,
    decide: deps.decide ?? decideOnDisconnect,
    downloadMedia: deps.downloadMedia ?? createWhatsAppAudioDownload(),
  };
}

function createConnection(session: Session): WhatsAppConnection {
  const contacts = createWhatsAppContacts({
    socketFor: (jid) => contactsSocket(session, jid),
    clock: session.deps.clock,
    logger: session.deps.logger,
    fetch: session.deps.fetchPhoto,
  });
  return {
    newMessageId: () => generateMessageIDV2(session.link?.sock.user?.id) as WaMessageId,
    sendText: async (jid, text, messageId) => {
      const sock = await allowedSocket(session, jid, 'client_or_manager');
      await sock.sendMessage(jid, { text, linkPreview: null }, { messageId });
    },
    setTyping: async (jid, on) => {
      const sock = await allowedSocket(session, jid, 'client');
      await sock.sendPresenceUpdate(on ? 'composing' : 'paused', jid);
    },
    markRead: async (jid, waIds) => {
      if (waIds.length === 0) return;
      const sock = await allowedSocket(session, jid, 'client');
      await sock.readMessages(waIds.map((id) => ({ remoteJid: jid, id, fromMe: false })));
    },
    downloadAudio: (media, maxBytes) => session.voices.download(media, maxBytes),
    resolvePhone: (jid) => session.link?.resolver.phoneOf(jid) ?? Promise.resolve(null),
    businessProfile: (jid) => contacts.businessProfile(jid),
    profilePhoto: (jid, maxBytes) => contacts.profilePhoto(jid, maxBytes),
    stop: () => stopSession(session),
  };
}

// Шлюз: отправка, «печатает», прочтение и голосовые.

/**
 * Сокет для действия в чате. Только личный чат (whatsapp/jid.isPersonalJid) и открытый запуск; в закрытом режиме
 * номер чата (для @lid через сопоставление) обязан быть в TEST_ALLOWLIST, отправка ещё и на номер менеджера:
 * вторая линия защиты после whatsapp/inbound.ts и messaging/outbox.ts. Номер не определён => отказ.
 */
async function allowedSocket(session: Session, jid: Jid, audience: Audience): Promise<WaSocket> {
  const link = connectedLink(session);
  if (!isPersonalJid(jid)) throw new Error('Адрес не личного чата: действие WhatsApp отменено');
  const { testAllowlist, managerPhone } = session.deps;
  if (testAllowlist === null) return link.sock;
  const phone = await link.resolver.phoneOf(jid);
  const manager = audience === 'client_or_manager' && phone !== null && phone === managerPhone;
  if (phone === null || (!testAllowlist.has(phone) && !manager)) {
    throw new Error('Закрытый режим: чат не из TEST_ALLOWLIST, действие WhatsApp отменено');
  }
  return link.sock;
}

/**
 * Сокет для чтения профиля собеседника (whatsapp/contacts.ts): та же проверка, что у «печатает» и отметки прочтения
 * (личный чат, в закрытом режиме номер из TEST_ALLOWLIST), поэтому профиль чужого чата не запрашивается. Не прошёл
 * проверку или нет подключения: null, и запроса нет.
 */
async function contactsSocket(session: Session, jid: Jid): Promise<ContactsSocket | null> {
  try {
    return await allowedSocket(session, jid, 'client');
  } catch {
    return null;
  }
}

function connectedLink(session: Session): Link {
  if (session.stopped || session.link === null) throw new Error('WhatsApp не подключён');
  return session.link;
}

// Сокет: сессия, версия, проверки до запуска, подписка на события.

async function openSocket(session: Session, mode: 'start' | 'reconnect'): Promise<void> {
  const { deps, seams } = session;
  await session.credsSaving;
  if (session.credsSaveFailed) throw new SessionSaveFailedError('Сессия WhatsApp не сохранилась');
  const auth = await seams.loadAuthState(deps.sessionDir);
  session.version ??= fetchVersionWithTimeout(seams.fetchVersion, deps);
  const version = await session.version;
  if (session.stopped) return;
  if (auth.state.creds.me?.id) useLinkedSession(session);
  else if (mode === 'start') beginPairing(session);
  else throw new PairingEndedError('Сеанс привязки закончился: новый QR только при новом запуске');
  const sock = seams.createSocket(buildSocketConfig({ state: auth.state, version, deps }));
  attachSocket(session, sock, auth);
}

/** Номер привязан раньше: граница старых сообщений обязана быть в базе. */
function useLinkedSession(session: Session): void {
  const linkedAtMs = session.deps.appState.getLinkedAtMs();
  if (linkedAtMs === null) throw new LinkBoundaryMissingError();
  session.linkedAtMs = linkedAtMs;
  session.pairing = false;
}

/** Сессии нет: попытка привязки засчитывается до сокета и первого QR. */
function beginPairing(session: Session): void {
  const { deps } = session;
  const nowMs = deps.clock.now();
  const decision = tryPairing(session, nowMs);
  if (!decision.ok) {
    const retryAt = new Date(nowMs + decision.retryAfterMs).toISOString();
    deps.logger.warn({ retryAt }, 'Привязка по QR запрещена: лимит попыток за 24 часа исчерпан');
    throw new PairingLimitError(nowMs + decision.retryAfterMs);
  }
  deps.logger.info({ attemptsLeft: decision.attemptsLeft }, 'Начата привязка номера по QR');
  session.pairing = true;
}

/** Сбой счётчика (например, испорченная копия) не обнуляет лимит: привязка не начинается, ошибка в лог. */
function tryPairing(session: Session, nowMs: number): PairingDecision {
  try {
    return session.deps.pairingGuard.tryBeginAttempt(nowMs);
  } catch (error: unknown) {
    session.deps.logger.error(
      { err: error },
      'Лимит привязок по QR не проверен: привязка не начата',
    );
    throw error;
  }
}

function attachSocket(session: Session, sock: WaSocket, auth: LoadedAuthState): void {
  const abort = new AbortController();
  const link: Link = {
    sock,
    resolver: createLidResolver(sock, session.deps.logger),
    abort,
    offline: createOfflineQueueWatch({
      clock: session.deps.clock,
      signal: abort.signal,
      finish: (source) => {
        enqueue(session, () => finishOfflineQueue(session, link, source));
      },
    }),
    unsubscribe: () => undefined,
  };
  session.link = link;
  link.unsubscribe = sock.ev.process((events) => {
    receive(session, link, auth, events);
  });
}

/** Синхронно при получении пачки: до того, как Baileys при закрытии сотрёт буфер событий. */
function receive(
  session: Session,
  link: Link,
  auth: LoadedAuthState,
  events: Partial<BaileysEventMap>,
): void {
  if (events['creds.update'] !== undefined) saveCredsInOrder(session, auth);
  if (events['messages.upsert']?.type === 'append') link.offline.appended();
  const connection = events['connection.update']?.connection;
  if (connection !== undefined) reportLinkState(session, connection);
  if (events['connection.update']?.connection === 'close') flushBuffer(session, link);
  enqueue(session, () => handleEvents(session, link, events));
}

function saveCredsInOrder(session: Session, auth: LoadedAuthState): void {
  session.credsSaving = session.credsSaving.then(async () => {
    try {
      await auth.saveCreds();
      session.credsSaveFailed = false;
    } catch (error: unknown) {
      session.credsSaveFailed = true;
      session.deps.logger.error({ err: error }, 'Не удалось сохранить сессию WhatsApp');
    }
  });
}

/**
 * Состояние сокета наблюдателю консоли (WhatsAppDeps.onConnectionUpdate): только сообщение наружу, без влияния на
 * подключение; исключение наблюдателя в лог именем ошибки.
 */
function reportLinkState(session: Session, connection: WAConnectionState): void {
  const observer = session.deps.onConnectionUpdate;
  if (observer === undefined) return;
  try {
    observer(connection === 'close' ? 'closed' : connection);
  } catch (error: unknown) {
    session.deps.logger.warn(
      { errorName: error instanceof Error ? error.name : typeof error },
      'Наблюдатель состояния WhatsApp упал: на подключение это не влияет',
    );
  }
}

/** Выдаёт накопленные Baileys события в очередь: end() и закрытие уничтожают буфер без выдачи. */
function flushBuffer(session: Session, link: Link): void {
  try {
    link.sock.ev.flush();
  } catch (error: unknown) {
    session.deps.logger.error({ err: error }, 'Накопленные события WhatsApp не выданы');
  }
}

// Очередь событий: пачки разбираются строго по порядку.

function enqueue(session: Session, task: () => Promise<void>): void {
  session.queue = session.queue.then(task).catch((error: unknown) => {
    session.deps.logger.error({ err: error }, 'Сбой разбора событий WhatsApp');
  });
}

async function guarded(
  session: Session,
  message: string,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (error: unknown) {
    session.deps.logger.error({ err: error }, message);
  }
}

async function handleEvents(
  session: Session,
  link: Link,
  events: Partial<BaileysEventMap>,
): Promise<void> {
  const update = events['connection.update'];
  if (update !== undefined) {
    await guarded(session, 'Сбой обработки состояния подключения', () =>
      handleConnectionState(session, link, update),
    );
  }
  const history = events['messaging-history.set'];
  if (history !== undefined) await session.intake.history(history.chats);
  const upsert = events['messages.upsert'];
  if (upsert !== undefined) {
    await guarded(session, 'Сбой разбора сообщений WhatsApp', () =>
      session.intake.messages(upsert, link.resolver, session.linkedAtMs),
    );
  }
  if (update?.receivedPendingNotifications === true && !session.stopped) link.offline.signalled();
  if (update?.connection === 'close' && link === session.link)
    await handleClose(session, link, update);
}

// Состояние подключения: QR, привязка, open, конец офлайн-очереди.

async function handleConnectionState(
  session: Session,
  link: Link,
  update: Partial<ConnectionState>,
): Promise<void> {
  if (typeof update.qr === 'string' && update.qr !== '') await showQr(session, update.qr);
  if (update.isNewLogin === true) await markLinked(session);
  if (update.connection === 'open') await markOpen(session, link);
}

async function showQr(session: Session, qr: string): Promise<void> {
  const { logger } = session.deps;
  if (session.stopped) return;
  if (!session.pairing) {
    logger.warn({}, 'WhatsApp прислал QR, но номер уже привязан: QR не показан');
    return;
  }
  session.qrShown = true;
  try {
    await session.seams.presenter.show(qr);
    logger.info({}, 'QR для привязки номера показан');
  } catch (error: unknown) {
    logger.error({ err: error }, 'Не удалось показать QR');
  }
}

/** pair-success: новая граница старых сообщений с перезаписью и запасом на расхождение часов. */
async function markLinked(session: Session): Promise<void> {
  const { deps } = session;
  session.pairing = false;
  const linkedAtMs = deps.clock.now() - LINKED_AT_SKEW_MS;
  try {
    deps.appState.setLinkedAtMs(linkedAtMs);
  } catch (error: unknown) {
    deps.logger.error(
      { err: error },
      'Момент привязки не записан в базу: без него сообщения не разобрать',
    );
    await stopBySelf(session, 'link_save_failed');
    return;
  }
  session.linkedAtMs = linkedAtMs;
  deps.logger.info({}, 'Номер привязан: граница старых сообщений обновлена');
}

async function markOpen(session: Session, link: Link): Promise<void> {
  session.pairing = false;
  session.deps.logger.info({}, 'Подключение к WhatsApp открыто');
  session.policy.opened(link.abort.signal);
  link.offline.opened();
  await clearQr(session);
}

async function clearQr(session: Session): Promise<void> {
  if (!session.qrShown) return;
  session.qrShown = false;
  await guarded(session, 'Не удалось удалить картинку QR', () => session.seams.presenter.clear());
}

/** Во время остановки список простоя не отправляется: офлайн-очередь дождётся следующего запуска. */
async function finishOfflineQueue(
  session: Session,
  link: Link,
  source: OfflineQueueSource,
): Promise<void> {
  if (session.stopped || !link.offline.complete(source)) return;
  if (source === 'fallback') {
    session.deps.logger.warn({}, 'Нет признака конца офлайн-очереди: список простоя по таймеру');
  }
  await guarded(session, 'Сбой после разбора офлайн-очереди', () =>
    session.deps.onOfflineQueueDone(),
  );
}

// Разрывы, переподключение и остановка.

async function handleClose(
  session: Session,
  link: Link,
  update: Partial<ConnectionState>,
): Promise<void> {
  link.abort.abort();
  link.unsubscribe();
  if (session.stopped) return;
  const outcome = session.policy.afterClose(update, session.pairing);
  if (outcome.action === 'stop') {
    await stopBySelf(session, outcome.reason);
    return;
  }
  await reconnect(session, outcome.delayMs);
}

async function reconnect(session: Session, delayMs: number): Promise<void> {
  if (delayMs > 0) await pause(session, delayMs);
  if (session.stopped) return;
  try {
    await openSocket(session, 'reconnect');
  } catch (error: unknown) {
    session.deps.logger.error({ err: error }, 'Не удалось переподключиться к WhatsApp');
    await stopBySelf(session, reconnectFailure(error));
  }
}

function reconnectFailure(error: unknown): WhatsAppStopReason {
  if (error instanceof PairingEndedError) return 'pairing_timeout';
  if (error instanceof SessionSaveFailedError) return 'session_save_failed';
  return 'reconnect_failed';
}

async function pause(session: Session, ms: number): Promise<void> {
  try {
    await session.deps.clock.sleep(ms, session.abort.signal);
  } catch (error: unknown) {
    if (!session.stopped) {
      session.deps.logger.warn({ err: error }, 'Пауза перед переподключением прервана');
    }
  }
}

function markStopped(session: Session): void {
  session.stopped = true;
  session.abort.abort();
  session.link?.abort.abort();
  reportLinkState(session, 'close');
}

/** Остановка по решению адаптера: идёт внутри очереди, поэтому очередь не ждёт. */
async function stopBySelf(session: Session, reason: WhatsAppStopReason): Promise<void> {
  if (session.stopped) return;
  markStopped(session);
  session.deps.logger.warn({ reason }, 'Подключение к WhatsApp остановлено');
  await releaseResources(session);
  await session.credsSaving;
  notifyStopped(session, reason);
}

/** onStopped без ожидания: синхронная ошибка и отказ промиса пишутся в лог и не роняют процесс. */
function notifyStopped(session: Session, reason: WhatsAppStopReason): void {
  const { deps } = session;
  const report = (error: unknown): void => {
    deps.logger.error({ err: error }, 'Ошибка в обработчике остановки WhatsApp');
  };
  try {
    Promise.resolve(deps.onStopped(reason)).catch(report);
  } catch (error: unknown) {
    report(error);
  }
}

/** stop(): закрыть сокет (буфер выдаётся до end), дождаться очереди и сохранения сессии, убрать картинку QR. */
async function stopSession(session: Session): Promise<void> {
  if (!session.stopped) {
    markStopped(session);
    session.deps.logger.info({}, 'Подключение к WhatsApp останавливается по команде');
  }
  await endSocket(session);
  await session.queue;
  await session.credsSaving;
  await releaseResources(session);
}

function releaseResources(session: Session): Promise<void> {
  session.released ??= closeEverything(session);
  return session.released;
}

async function closeEverything(session: Session): Promise<void> {
  await endSocket(session);
  session.qrShown = false;
  await guarded(session, 'Не удалось удалить картинку QR', () => session.seams.presenter.clear());
}

async function endSocket(session: Session): Promise<void> {
  const { link } = session;
  if (link === null) return;
  link.abort.abort();
  flushBuffer(session, link);
  await guarded(session, 'Сокет WhatsApp не закрылся', () => link.sock.end(undefined));
  link.unsubscribe();
}
