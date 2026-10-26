import type { IncomingMessage, ServerResponse } from 'node:http';
import fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawServerDefault,
} from 'fastify';
import type {
  ChatsRepo,
  Clock,
  HandoffsRepo,
  Logger,
  ManagerNotificationsRepo,
  MessagesRepo,
} from '../domain/ports.js';
import type { HandoffService } from '../handoff/handoff.js';
import type { Outbox } from '../messaging/outbox.js';
import { createPanelContext, type PanelContext } from './context.js';
import { installErrorPages, respondToFrameworkError } from './error-pages.js';
import { assertPanelStartAllowed } from './guard.js';
import { installPanelHooks } from './hooks.js';
import { parseForm } from './http.js';
import { registerAuthRoutes } from './routes-auth.js';
import { registerChatRoutes } from './routes-chats.js';
import { registerNotificationRoutes } from './routes-notifications.js';
import { PANEL_CSS } from './styles.js';

/** Зависимости веб-панели. */
export interface PanelDeps {
  chats: ChatsRepo;
  messages: MessagesRepo;
  /** Открытая передача чата для карточки клиента. */
  handoffs: HandoffsRepo;
  /** Уведомления менеджеру: список со статусами и последнее по чату. */
  notifications: ManagerNotificationsRepo;
  outbox: Outbox;
  handoff: HandoffService;
  clock: Clock;
  logger: Logger;
  /** ADMIN_PASSWORD. Пустой пароль не пускает никого. */
  password: string;
  /** PANEL_PORT: нужен проверке заголовка Host (локальные имена принимаются только с этим портом). */
  port: number;
  /**
   * Домены панели за Caddy на VPS, точно как их шлёт браузер в Host (например panel.example.kz).
   * Действуют только при сильном пароле (не короче 16 символов): со слабым за Caddy вход закрыт. По умолчанию пусто.
   */
  allowedHosts?: readonly string[];
}

/** Параметры запуска: те же, что проверяет guard.assertPanelStartAllowed. */
export interface PanelStartOptions {
  host: string;
  port: number;
  password: string;
}

/** Прокси, которому верят в X-Forwarded-For и X-Forwarded-Proto: только локальный Caddy. */
const TRUSTED_PROXY = '127.0.0.1';
/** Наибольшее тело запроса: форма с ответом до 4096 символов в процентной записи занимает до 25 КБ. */
const BODY_LIMIT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const CSS_TYPE = 'text/css; charset=utf-8';

/** Панель принимает только обычные формы: JSON и прочие типы тела получают 415. */
function installFormParser(app: FastifyInstance): void {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser<string>(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: BODY_LIMIT_BYTES },
    (_request, body, done) => {
      done(null, parseForm(body));
    },
  );
}

function registerAssetRoutes(app: FastifyInstance): void {
  app.get('/panel.css', (_request, reply) => reply.type(CSS_TYPE).send(PANEL_CSS));
}

function registerRoutes(app: FastifyInstance, context: PanelContext): void {
  registerAuthRoutes(app, context);
  registerChatRoutes(app, context);
  registerNotificationRoutes(app, context);
  registerAssetRoutes(app);
}

/**
 * Собирает веб-панель на Fastify без запуска сервера: список чатов, переписка, карточка клиента,
 * ответ от имени номера, возврат чата боту, уведомления менеджеру. Без listen, чтобы тесты шли через inject без сети.
 * Вход по ADMIN_PASSWORD; сессии в памяти (cookie HttpOnly, SameSite=Strict, Secure по HTTPS); токен CSRF в каждой
 * форме и проверка Origin на изменяющих запросах; ограничение неудачных попыток входа; проверка Host на каждом запросе.
 * Хуки на корневом экземпляре, поэтому вход требуют и 404. CSP без скриптов, стили отдельным файлом, ошибки без стека.
 * Всё, что пришло из WhatsApp, экранируется при выводе (panel/html.ts). Маршрутов к сессии WhatsApp, QR и настройкам нет.
 * Логи Fastify идут на уровне warn, действия (вход, ответ, возврат боту) пишет аудит строкой без текста и номеров.
 */
export function buildPanel(deps: PanelDeps): FastifyInstance {
  const context = createPanelContext(deps);
  const app = fastify<RawServerDefault, IncomingMessage, ServerResponse, FastifyBaseLogger>({
    loggerInstance: deps.logger.child({ module: 'panel-http' }, { level: 'warn' }),
    trustProxy: TRUSTED_PROXY,
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
    frameworkErrors: respondToFrameworkError,
  });
  installFormParser(app);
  installPanelHooks(app, context);
  installErrorPages(app);
  registerRoutes(app, context);
  if (deps.password === '') {
    deps.logger.warn({}, 'Пароль панели пустой: войти в панель нельзя, задайте ADMIN_PASSWORD');
  }
  return app;
}

/**
 * Запускает собранную панель на PANEL_HOST и PANEL_PORT. Сначала guard.assertPanelStartAllowed (слабый пароль только
 * на 127.0.0.1), только потом listen. На VPS только HTTPS через Caddy.
 */
export async function startPanel(app: FastifyInstance, options: PanelStartOptions): Promise<void> {
  assertPanelStartAllowed(options);
  await app.listen({ host: options.host, port: options.port });
}
