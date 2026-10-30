// Чтение для внутреннего API единой панели (консоли): только выборки, без записи. Реализация в src/db/repos
// (console-chat-list.ts и console-details.ts), HTTP в src/panel/console-api.ts. Контракт: contract/CONSOLE_API.md.
import type {
  Author,
  ChatControl,
  ChatId,
  ChatStatus,
  HandoffReason,
  InterestLevel,
  Jid,
  ManagerNotification,
  ManagerNotificationStatus,
  MessageKind,
  OpenHandoff,
} from './types.js';

/**
 * Состояние сокета WhatsApp по его событиям connection.update (а не по наличию объекта подключения): open,
 * connecting или closed. Его видит только консоль; поведение бота от него не зависит.
 */
export type WhatsAppLinkState = 'open' | 'connecting' | 'closed';

/** Состояние сокета WhatsApp и с какого момента оно такое, мс UTC. */
export interface WhatsAppStateSnapshot {
  readonly state: WhatsAppLinkState;
  readonly sinceMs: number;
}

/** Связь чата с компанией почтового проекта по записи бота: подтверждена клиентом, кандидат или нет. */
export type CompanyLinkState = 'confirmed' | 'candidate' | 'none';

/**
 * Поиск в списке чатов: варианты написания имени и цифры номера. Имя сравнивается без учёта регистра (и кириллицы) и
 * без невидимых символов: хранилище приводит к одному виду и имя, и каждый вариант.
 */
export interface ChatSearch {
  /** Как набрано, строчными, ПРОПИСНЫМИ и С заглавной: имя содержит хотя бы один вариант. */
  readonly nameVariants: readonly string[];
  /** Цифры номера (от 3), если запрос похож на номер; иначе null. */
  readonly digits: string | null;
}

/** Фильтр списка чатов консоли. Незаданное поле не фильтрует. */
export interface ConsoleChatFilter {
  readonly status?: ChatStatus;
  readonly level?: InterestLevel;
  readonly company?: CompanyLinkState;
  /** true: только чаты, где клиент ждёт ответа (waitingSince не null). */
  readonly waitingOnly?: boolean;
  readonly search?: ChatSearch;
  /** Сейчас, мс UTC: группа «бот молчит» считается от него. */
  readonly nowMs: number;
}

/** Страница списка. */
export interface PageQuery {
  readonly limit: number;
  readonly offset: number;
}

/** Последнее сообщение чата для строки списка. */
export interface LastMessage {
  readonly author: Author;
  readonly kind: MessageKind;
  readonly text: string | null;
}

/** Компания чата по записи бота: id из почтового проекта и название, как его записал бот. */
export interface ChatCompanyLink {
  readonly state: Exclude<CompanyLinkState, 'none'>;
  readonly id: number;
  readonly name: string | null;
}

/** Строка списка чатов консоли: сырые данные, подписи и чистку текста делает src/panel. */
export interface ConsoleChatRow {
  readonly id: ChatId;
  readonly pushName: string | null;
  readonly pnJid: Jid | null;
  readonly control: ChatControl;
  readonly level: InterestLevel;
  readonly lastMessageAtMs: number | null;
  readonly lastMessage: LastMessage | null;
  readonly openHandoff: OpenHandoff | null;
  readonly company: ChatCompanyLink | null;
  /** С какого сообщения клиент ждёт ответа (группы manager и bot, см. ConsoleReads); не ждёт => null. */
  readonly waitingSinceMs: number | null;
}

/** Открытая передача для «Требует внимания»: с первым уведомлением менеджеру после открытия. */
export interface AttentionHandoffRow {
  readonly id: number;
  readonly chatId: ChatId;
  readonly pushName: string | null;
  readonly pnJid: Jid | null;
  readonly reason: HandoffReason;
  readonly level: InterestLevel;
  readonly openedAtMs: number;
  readonly notification: {
    readonly status: ManagerNotificationStatus;
    readonly attempts: number;
  } | null;
}

/** Горячий клиент: уровень hot и почему модель так решила. */
export interface HotChatRow {
  readonly chatId: ChatId;
  readonly pushName: string | null;
  readonly pnJid: Jid | null;
  readonly status: ChatStatus;
  readonly levelReason: string | null;
  readonly levelUpdatedAtMs: number | null;
  readonly lastMessageAtMs: number | null;
}

/** Кто должен ответить: manager — человек, bot — бот молчит дольше 5 минут (сбой, лимит, граница режима). */
export type WaitingGroup = 'manager' | 'bot';

/** Чат, где клиент ждёт ответа. */
export interface WaitingChatRow {
  readonly chatId: ChatId;
  readonly pushName: string | null;
  readonly pnJid: Jid | null;
  readonly status: ChatStatus;
  readonly group: WaitingGroup;
  readonly waitingSinceMs: number;
  readonly lastClientAtMs: number;
  /** Последняя передача чата — жалоба. */
  readonly complaint: boolean;
}

/**
 * Сколько строк у списков «Требует внимания» без предела: открытые передачи (кроме human_took_over), горячие, ждут
 * ответа (клиент писал за последние 30 дней) и ждущие, которых окно 30 дней отбросило.
 */
export interface AttentionCounts {
  readonly handoffs: number;
  readonly hot: number;
  readonly waiting: number;
  readonly staleWaiting: number;
}

/** Время смены статуса и создания чата: их нет в Chat. */
export interface ChatMeta {
  readonly statusChangedAtMs: number | null;
  readonly createdAtMs: number;
}

/** Почему модель поставила уровень интереса и когда оценивала последний раз. */
export interface ProfileMeta {
  readonly reason: string;
  readonly updatedAtMs: number;
}

/** Передача из истории чата. */
export interface HandoffHistoryRow {
  readonly id: number;
  readonly reason: HandoffReason;
  readonly level: InterestLevel;
  readonly openedAtMs: number;
  readonly resolvedAtMs: number | null;
}

/** Уведомление менеджеру с именем клиента из чата (у списка простоя чата нет). */
export interface NotificationWithChat extends ManagerNotification {
  readonly chatName: string | null;
}

/** Подтверждённая связь чат → компания почтового проекта. */
export interface CompanyLinkRow {
  readonly chatId: ChatId;
  readonly companyId: number;
  readonly pushName: string | null;
  readonly pnJid: Jid | null;
  readonly status: ChatStatus;
  readonly level: InterestLevel;
  readonly confirmedAtMs: number | null;
  readonly firstClientMessageAtMs: number | null;
  readonly lastMessageAtMs: number | null;
}

/**
 * Выборки для консоли. Только чтение: ни один метод ничего не пишет и не меняет. Ждёт ответа (waitingSinceMs):
 * manager — чат у менеджера, и после последнего ответа (человека или бота, кроме фразы о передаче) клиент написал;
 * с первого такого сообщения клиента. bot — чат у бота, после последнего сообщения не клиента клиент написал, и
 * первое такое сообщение старше 5 минут (пачка собирается до 15 секунд, ответ модели до минуты).
 */
export interface ConsoleReads {
  /**
   * Несколько выборок одной транзакцией чтения: число и страница списка, списки «Требует внимания» и их числа видят
   * одно состояние базы. work синхронный; его исключение всплывает.
   */
  readTransaction<T>(work: () => T): T;
  listChats(filter: ConsoleChatFilter, page: PageQuery): readonly ConsoleChatRow[];
  countChats(filter: ConsoleChatFilter): number;
  /** Открытые передачи, кроме human_took_over, свежие сверху. */
  openHandoffs(limit: number): readonly AttentionHandoffRow[];
  hotChats(limit: number): readonly HotChatRow[];
  /** Только чаты, где клиент писал за последние 30 дней; дольше всех ждущие первыми. */
  waitingChats(nowMs: number, limit: number): readonly WaitingChatRow[];
  /** Сколько строк у списков «Требует внимания» без предела и сколько ждущих старше окна 30 дней. */
  attentionCounts(nowMs: number): AttentionCounts;
  /** Чаты простоя, о которых менеджеру ещё не сообщили. */
  pendingBacklogCount(): number;
  chatMeta(chatId: ChatId): ChatMeta | null;
  profileMeta(chatId: ChatId): ProfileMeta | null;
  /** Все передачи чата, свежие сверху, не больше limit. */
  handoffHistory(chatId: ChatId, limit: number): readonly HandoffHistoryRow[];
  /** Сколько отклонённых черновиков чата хранится (30 дней). */
  countRejected(chatId: ChatId): number;
  listNotifications(
    query: PageQuery & { readonly status?: ManagerNotificationStatus },
  ): readonly NotificationWithChat[];
  countNotifications(query: { readonly status?: ManagerNotificationStatus }): number;
  /**
   * Подтверждённые связи; companyId задан => только его чаты. Свежие сверху: последнее сообщение чата (без сообщений —
   * время подтверждения), затем большие companyId и chatId; предел отбрасывает самые старые.
   */
  companyLinks(query: {
    readonly companyId?: number;
    readonly limit: number;
  }): readonly CompanyLinkRow[];
  /** Сколько подтверждённых связей всего (без предела). */
  countCompanyLinks(query: { readonly companyId?: number }): number;
  /** Вызовы API бота за сутки по Алматы (общий счётчик api_usage, chat_id 0). */
  apiCallsOn(day: string): number;
  /** Попытки привязки по QR позже sinceMs (только база; копию вне data/ не читает). */
  pairingAttemptsSince(sinceMs: number): number;
}
