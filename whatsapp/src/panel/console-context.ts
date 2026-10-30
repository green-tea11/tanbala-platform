import type { CompanyService } from '../domain/company.js';
import type { ConsoleReads, WhatsAppLinkState } from '../domain/console.js';
import type {
  AppStateRepo,
  ChatsRepo,
  Clock,
  HandoffsRepo,
  Logger,
  ManagerNotificationsRepo,
  MessagesRepo,
  RejectedDraftsRepo,
} from '../domain/ports.js';
import type { ChatActionDeps } from './chat-actions.js';
import type { ReplyRateLimit } from './console-reply-limit.js';
import type { SpendReader } from './console-spend.js';
import type { RecentReplies } from './recent-replies.js';

/** Настройки бота для экрана состояния: только флаги и числа, без номеров и токенов. */
export interface ConsoleStatusFacts {
  readonly waEnabled: boolean;
  readonly testMode: boolean;
  readonly allowlistSize: number;
  readonly managerConfigured: boolean;
  readonly companyFeature: boolean;
  readonly llmConfigured: boolean;
  readonly apiDailyLimit: number;
  readonly apiPerChatLimit: number;
}

/** Состояние WhatsApp для консоли: по событиям сокета или disabled (WA_ENABLED=false); since null, если не было. */
export interface ConsoleWhatsAppState {
  readonly state: WhatsAppLinkState | 'disabled';
  readonly sinceMs: number | null;
}

/**
 * Зависимости внутреннего API консоли: те же объекты, что у старой панели (репозитории, outbox, сервис передачи,
 * компания, ответ бота после возврата, общая память недавних ответов), плюс выборки консоли и состояние бота.
 */
export interface ConsoleApiDeps extends ChatActionDeps {
  /** WA_CONSOLE_TOKEN: заголовок X-Console-Token сравнивается с ним за постоянное время. */
  readonly token: string;
  /** CONSOLE_API_PORT: Host принимается только 127.0.0.1:порт и localhost:порт. */
  readonly port: number;
  readonly chats: Pick<ChatsRepo, 'getById' | 'getNote' | 'getProgress'>;
  readonly messages: Pick<MessagesRepo, 'history'>;
  readonly handoffs: Pick<HandoffsRepo, 'findOpen'>;
  readonly notifications: Pick<ManagerNotificationsRepo, 'latestForChat'>;
  readonly rejectedDrafts: Pick<RejectedDraftsRepo, 'listForChat'>;
  readonly company: Pick<CompanyService, 'summary'>;
  readonly reads: ConsoleReads;
  readonly appState: Pick<
    AppStateRepo,
    'getLinkedAtMs' | 'getWorkingSinceMs' | 'getHistoryIncomplete'
  >;
  /** Запуски проверки новой компании позже sinceMs (ChatCompaniesRepo.countResearchStarts). */
  readonly researchStarts: (sinceMs: number) => number;
  readonly whatsapp: () => ConsoleWhatsAppState;
  readonly facts: ConsoleStatusFacts;
  /** TOKEN_LOG_PATH: расход читается из него и из прошлого файла после ротации (.1). */
  readonly tokenLogPath: string;
  /** Общая со старой панелью память недавних ответов: окно дубля 10 секунд одно. */
  readonly recentReplies: RecentReplies;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * Контекст маршрутов консоли: зависимости, журнал действий (module console-api), предел ответов из консоли и чтение
 * расхода (один расчёт за раз, память на минуту). Последние два живут, пока жив сервер консоли.
 */
export interface ConsoleContext {
  readonly deps: ConsoleApiDeps;
  readonly audit: Logger;
  readonly replyLimit: ReplyRateLimit;
  readonly spend: SpendReader;
}
