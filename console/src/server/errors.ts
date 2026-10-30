import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isApiPath } from './hooks.js';
import { NO_STORE, securityHeaders } from './headers.js';
import { sendError } from './respond.js';

/** Коды ошибок Fastify, которые консоль переводит в свои. */
const FASTIFY_CODES: Readonly<Record<string, { status: number; code: string }>> = {
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, code: 'too_large' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, code: 'unsupported_media_type' },
};

const STATUS_CODES: Readonly<Record<number, string>> = {
  400: 'bad_request',
  404: 'not_found',
  413: 'too_large',
  415: 'unsupported_media_type',
};

function fieldOf(error: unknown, name: 'statusCode' | 'code'): unknown {
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)[name]
    : undefined;
}

/** Статус и код по ошибке: свои коды Fastify, прочие ошибки клиента — 400, остальное — 500. */
function classify(error: unknown): { status: number; code: string } {
  const known = FASTIFY_CODES[String(fieldOf(error, 'code'))];
  if (known !== undefined) return known;
  const status = fieldOf(error, 'statusCode');
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return { status, code: STATUS_CODES[status] ?? 'bad_request' };
  }
  return { status: 500, code: 'internal' };
}

function respond(
  error: unknown,
  request: { readonly log: FastifyBaseLogger },
  reply: FastifyReply,
): FastifyReply {
  const { status, code } = classify(error);
  if (status === 500) request.log.error({ err: error }, 'Ошибка консоли');
  else request.log.warn({ status, code: fieldOf(error, 'code') }, 'Запрос отклонён');
  return sendError(reply, status, code);
}

/**
 * Ответы на ошибки и 404: свой JSON без стека и текста исключения. Нет такого маршрута под /api: без сессии 403
 * no_session (страница входа), с сессией 404.
 */
export function installErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    if (isApiPath(request.url) && request.auth === null) {
      return sendError(reply, 403, 'no_session');
    }
    return sendError(reply, 404, 'not_found');
  });
  app.setErrorHandler((error, request, reply) => respond(error, request, reply));
}

/**
 * Ошибки Fastify до маршрутов (неверная запись адреса, слишком длинный параметр): хуки onSend здесь не работают,
 * поэтому заголовки безопасности ставятся прямо тут.
 */
export function respondToFrameworkError(
  error: unknown,
  request: { readonly log: FastifyBaseLogger },
  reply: FastifyReply,
): void {
  reply.headers({ ...securityHeaders(false), 'cache-control': NO_STORE });
  respond(error, request, reply);
}
