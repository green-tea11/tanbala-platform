import type { FastifyInstance } from 'fastify';
import type { ChatsRepo, Logger, MessagesRepo } from '../domain/ports.js';
import type { HandoffService } from '../handoff/handoff.js';
import type { Outbox } from '../messaging/outbox.js';
import { notImplemented } from '../shared/todo.js';

/** Зависимости веб-панели. */
export interface PanelDeps {
  chats: ChatsRepo;
  messages: MessagesRepo;
  outbox: Outbox;
  handoff: HandoffService;
  logger: Logger;
}

/**
 * Собирает веб-панель на Fastify без запуска сервера: список чатов, переписка, карточка клиента,
 * ответ от имени номера, возврат чата боту. Без listen, чтобы тесты шли через inject без сети.
 * TODO(этап 6): fastify<RawServerDefault, IncomingMessage, ServerResponse, FastifyBaseLogger>({ loggerInstance }) с явными дженериками: иначе результат с логгером pino не присваивается FastifyInstance.
 * TODO(этап 6): проверка входа в onRequest корневого экземпляра, чтобы 404 и маршруты плагинов тоже требовали входа.
 * TODO(этап 6): каждый запрос через panel/guard.hostHeaderAllowed (DNS rebinding, вход за Caddy); trustProxy только для 127.0.0.1, иначе rate limit обходится подделкой X-Forwarded-For.
 * TODO(этап 6): helmet и CSP без inline-скриптов; ошибки без стека.
 * TODO(этап 6): cookie сессии HttpOnly, SameSite=Strict, Secure на HTTPS; новый ID сессии при входе; CSRF-токен и проверка Origin на всех изменяющих методах; rate limit на вход.
 * TODO(этап 6): всё, что пришло из WhatsApp (текст, имя), экранировать при выводе.
 * TODO(этап 6): ответ от номера только в существующий чат и только через outbox.sendFromPanel, с записью в аудит; маршрутов к сессии, QR и конфигу нет.
 */
export function buildPanel(deps: PanelDeps): FastifyInstance {
  return notImplemented('этап 6', 'panel/server.buildPanel');
}

/**
 * Запускает собранную панель на PANEL_HOST и PANEL_PORT.
 * TODO(этап 6): сначала panel/guard.assertPanelStartAllowed, только потом listen; на VPS только HTTPS через Caddy.
 */
export function startPanel(
  app: FastifyInstance,
  options: { host: string; port: number; password: string },
): Promise<void> {
  return notImplemented('этап 6', 'panel/server.startPanel');
}
