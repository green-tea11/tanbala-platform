import type { AppConfig, ConsoleApiConfig } from '../config/env.js';
import type { ChatCompaniesRepo, CompanyService } from '../domain/company.js';
import type { ConsoleReads } from '../domain/console.js';
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
import {
  buildConsoleApi,
  CONSOLE_API_HOST,
  startConsoleApi,
  type ConsoleApiDeps,
  type ConsoleStatusFacts,
} from '../panel/console-api.js';
import { createRecentReplies, type RecentReplies } from '../panel/recent-replies.js';
import { buildPanel, startPanel, type PanelStartOptions } from '../panel/server.js';
import type { ChatId } from '../domain/types.js';
import type { Services } from './services.js';
import type { WhatsAppStateTracker } from './whatsapp-state.js';

/** Собранная веб-панель. Тип выведен из buildPanel: fastify подключается только в src/panel. */
export type PanelApp = ReturnType<typeof buildPanel>;

/** Запуск панели на адресе и порту. В тестах подменяется, чтобы не занимать порт. */
export type PanelStarter = (app: PanelApp, options: PanelStartOptions) => Promise<void>;

/** Собранный внутренний API консоли (panel/console-api.ts). */
export type ConsoleApiApp = ReturnType<typeof buildConsoleApi>;

/** Запуск API консоли на 127.0.0.1 и порту. В тестах подменяется, чтобы не занимать порт. */
export type ConsoleApiStarter = (app: ConsoleApiApp, port: number) => Promise<void>;

/**
 * Настройки панели: пароль входа и адрес; для API консоли ещё токен и порт (consoleApi) и то, что показывает экран
 * состояния (флаги режима, лимиты, путь лога расхода).
 */
export type PanelConfig = Pick<
  AppConfig,
  | 'adminPassword'
  | 'panel'
  | 'consoleApi'
  | 'waEnabled'
  | 'testMode'
  | 'managerPhone'
  | 'companyApi'
  | 'anthropicKey'
  | 'limits'
  | 'tokenLogPath'
>;

/** Репозитории, которые читает панель. */
export interface PanelStorage {
  readonly chats: ChatsRepo;
  readonly messages: MessagesRepo;
  readonly handoffs: HandoffsRepo;
  readonly notifications: ManagerNotificationsRepo;
  /** Отклонённые черновики для карточки чата. */
  readonly rejectedDrafts: Pick<RejectedDraftsRepo, 'listForChat'>;
  /** Для API консоли: отметки привязки и рабочего режима. */
  readonly appState: Pick<
    AppStateRepo,
    'getLinkedAtMs' | 'getWorkingSinceMs' | 'getHistoryIncomplete'
  >;
  /** Для API консоли: запуски проверки новой компании за сутки. */
  readonly chatCompanies: Pick<ChatCompaniesRepo, 'countResearchStarts'>;
  /** Для API консоли: выборки только на чтение (db/repos/console-details.ts). */
  readonly consoleReads: ConsoleReads;
}

/** Из чего собирается панель. */
export interface PanelSetupContext {
  readonly config: PanelConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly storage: PanelStorage;
  /** Отправка и передача менеджеру общие для приложения (pipeline/services.ts): ответ из панели идёт через них. */
  readonly services: Pick<Services, 'outbox' | 'handoff'>;
  /** Сервис компании (pipeline/company-setup.ts): раздел «Компания» в карточке чата. */
  readonly company: Pick<CompanyService, 'summary'>;
  /**
   * Ответ бота на неотвеченное после возврата чата (Responder.resume); нет (нет ключа Claude): после возврата бот
   * отвечает только на новые сообщения.
   */
  readonly resume?: ((chatId: ChatId) => number) | undefined;
  /** Шов для тестов, в рабочем режиме не передаётся: запуск панели (по умолчанию panel/server.startPanel). */
  readonly startPanel?: PanelStarter | undefined;
  /** Состояние сокета WhatsApp по его событиям (pipeline/whatsapp-state.ts): экран состояния консоли. */
  readonly whatsappState: Pick<WhatsAppStateTracker, 'snapshot'>;
  /** Шов для тестов, в рабочем режиме не передаётся: запуск API консоли (по умолчанию startConsoleApi). */
  readonly startConsoleApi?: ConsoleApiStarter | undefined;
}

/** Веб-панель приложения: запуск и остановка. */
export interface Panel {
  /**
   * Запускает панель на PANEL_HOST и PANEL_PORT: сначала guard.assertPanelStartAllowed (слабый пароль только
   * на 127.0.0.1), потом listen. Запрещённый запуск и занятый порт приходят отказом промиса. Затем API консоли на
   * 127.0.0.1:CONSOLE_API_PORT, если задан WA_CONSOLE_TOKEN; его сбой (порт занят) пишется в лог и бота не
   * останавливает: бот и старая панель работают, консоль покажет, что бот недоступен.
   */
  start(): Promise<void>;
  /**
   * Закрывает API консоли и панель: новых соединений нет, запросы в работе доведены до ответа. Можно звать и без
   * start. Не отклоняется (сбой закрытия пишется в лог), повторный вызов безопасен.
   */
  close(): Promise<void>;
}

/** API консоли и его порт. */
interface ConsolePart {
  readonly app: ConsoleApiApp;
  readonly port: number;
}

/**
 * Собирает веб-панель (этап 6) на общих службах: репозитории читаются напрямую, а ответ клиенту и возврат чата боту
 * идут через общий outbox и сервис передачи (handoff/handoff.ts). Пароль входа ADMIN_PASSWORD, порт и домены за Caddy
 * (PANEL_ALLOWED_HOSTS) берутся из настроек. Панель только собирается, не слушает порт: слушать её начинает start,
 * который main зовёт после запуска WhatsApp (и при WA_ENABLED=false тоже). Пароль в логи не попадает.
 * С WA_CONSOLE_TOKEN рядом собирается внутренний API консоли (panel/console-api.ts) из тех же объектов: те же
 * репозитории, outbox, сервис передачи, компания и ответ после возврата; память недавних ответов (окно дубля
 * 10 секунд) одна на обе панели. Без токена API консоли не собирается и не запускается. Токен в логи не попадает.
 */
export function assemblePanel(context: PanelSetupContext): Panel {
  const { config, logger, storage, services } = context;
  const recentReplies = createRecentReplies(context.clock);
  const app = buildPanel({
    chats: storage.chats,
    messages: storage.messages,
    handoffs: storage.handoffs,
    notifications: storage.notifications,
    rejectedDrafts: storage.rejectedDrafts,
    outbox: services.outbox,
    handoff: services.handoff,
    company: context.company,
    ...(context.resume === undefined ? {} : { resume: context.resume }),
    clock: context.clock,
    logger,
    password: config.adminPassword,
    port: config.panel.port,
    allowedHosts: config.panel.allowedHosts,
    recentReplies,
  });
  const consoleApi = consolePartOf(context, recentReplies);
  const options: PanelStartOptions = {
    host: config.panel.host,
    port: config.panel.port,
    password: config.adminPassword,
  };
  let closing: Promise<void> | null = null;
  return {
    start: async () => {
      await (context.startPanel ?? startPanel)(app, options);
      logger.info({}, `Веб-панель запущена: ${options.host}:${options.port}`);
      if (consoleApi !== null) await startConsole(context, consoleApi);
    },
    close: () => {
      closing ??= closeAll(app, consoleApi, logger);
      return closing;
    },
  };
}

/** Флаги и лимиты для экрана состояния консоли: без номеров, ключей и токенов. */
function statusFactsOf(config: PanelConfig): ConsoleStatusFacts {
  return {
    waEnabled: config.waEnabled,
    testMode: config.testMode.enabled,
    allowlistSize: config.testMode.allowlist.size,
    managerConfigured: config.managerPhone !== null,
    companyFeature: config.companyApi !== null,
    llmConfigured: config.anthropicKey !== null,
    apiDailyLimit: config.limits.apiCallsPerDay,
    apiPerChatLimit: config.limits.apiCallsPerChatPerDay,
  };
}

/** Зависимости API консоли: те же объекты, что у панели, плюс выборки консоли и состояние бота. */
function consoleDepsOf(
  context: PanelSetupContext,
  consoleConfig: ConsoleApiConfig,
  recentReplies: RecentReplies,
): ConsoleApiDeps {
  const { config, storage, services, whatsappState } = context;
  return {
    token: consoleConfig.token,
    port: consoleConfig.port,
    chats: storage.chats,
    messages: storage.messages,
    handoffs: storage.handoffs,
    notifications: storage.notifications,
    rejectedDrafts: storage.rejectedDrafts,
    company: context.company,
    reads: storage.consoleReads,
    appState: storage.appState,
    researchStarts: (sinceMs) => storage.chatCompanies.countResearchStarts(sinceMs),
    whatsapp: () =>
      config.waEnabled ? whatsappState.snapshot() : { state: 'disabled', sinceMs: null },
    facts: statusFactsOf(config),
    tokenLogPath: config.tokenLogPath,
    outbox: services.outbox,
    handoff: services.handoff,
    ...(context.resume === undefined ? {} : { resume: context.resume }),
    recentReplies,
    clock: context.clock,
    logger: context.logger,
  };
}

/** API консоли, если задан WA_CONSOLE_TOKEN; иначе null: сервер не собирается. */
function consolePartOf(
  context: PanelSetupContext,
  recentReplies: RecentReplies,
): ConsolePart | null {
  const consoleConfig = context.config.consoleApi;
  if (consoleConfig === undefined) return null;
  const deps = consoleDepsOf(context, consoleConfig, recentReplies);
  return { app: buildConsoleApi(deps), port: consoleConfig.port };
}

/** Запуск API консоли: сбой (порт занят) в лог, бот и панель работают дальше. */
async function startConsole(context: PanelSetupContext, part: ConsolePart): Promise<void> {
  try {
    await (context.startConsoleApi ?? startConsoleApi)(part.app, part.port);
    context.logger.info({}, `API консоли запущен: ${CONSOLE_API_HOST}:${part.port}`);
  } catch (error: unknown) {
    context.logger.error(
      { err: error },
      'API консоли не запустился: бот и панель работают без него, проверьте CONSOLE_API_PORT',
    );
  }
}

/** Сначала API консоли (новых действий из консоли нет), затем панель; каждый сбой только в лог. */
async function closeAll(app: PanelApp, part: ConsolePart | null, logger: Logger): Promise<void> {
  if (part !== null) await closeQuietly(part.app, logger, 'API консоли закрылся с ошибкой');
  await closeQuietly(app, logger, 'Веб-панель закрылась с ошибкой');
}

/** Закрытие сервера Fastify (панели или API консоли: тип у них один) со сбоем только в лог. */
async function closeQuietly(app: PanelApp, logger: Logger, message: string): Promise<void> {
  try {
    await app.close();
  } catch (error: unknown) {
    logger.error({ err: error }, message);
  }
}
