import type {
  AuthenticationState,
  BaileysEventMap,
  UserFacingSocketConfig,
  WAMessage,
  WAMessageKey,
  WAVersion,
} from 'baileys';
import type {
  AppStateRepo,
  Clock,
  Logger,
  PairingGuard,
  WhatsAppGateway,
} from '../domain/ports.js';
import type { Jid, PhoneDigits, WaMessageId } from '../domain/types.js';
import { SafeError } from '../shared/safe-error.js';
import type { ClassifyContext, WaEvent } from './inbound.js';
import type { QrPresenter } from './qr.js';
import type { DisconnectContext, ReconnectDecision } from './reconnect.js';
import type { MediaDownload } from './voice-media.js';

// Типы, зависимости и ошибки запуска подключения к WhatsApp (whatsapp/connection.ts).

/** Сопоставление адресов @lid и номеров в сокете Baileys. */
export interface LidMapping {
  getPNForLID(lid: string): Promise<string | null>;
  getLIDForPN(pn: string): Promise<string | null>;
}

/** Часть сокета Baileys, которой пользуется адаптер: в тестах её заменяет поддельный сокет. */
export interface WaSocket {
  readonly ev: {
    /** Подписка на пачки событий; возвращает отписку. */
    process(handler: (events: Partial<BaileysEventMap>) => void | Promise<void>): () => void;
    /** Выдаёт накопленные события: end() и закрытие уничтожают буфер Baileys без выдачи. */
    flush(): boolean;
  };
  /** Свой номер: id с номером и lid, оба с суффиксом устройства «:N». В Baileys это геттер. */
  readonly user?: { readonly id: string; readonly lid?: string | undefined } | undefined;
  readonly signalRepository: { readonly lidMapping: LidMapping };
  end(error: Error | undefined): Promise<void>;
  /** Отправка: только текст, без предпросмотра ссылок, с заранее выданным ID. */
  sendMessage(
    jid: string,
    content: { readonly text: string; readonly linkPreview: null },
    options: { readonly messageId: string },
  ): Promise<unknown>;
  /** Статус «печатает» (composing) и его снятие (paused). */
  sendPresenceUpdate(type: 'composing' | 'paused', toJid: string): Promise<void>;
  /** Отметка о прочтении. */
  readMessages(keys: WAMessageKey[]): Promise<void>;
}

/** Сессия Baileys из папки авторизации и её сохранение после creds.update. */
export interface LoadedAuthState {
  readonly state: AuthenticationState;
  saveCreds(): Promise<void>;
}

/** Версия протокола WhatsApp Web. isLatest: false значит, что Baileys отдал встроенную версию. */
export interface FetchedVersion {
  readonly version: WAVersion;
  readonly isLatest: boolean;
}

/** Чат из первой синхронизации (messaging-history.set) для known_chats: только адрес и время, без текста. */
export interface HistoryChat {
  readonly jid: Jid;
  /** Время последнего сообщения, мс UTC; null, если WhatsApp его не сообщил (своё время не подставляется). */
  readonly lastMessageAtMs: number | null;
}

/**
 * Почему подключение остановилось само, без вызова stop(). Решения whatsapp/reconnect.ts: logged_out, replaced,
 * forbidden, gave_up (и больше 12 переподключений за час), pairing_timeout (сеанс привязки закончился без
 * привязки, в том числе когда переподключению нужна новая привязка). Свои причины адаптера:
 * reconnect_failed: сбой решения или открытия нового сокета; version_rejected: WhatsApp отклонил версию
 * клиента (код 405); session_save_failed: сессия не сохранилась, переподключение прочитало бы устаревшую;
 * link_save_failed: момент привязки не записан в базу; handler_failed: три сбоя разбора или onEvent подряд.
 */
export type WhatsAppStopReason =
  | Extract<ReconnectDecision, { readonly action: 'stop' }>['reason']
  | 'reconnect_failed'
  | 'version_rejected'
  | 'session_save_failed'
  | 'link_save_failed'
  | 'handler_failed';

/** Что адаптеру нужно от состояния приложения в базе (db/repos/app-state.ts). */
export type WhatsAppAppState = Pick<
  AppStateRepo,
  'getLinkedAtMs' | 'setLinkedAtMs' | 'markHistoryIncomplete'
>;

/** Зависимости подключения к WhatsApp. */
export interface WhatsAppDeps {
  /** WHATSAPP_SESSION_DIR: папка авторизации Baileys, даёт полный доступ к номеру. Замок держит main. */
  sessionDir: string;
  logger: Logger;
  clock: Clock;
  /** Момент привязки номера (отсечка старых сообщений) и отметка неполной первой синхронизации. */
  appState: WhatsAppAppState;
  /** Не больше двух привязок по QR за 24 часа: третью попытку запрещает код. */
  pairingGuard: PairingGuard;
  /** MANAGER_WHATSAPP: из него и lidMapping.getLIDForPN собираются ClassifyContext.managerJids. */
  managerPhone: PhoneDigits | null;
  /** Закрытый режим: номера из TEST_ALLOWLIST; null, если режим выключен. */
  testAllowlist: ReadonlySet<PhoneDigits> | null;
  /** BACKLOG_MAX_AGE_HOURS в мс: порог для сообщений, пришедших за время простоя. */
  backlogMaxAgeMs: number;
  /** Каждое разобранное событие (whatsapp/inbound.ts) строго по порядку. Не ждать в нём stop(): stop ждёт очередь. */
  onEvent(event: WaEvent): Promise<void>;
  /** Офлайн-очередь после подключения разобрана: можно отправить менеджеру список простоя (pipeline/backlog.ts). */
  onOfflineQueueDone(): Promise<void>;
  /** Чаты первой синхронизации для known_chats (этап 8). Сообщения истории не передаются и не разбираются. */
  onHistoryChats(chats: readonly HistoryChat[]): Promise<void>;
  /**
   * Подключение остановилось само, а не через stop(): сокет уже закрыт, картинка QR удалена. Вызывается один раз
   * и без ожидания (отказ промиса пишется в лог), поэтому из него можно вызвать stop().
   */
  onStopped(reason: WhatsAppStopReason): void | Promise<void>;
  /**
   * Текст отправленного сообщения из outbound_ids для повторной отправки Baileys (getMessage).
   * Отдаёт текст, только если jid совпадает с outbound_ids.jid: по угаданному ID чужой чат его не получит.
   */
  getSentText(waId: WaMessageId, jid: Jid): Promise<string | null>;
  /**
   * Швы для тестов ниже: в рабочем режиме не передаются. main не может импортировать Baileys (границы модулей),
   * поэтому сокет, сессию и версию создаёт сам адаптер. Фабрика сокета; по умолчанию makeWASocket.
   */
  createSocket?: (config: UserFacingSocketConfig) => WaSocket;
  /** Чтение сессии; по умолчанию useMultiFileAuthState(sessionDir). */
  loadAuthState?: (folder: string) => Promise<LoadedAuthState>;
  /** Версия WhatsApp Web; по умолчанию fetchLatestBaileysVersion. */
  fetchVersion?: () => Promise<FetchedVersion>;
  /** Показ QR; по умолчанию терминал процесса (если это терминал) и картинка qr.png рядом с папкой сессии. */
  presenter?: QrPresenter;
  /** Разбор сообщения; по умолчанию whatsapp/inbound.classifyUpsert. */
  classify?: (message: WAMessage, context: ClassifyContext) => WaEvent;
  /** Решение после разрыва; по умолчанию whatsapp/reconnect.decideOnDisconnect. */
  decide?: (context: DisconnectContext) => ReconnectDecision;
  /** Скачивание голосового потоком; по умолчанию whatsapp/voice-media.createWhatsAppAudioDownload. */
  downloadMedia?: MediaDownload;
}

/** Подключённый номер: шлюз для приложения плюс остановка. */
export type WhatsAppConnection = WhatsAppGateway & { stop(): Promise<void> };

/** Привязка по QR запрещена: лимит попыток за скользящие 24 часа исчерпан. Текст безопасен для владельца. */
export class PairingLimitError extends SafeError {
  override readonly name: string = 'PairingLimitError';
  /** Когда можно попробовать снова, мс UTC. */
  readonly retryAtMs: number;

  constructor(retryAtMs: number) {
    super(
      `Лимит привязок по QR за 24 часа исчерпан: следующая попытка не раньше ${new Date(retryAtMs).toISOString()}`,
    );
    this.retryAtMs = retryAtMs;
  }
}

/** Номер привязан (в сессии есть creds.me), а момента привязки в базе нет: граница старых сообщений неизвестна. */
export class LinkBoundaryMissingError extends SafeError {
  override readonly name: string = 'LinkBoundaryMissingError';

  constructor() {
    super(
      'Номер уже привязан, но в базе нет момента привязки: база потеряна или подменена, граница старых сообщений неизвестна. Восстановите базу или привяжите номер заново',
    );
  }
}
