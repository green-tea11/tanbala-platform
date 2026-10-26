import type { FastifyReply, FastifyRequest, RouteGenericInterface } from 'fastify';
import type { Logger } from '../domain/ports.js';
import { createLoginLimiter, type LoginLimiter } from './login-limiter.js';
import { readCookie, SESSION_COOKIE } from './http.js';
import type { PanelDeps } from './server.js';
import { createSessionStore, type Session, type SessionStore } from './sessions.js';

/** Общее состояние панели: зависимости, сессии, счётчик попыток входа и журнал действий. */
export interface PanelContext {
  readonly deps: PanelDeps;
  readonly sessions: SessionStore;
  readonly limiter: LoginLimiter;
  /** Аудит действий (вход, ответ, возврат боту): строка в лог без текста сообщений, имён и номеров. */
  readonly audit: Logger;
}

/** Тип содержимого страниц. */
export const HTML_TYPE = 'text/html; charset=utf-8';
/** Перенаправление после действия и на вход: браузер повторяет запрос методом GET и не отправляет форму снова. */
const SEE_OTHER = 303;

export function createPanelContext(deps: PanelDeps): PanelContext {
  return {
    deps,
    sessions: createSessionStore(),
    limiter: createLoginLimiter(),
    audit: deps.logger.child({ module: 'panel' }),
  };
}

/** Сессия по cookie запроса (продлевается на простой); нет cookie, неизвестный ID или срок вышел => null. */
export function currentSession(
  context: PanelContext,
  request: { readonly headers: { readonly cookie?: string } },
): Session | null {
  const id = readCookie(request.headers.cookie, SESSION_COOKIE);
  return context.sessions.find(id, context.deps.clock.now());
}

/** Пришёл ли запрос по HTTPS (за Caddy по X-Forwarded-Proto доверенного прокси). Тогда cookie получает Secure. */
export function isSecureRequest(request: FastifyRequest): boolean {
  return request.protocol === 'https';
}

/** Отправляет страницу HTML с нужным статусом. */
export function sendHtml(reply: FastifyReply, status: number, page: string): FastifyReply {
  return reply.code(status).type(HTML_TYPE).send(page);
}

/** Перенаправление 303 по адресу своей панели. */
export function redirectTo(reply: FastifyReply, location: string): FastifyReply {
  return reply.redirect(location, SEE_OTHER);
}

/**
 * Обработчик маршрута, которому нужна сессия. Вход уже проверен хуком, но сессия могла истечь за время запроса:
 * тогда переход на вход. Так сессия в обработчике есть всегда, и проверка не повторяется в каждом маршруте.
 */
export function withSession<G extends RouteGenericInterface = RouteGenericInterface>(
  context: PanelContext,
  handler: (
    request: FastifyRequest<G>,
    reply: FastifyReply,
    session: Session,
  ) => FastifyReply | Promise<FastifyReply>,
): (request: FastifyRequest<G>, reply: FastifyReply) => FastifyReply | Promise<FastifyReply> {
  return (request, reply) => {
    const session = currentSession(context, request);
    return session === null ? redirectTo(reply, '/login') : handler(request, reply, session);
  };
}
