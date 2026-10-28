// Интерфейсы внешних систем (порты). Реализации живут в адаптерах (whatsapp, llm, db, voice),
// а конвейер и агент зависят только от этих интерфейсов: в тестах их заменяют моки.
import type { z } from 'zod';
import type {
  AudioClip,
  BacklogChat,
  BudgetScope,
  Chat,
  ChatId,
  ChatIdentity,
  ChatStatus,
  HandoffReason,
  InterestAssessment,
  InterestLevel,
  Jid,
  LlmPurpose,
  LlmResult,
  ManagerNotification,
  ManagerNotificationKind,
  ManagerNotificationStatus,
  MediaRef,
  NewMessage,
  OpenHandoff,
  PanelChatRow,
  PhoneDigits,
  SendOrigin,
  StatusChange,
  StoredMessage,
  TokenUsageEntry,
  WaMessageId,
} from './types.js';

/** Время и паузы. В тестах фейковые часы, чтобы не ждать по-настоящему. */
export interface Clock {
  /** Текущее время, мс UTC. */
  now(): number;
  /** Пауза; signal прерывает её при остановке (пауза «печатает» до 20 с, переподключение до 30 с). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

type LogFn = (context: Readonly<Record<string, unknown>>, message?: string) => void;

/**
 * Логгер приложения (pino). Подходит и Baileys (SocketConfig['logger']), и Fastify (FastifyBaseLogger):
 * это проверяет tests/unit/domain/logger-port.test.ts. Текст сообщений, номера и ключи в контекст не передаются.
 */
export interface Logger {
  level: string;
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  /** Нужен Fastify. */
  silent: LogFn;
  /** options.level: свой уровень дочернего логгера, например warn для Baileys. */
  child(bindings: Readonly<Record<string, unknown>>, options?: { level?: string }): Logger;
}

/** Отправка с номера бота. Получает только messaging/outbox.ts: единая точка исходящих. */
export interface MessageSender {
  /** Новый ID исходящего сообщения: записывается в outbound_ids до отправки. */
  newMessageId(): WaMessageId;
  /** Отправляет текст с заранее выданным ID (опция messageId в Baileys). */
  sendText(jid: Jid, text: string, messageId: WaMessageId): Promise<void>;
  /** Статус «печатает» (composing) или его снятие (paused). */
  setTyping(jid: Jid, on: boolean): Promise<void>;
}

/** Что конвейеру нужно от входящих WhatsApp: отметки о прочтении, голосовые, номера. */
export interface WhatsAppInbox {
  markRead(jid: Jid, waIds: readonly WaMessageId[]): Promise<void>;
  /** Скачивает голосовое в память, обрывая поток на maxBytes. */
  downloadAudio(media: MediaRef, maxBytes: number): Promise<AudioClip>;
  /** Номер для адреса @lid, если WhatsApp его сообщил; иначе null. */
  resolvePhone(jid: Jid): Promise<PhoneDigits | null>;
}

/** Картинка в памяти: фото профиля для вызова модели с картинкой. */
export interface ImageInput {
  readonly data: Uint8Array;
  readonly mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
}

/**
 * Бизнес-профиль собеседника: только то, что нужно для поиска компании. Строки недоверенные.
 * personal: обычный аккаунт (профиля нет); failed: запрос не удался.
 */
export type BusinessProfileResult =
  | {
      readonly kind: 'business';
      readonly websites: readonly string[];
      readonly email: string | null;
    }
  | { readonly kind: 'personal' }
  | { readonly kind: 'failed' };

/** Профиль собеседника в WhatsApp для определения компании: запросы только на чтение, ничего не отправляют. */
export interface WhatsAppContacts {
  businessProfile(jid: Jid): Promise<BusinessProfileResult>;
  /** Фото профиля в полном размере; null: фото нет, оно скрыто, больше maxBytes или не скачалось. */
  profilePhoto(jid: Jid, maxBytes: number): Promise<ImageInput | null>;
}

/** Всё, что адаптер WhatsApp (whatsapp/connection.ts) даёт приложению. */
export type WhatsAppGateway = MessageSender & WhatsAppInbox;

/** Блок системного промпта. cache: true ставит точку кэша (cache_control) после блока. */
export interface SystemBlock {
  readonly text: string;
  readonly cache: boolean;
}

/** Реплика для LLM. Текст клиента идёт только в роли user. */
export interface ChatTurn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/**
 * Запрос к LLM со структурным ответом, проверяемым схемой zod.
 * temperature, top_p и top_k: с 21.10.2026 запрос с ними возвращает 400 на всех моделях, поэтому полей нет.
 */
export interface StructuredRequest<T> {
  readonly purpose: LlmPurpose;
  /** ID модели из config/models.json. */
  readonly model: string;
  readonly system: readonly SystemBlock[];
  /** История и задание вызова; последняя реплика всегда user. */
  readonly turns: readonly ChatTurn[];
  /** Картинка к последней реплике user (вызов logo); у остальных вызовов её нет. */
  readonly image?: ImageInput;
  /** Схема без transform: вход и выход совпадают, иначе её не перевести в JSON Schema. */
  readonly schema: z.ZodType<T, T>;
  readonly maxTokens: number;
  /** Внутренний ID чата: для лога токенов и лимита чата. Служебных вызовов вне чата нет. */
  readonly chatId: ChatId;
}

/** Клиент LLM. Отказ, обрезка, неверный формат и другие сбои приходят как { ok: false }, а не исключением. */
export interface LlmClient {
  structured<T>(request: StructuredRequest<T>): Promise<LlmResult<T>>;
}

/** Лог расхода API: одна запись на каждый вызов, включая неудачные. Время ставит сам лог. */
export interface TokenLog {
  record(entry: TokenUsageEntry): Promise<void>;
}

/**
 * Расшифровка голосовых (этап 7). Выключена, пока нет ключа и модели OpenRouter: тогда конвейер отвечает
 * на голосовое фиксированной фразой (Outbox.sendVoiceNotice). Сбой и лимит приходят значением, как у LLM.
 */
export type Transcriber =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      transcribe(clip: AudioClip, chatId: ChatId): Promise<LlmResult<string>>;
    };

/** Итог попытки засчитать один вызов API в дневной лимит. */
export type BudgetDecision =
  { readonly ok: true } | { readonly ok: false; readonly scope: BudgetScope };

/**
 * Дневной предохранитель расходов (решение владельца): не больше API_DAILY_LIMIT вызовов API в сутки на весь бот
 * и API_DAILY_LIMIT_PER_CHAT на один чат. Адаптеры Anthropic и OpenRouter вызывают его перед каждым вызовом API.
 */
export interface CallBudget {
  /**
   * Засчитывает один вызов, если оба лимита позволяют. Вызывается перед каждой попыткой, в том числе повторной.
   * chatId обязателен: служебных вызовов вне чата нет, иначе вызов обошёл бы лимит чата.
   */
  tryConsume(chatId: ChatId, nowMs: number): BudgetDecision;
}

/** Итог попытки начать привязку номера по QR. */
export type PairingDecision =
  | { readonly ok: true; readonly attemptsLeft: number }
  | { readonly ok: false; readonly retryAfterMs: number };

/**
 * Защита от частых привязок по QR (решение владельца): не больше двух попыток за скользящие 24 часа,
 * счётчик в базе, третью попытку запрещает код. Частые неудачи WhatsApp наказывает блокировкой привязки.
 */
export interface PairingGuard {
  /**
   * Засчитывает попытку, если лимит позволяет; иначе отказ и через сколько мс можно снова.
   * Вызывается до запуска сокета и первого QR; одна попытка = один сеанс привязки (QR внутри него обновляется).
   */
  tryBeginAttempt(nowMs: number): PairingDecision;
}

/**
 * Чаты простоя в базе: сообщения клиента старше порога BACKLOG_MAX_AGE_HOURS, на которые бот не ответил.
 * Отметки в базе, а не в памяти: при падении список не теряется, при повторной доставке не дублируется.
 */
export interface BacklogRepo {
  /** Отмечает чат простоя; повтор для того же чата только обновляет время последнего сообщения. */
  markStale(chatId: ChatId, lastMessageAtMs: number): void;
  /** Чаты простоя, о которых менеджеру ещё не сообщили (с именем и номером из чата). */
  listPending(): readonly BacklogChat[];
  /** Отметка «менеджеру сообщили»: ставится только после успешной отправки уведомления. */
  markNotified(chatIds: readonly ChatId[], nowMs: number): void;
}

/** Состояние приложения в базе. */
export interface AppStateRepo {
  /** Момент привязки номера, мс UTC; null, пока номер не привязан. Всё, что отправлено раньше, бот пропускает. */
  getLinkedAtMs(): number | null;
  /**
   * Записывает момент привязки с перезаписью. Когда писать, решает вызывающий (whatsapp/connection.ts):
   * новая привязка (isNewLogin) задаёт новую границу, обычные переподключения её не сдвигают.
   */
  setLinkedAtMs(ms: number): void;
  /**
   * Ставит флаг: список чатов из первой синхронизации (messaging-history.set) не сохранился, known_chats неполон.
   * Пока флаг стоит, этап 8 не переключает TEST_MODE. Повтор не сдвигает момент первого сбоя.
   */
  markHistoryIncomplete(atMs: number): void;
  /** Момент первого сбоя сохранения списка чатов, мс UTC; null, если список не терялся. */
  getHistoryIncomplete(): number | null;
}

/** Откуда бот узнал о чате рабочего номера: первая синхронизация WhatsApp (history) или сообщение (message). */
export type KnownChatSource = 'history' | 'message';

/**
 * Чаты рабочего номера с перепиской: только JID и время последней активности, без текста и имён.
 * Правило этапа 8 из CLAUDE.md: при выключении TEST_MODE все чаты с перепиской до переключения получают статус
 * «ведёт менеджер», а бот берёт только чаты, впервые написавшие после переключения. Поэтому с момента привязки
 * сюда пишутся чаты из первой синхронизации (messaging-history.set) и каждый чат с сообщением, в том числе
 * вне TEST_ALLOWLIST и до привязки. Пачку из синхронизации записывать внутри UnitOfWork.run: одна транзакция.
 */
export interface KnownChatsRepo {
  /** Запоминает чат. Повтор хранит самое позднее время активности и источник этой активности. */
  touch(jid: Jid, atMs: number, source: KnownChatSource): void;
  /** Сколько чатов запомнено: для лога счётчиком, без JID. */
  count(): number;
}

/**
 * Замок «бот уже запущен» на папку данных: второй экземпляр не стартует (общие база, сессия WhatsApp и счётчик
 * привязок). Замок держит ОС, поэтому после падения процесса он снимается сам, без устаревших PID.
 */
export interface ProcessLock {
  /** Снимает замок. Повторный вызов ничего не делает. */
  release(): void;
}

/**
 * Несколько записей в базу одной транзакцией: всё или ничего. Синхронно, поверх db.transaction better-sqlite3,
 * поэтому внутри run только синхронные вызовы репозиториев, без await.
 */
export interface UnitOfWork {
  run<T>(work: () => T): T;
}

/** Чаты и выжимки клиентов. */
export interface ChatsRepo {
  /** Находит или создаёт чат по адресам и обновляет имя из профиля. */
  upsertByIdentity(identity: ChatIdentity, pushName: string | null, nowMs: number): Chat;
  /** Ищет чат по любому из адресов (replyJid, lidJid, pnJid); новый не создаёт. */
  findByJid(jid: Jid): Chat | null;
  getById(id: ChatId): Chat | null;
  setStatus(id: ChatId, change: StatusChange, nowMs: number): void;
  /** Уровень интереса и выжимка одной транзакцией (выжимка в client_profiles, 1:1 с чатом). */
  saveAssessment(id: ChatId, assessment: InterestAssessment, nowMs: number): void;
  /** Чаты для панели: сверху чаты с самым свежим сообщением; status фильтрует, limit и offset для страниц. */
  listForPanel(query: {
    readonly status?: ChatStatus;
    readonly limit: number;
    readonly offset: number;
  }): readonly PanelChatRow[];
  /** Сколько чатов в списке панели с тем же фильтром: для страниц. */
  countForPanel(query: { readonly status?: ChatStatus }): number;
}

/** История сообщений чата. */
export interface MessagesRepo {
  /** Записывает сообщение, если такого waId в чате ещё нет. false: дубль. */
  insertIfNew(message: NewMessage): boolean;
  recent(chatId: ChatId, limit: number): readonly StoredMessage[];
  isUnansweredInbound(chatId: ChatId, waId: WaMessageId): boolean;
  markAnswered(chatId: ChatId, upToWaId: WaMessageId): void;
  /**
   * Расшифровка голосового: текст пишется, только если это голосовое и текста у него ещё нет (вид остаётся voice).
   * Так следующие ответы видят в истории, что клиент сказал голосом. false: нет такого голосового без текста.
   */
  setTranscript(chatId: ChatId, waId: WaMessageId, text: string): boolean;
  /**
   * Переписка для панели: до limit сообщений чата строго раньше сообщения beforeId (без него самые свежие),
   * по возрастанию времени.
   */
  history(
    chatId: ChatId,
    query: { readonly limit: number; readonly beforeId?: number },
  ): readonly StoredMessage[];
}

/** Запись об исходящем сообщении: создаётся до отправки. */
export interface OutboundRecord {
  readonly waId: WaMessageId;
  /** Чат клиента; null у уведомления менеджеру: его чат не чат клиента. */
  readonly chatId: ChatId | null;
  readonly jid: Jid;
  readonly origin: SendOrigin;
  /** Текст нужен Baileys для повторной отправки (getMessage). */
  readonly text: string;
  readonly nowMs: number;
}

/** ID исходящих сообщений. Своё сообщение с неизвестным ID значит, что пишет человек. */
export interface OutboundIdsRepo {
  register(record: OutboundRecord): void;
  setResult(waId: WaMessageId, result: 'sent' | 'failed'): void;
  find(waId: WaMessageId): Pick<OutboundRecord, 'jid' | 'origin' | 'text'> | null;
}

/** Передачи чатов менеджеру. На чат не больше одной открытой передачи, поэтому адрес везде chatId. */
export interface HandoffsRepo {
  /** Открывает передачу со снимком выжимки. false: открытая уже есть, повтор ничего не дублирует. */
  open(
    chatId: ChatId,
    reason: HandoffReason,
    level: InterestLevel,
    snapshot: string,
    nowMs: number,
  ): boolean;
  findOpen(chatId: ChatId): OpenHandoff | null;
  /** Закрывает открытую передачу (возврат чата боту из панели); нет открытой => ничего. */
  resolve(chatId: ChatId, nowMs: number): void;
}

/**
 * Уведомления менеджеру: каждое пишется в базу до отправки. Панель показывает их и при пустом MANAGER_WHATSAPP,
 * сбой отправки повторяется. Судьба уведомления о передаче хранится здесь, а не в handoffs.
 */
export interface ManagerNotificationsRepo {
  /** Записывает уведомление со статусом pending и attempts 0; возвращает его id. */
  add(entry: {
    readonly kind: ManagerNotificationKind;
    readonly chatId: ChatId | null;
    readonly text: string;
    readonly nowMs: number;
  }): number;
  /** Итог попытки отправки: новый статус, waId при sent (иначе null), attempts + 1. */
  setResult(
    id: number,
    result: {
      readonly status: Exclude<ManagerNotificationStatus, 'pending'>;
      readonly waId: WaMessageId | null;
    },
    nowMs: number,
  ): void;
  /**
   * Что отправить повторно: failed и зависшие pending (updatedAtMs не позже staleBeforeMs) с attempts меньше
   * maxAttempts; старые первыми, не больше limit.
   */
  listRetryable(query: {
    readonly maxAttempts: number;
    readonly staleBeforeMs: number;
    readonly limit: number;
  }): readonly ManagerNotification[];
  /** Для панели: новые сверху. */
  listRecent(query: {
    readonly limit: number;
    readonly offset: number;
  }): readonly ManagerNotification[];
  countAll(): number;
  /** Последнее уведомление по чату: для карточки клиента в панели. */
  latestForChat(chatId: ChatId): ManagerNotification | null;
}
