import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import { sendHtml } from './context.js';
import { securityHeaders } from './http.js';
import { renderMessagePage } from './layout.js';

interface ErrorText {
  readonly title: string;
  readonly message: string;
}

/** Тексты ошибок по статусу: свои, без текста исключения (в нём бывают номера и внутренние пути). */
const ERROR_TEXTS: Readonly<Record<number, ErrorText>> = {
  400: { title: 'Некорректный запрос', message: 'Панель не поняла этот запрос.' },
  403: { title: 'Запрос отклонён', message: 'Откройте страницу заново и повторите действие.' },
  404: { title: 'Страница не найдена', message: 'Такой страницы в панели нет.' },
  413: { title: 'Слишком большой запрос', message: 'Сократите текст и повторите.' },
  415: { title: 'Неподдерживаемый запрос', message: 'Панель принимает только обычные формы.' },
  429: { title: 'Слишком много запросов', message: 'Подождите немного и повторите.' },
};

const CLIENT_ERROR: ErrorText = {
  title: 'Запрос не принят',
  message: 'Панель не приняла этот запрос.',
};

const SERVER_ERROR: ErrorText = {
  title: 'Внутренняя ошибка',
  message: 'Внутренняя ошибка панели. Подробности записаны в лог бота.',
};

/** Поле объекта ошибки, если это объект с таким полем (Fastify кладёт в ошибки statusCode и code). */
function fieldOf(error: unknown, name: 'statusCode' | 'code'): unknown {
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)[name]
    : undefined;
}

/** Статус ответа по ошибке: ошибки клиента Fastify сохраняют свой код, остальное это 500. */
function statusOf(error: unknown): number {
  const status = fieldOf(error, 'statusCode');
  return typeof status === 'number' && status >= 400 && status < 500 ? status : 500;
}

/** Ответ на ошибку: своя страница, подробности в лог. Стек и текст исключения клиенту не уходят. */
function respond(
  error: unknown,
  request: { readonly log: FastifyBaseLogger },
  reply: FastifyReply,
): FastifyReply {
  const status = statusOf(error);
  if (status === 500) {
    request.log.error({ err: error }, 'Ошибка панели');
  } else {
    request.log.warn({ status, code: fieldOf(error, 'code') }, 'Запрос к панели отклонён');
  }
  const text = ERROR_TEXTS[status] ?? (status === 500 ? SERVER_ERROR : CLIENT_ERROR);
  return sendHtml(reply, status, renderMessagePage(text.title, text.message));
}

/**
 * Страницы 404 и ошибок. Стек и текст исключения клиенту не отдаются; в лог 5xx попадает ошибка целиком
 * (логгер маскирует номера и адреса), 4xx только код.
 */
export function installErrorPages(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => {
    const text = ERROR_TEXTS[404] ?? SERVER_ERROR;
    return sendHtml(reply, 404, renderMessagePage(text.title, text.message));
  });
  app.setErrorHandler((error, request, reply) => respond(error, request, reply));
}

/**
 * Ошибки самого Fastify до маршрутов (неверная запись адреса, слишком длинный параметр): без этого он ответил бы
 * JSON с адресом из запроса. Та же страница, что у остальных ошибок; хуки onSend здесь не работают, поэтому
 * заголовки безопасности ставятся прямо тут. Параметр frameworkErrors при создании панели.
 */
export function respondToFrameworkError(
  error: unknown,
  request: { readonly log: FastifyBaseLogger },
  reply: FastifyReply,
): void {
  reply.headers(securityHeaders(false));
  respond(error, request, reply);
}
