import type { IncomingMessage, ServerResponse } from 'node:http';
import fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawServerDefault,
} from 'fastify';
import { INTERNAL_API_TOKEN_PATTERN } from '../config/company-settings.js';
import type { ConsoleApiDeps, ConsoleContext } from './console-context.js';
import {
  BODY_LIMIT_BYTES,
  frameworkErrorsOf,
  installConsoleHooks,
  installJsonParser,
} from './console-http.js';
import { registerConsoleChatRoutes } from './console-routes-chats.js';
import { registerConsoleStatusRoutes } from './console-routes-status.js';

export type {
  ConsoleApiDeps,
  ConsoleStatusFacts,
  ConsoleWhatsAppState,
} from './console-context.js';

/** Единственный адрес сервера консоли: только этот компьютер (контракт), без настройки. */
export const CONSOLE_API_HOST = '127.0.0.1';
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Собирает внутренний API единой панели (contract/CONSOLE_API.md, раздел 3) без запуска сервера: отдельный экземпляр
 * Fastify, хуки старой панели (вход, CSRF, формы) его не касаются. Тесты идут через inject без сети.
 * Защита: сокет только с этого компьютера, trustProxy выключен, первым на любом пути токен X-Console-Token (401 и для
 * несуществующего пути), затем Host только 127.0.0.1:порт или localhost:порт, заголовки прокси => 400, Origin и
 * Sec-Fetch-Site (браузер) => 403, X-Console-User у POST; тело только JSON-объект до 16 КБ, читается после токена.
 * Ответы JSON с no-store и заголовками безопасности, ошибки {"error","message"} без стека. Логи Fastify на уровне warn
 * (журнал запросов на info не пишется), ошибки без адреса и строки запроса; действия пишет журнал (module console-api) с именем пользователя консоли.
 * Чтение — те же репозитории, что у старой панели, и выборки консоли; действия — panel/chat-actions.ts, как у кнопок.
 * Токен не по формату (32–512 видимых ASCII) => ошибка сборки: config/env.ts такой токен не пропускает.
 */
export function buildConsoleApi(deps: ConsoleApiDeps): FastifyInstance {
  if (!INTERNAL_API_TOKEN_PATTERN.test(deps.token)) {
    throw new RangeError('WA_CONSOLE_TOKEN: от 32 до 512 видимых символов ASCII');
  }
  const context: ConsoleContext = { deps, audit: deps.logger.child({ module: 'console-api' }) };
  const app = fastify<RawServerDefault, IncomingMessage, ServerResponse, FastifyBaseLogger>({
    loggerInstance: deps.logger.child({ module: 'console-api-http' }, { level: 'warn' }),
    trustProxy: false,
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
    frameworkErrors: frameworkErrorsOf(context),
  });
  installJsonParser(app);
  installConsoleHooks(app, context);
  registerConsoleStatusRoutes(app, context);
  registerConsoleChatRoutes(app, context);
  return app;
}

/** Запускает собранный API консоли на 127.0.0.1:port. Ошибка порта (занят) приходит отказом промиса. */
export async function startConsoleApi(app: FastifyInstance, port: number): Promise<void> {
  await app.listen({ host: CONSOLE_API_HOST, port });
}
