import type { IncomingMessage, ServerResponse } from 'node:http';
import fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawServerDefault,
} from 'fastify';
import type { Access } from './types.js';
import { createAppContext, type AppContext, type AppDeps } from './context.js';
import { installErrorHandlers, respondToFrameworkError } from './errors.js';
import { installHooks } from './hooks.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerChatRoutes } from './routes/chats.js';
import { registerCompanyRoutes } from './routes/companies.js';
import { registerHealthRoute } from './routes/health.js';
import { registerHistoryRoutes } from './routes/history.js';
import { registerHomeRoutes } from './routes/home.js';
import { registerLetterRoutes } from './routes/letters.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerStaticRoutes } from './static.js';

/** Прокси, которому верят в X-Forwarded-For и X-Forwarded-Proto: только локальный Caddy. */
const TRUSTED_PROXY = '127.0.0.1';
/** Тело запроса по умолчанию; у импорта свой предел 1.5 МБ. */
export const BODY_LIMIT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_PARAM_LENGTH = 100;
/** Числовой уровень warn у pino. */
const WARN_LEVEL = 40;

/** Логи Fastify не подробнее warn и не подробнее общего уровня (silent в тестах остаётся silent). */
function httpLogLevel(logger: AppDeps['logger']): string {
  return logger.levelVal > WARN_LEVEL ? logger.level : 'warn';
}

/** Тело только JSON (с защитой от __proto__ и constructor); прочие типы — 415. */
function installJsonParser(app: FastifyInstance): void {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    app.getDefaultJsonParser('error', 'error'),
  );
}

function registerRoutes(app: FastifyInstance, context: AppContext): void {
  registerAuthRoutes(app, context);
  registerHomeRoutes(app, context);
  registerChatRoutes(app, context);
  registerCompanyRoutes(app, context);
  registerLetterRoutes(app, context);
  registerSearchRoutes(app, context);
  registerHistoryRoutes(app, context);
  registerSystemRoutes(app, context);
  registerHealthRoute(app, context);
  registerStaticRoutes(app, context);
}

/** Строка таблицы маршрутов: по ней тест проверяет, что у каждого маршрута объявлена роль. */
export interface RouteRecord {
  readonly method: string;
  readonly url: string;
  readonly access: Access | undefined;
}

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly context: AppContext;
  readonly routes: readonly RouteRecord[];
}

function recordRoutes(app: FastifyInstance): RouteRecord[] {
  const routes: RouteRecord[] = [];
  app.addHook('onRoute', (options) => {
    const methods = Array.isArray(options.method) ? options.method : [options.method];
    methods.forEach((method) =>
      routes.push({ method, url: options.url, access: options.config?.access }),
    );
  });
  return routes;
}

/**
 * Собирает сервер консоли без запуска (тесты ходят через inject, без сети и портов). Логи Fastify на уровне warn,
 * без строки запроса и тела (в теле входа пароль).
 */
export function buildApp(deps: AppDeps): BuiltApp {
  const context = createAppContext(deps);
  const app = fastify<RawServerDefault, IncomingMessage, ServerResponse, FastifyBaseLogger>({
    loggerInstance: deps.logger.child({ module: 'http' }, { level: httpLogLevel(deps.logger) }),
    trustProxy: TRUSTED_PROXY,
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
    logController: new LogController({ disableRequestLogging: true }),
    exposeHeadRoutes: false,
    return503OnClosing: true,
    routerOptions: { maxParamLength: MAX_PARAM_LENGTH },
    frameworkErrors: respondToFrameworkError,
  });
  const routes = recordRoutes(app);
  installJsonParser(app);
  installHooks(app, context);
  installErrorHandlers(app);
  registerRoutes(app, context);
  return { app, context, routes };
}
