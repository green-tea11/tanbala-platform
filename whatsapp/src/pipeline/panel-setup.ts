import type { AppConfig } from '../config/env.js';
import type { CompanyService } from '../domain/company.js';
import type {
  ChatsRepo,
  Clock,
  HandoffsRepo,
  Logger,
  ManagerNotificationsRepo,
  MessagesRepo,
} from '../domain/ports.js';
import { buildPanel, startPanel, type PanelStartOptions } from '../panel/server.js';
import type { ChatId } from '../domain/types.js';
import type { Services } from './services.js';

/** Собранная веб-панель. Тип выведен из buildPanel: fastify подключается только в src/panel. */
export type PanelApp = ReturnType<typeof buildPanel>;

/** Запуск панели на адресе и порту. В тестах подменяется, чтобы не занимать порт. */
export type PanelStarter = (app: PanelApp, options: PanelStartOptions) => Promise<void>;

/** Настройки панели: пароль входа и адрес. */
export type PanelConfig = Pick<AppConfig, 'adminPassword' | 'panel'>;

/** Репозитории, которые читает панель. */
export interface PanelStorage {
  readonly chats: ChatsRepo;
  readonly messages: MessagesRepo;
  readonly handoffs: HandoffsRepo;
  readonly notifications: ManagerNotificationsRepo;
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
}

/** Веб-панель приложения: запуск и остановка. */
export interface Panel {
  /**
   * Запускает панель на PANEL_HOST и PANEL_PORT: сначала guard.assertPanelStartAllowed (слабый пароль только
   * на 127.0.0.1), потом listen. Запрещённый запуск и занятый порт приходят отказом промиса.
   */
  start(): Promise<void>;
  /**
   * Закрывает панель: новых соединений нет, запросы в работе доведены до ответа. Можно звать и без start.
   * Не отклоняется (сбой закрытия пишется в лог), повторный вызов безопасен.
   */
  close(): Promise<void>;
}

/**
 * Собирает веб-панель (этап 6) на общих службах: репозитории читаются напрямую, а ответ клиенту и возврат чата боту
 * идут через общий outbox и сервис передачи (handoff/handoff.ts). Пароль входа ADMIN_PASSWORD, порт и домены за Caddy
 * (PANEL_ALLOWED_HOSTS) берутся из настроек. Панель только собирается, не слушает порт: слушать её начинает start,
 * который main зовёт после запуска WhatsApp (и при WA_ENABLED=false тоже). Пароль в логи не попадает.
 */
export function assemblePanel(context: PanelSetupContext): Panel {
  const { config, logger, storage, services } = context;
  const app = buildPanel({
    chats: storage.chats,
    messages: storage.messages,
    handoffs: storage.handoffs,
    notifications: storage.notifications,
    outbox: services.outbox,
    handoff: services.handoff,
    company: context.company,
    ...(context.resume === undefined ? {} : { resume: context.resume }),
    clock: context.clock,
    logger,
    password: config.adminPassword,
    port: config.panel.port,
    allowedHosts: config.panel.allowedHosts,
  });
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
    },
    close: () => {
      closing ??= closePanel(app, logger);
      return closing;
    },
  };
}

async function closePanel(app: PanelApp, logger: Logger): Promise<void> {
  try {
    await app.close();
  } catch (error: unknown) {
    logger.error({ err: error }, 'Веб-панель закрылась с ошибкой');
  }
}
