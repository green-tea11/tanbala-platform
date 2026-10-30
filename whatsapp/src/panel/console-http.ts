import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ConsoleContext } from './console-context.js';
import { constantTimeEqual, isLoopbackPeer } from './guard.js';
import { securityHeaders } from './http.js';

// HTTP внутреннего API консоли: ошибки по контракту, ответы JSON и проверки запроса до маршрутов.

/** Коды ошибок контракта (contract/CONSOLE_API.md); return_failed и internal добавлены ботом. */
export type ConsoleErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'too_large'
  | 'refused'
  | 'send_failed'
  | 'return_failed'
  | 'db_unavailable'
  | 'internal';

/** Ошибка с кодом и понятным текстом: маршрут бросает её, обработчик ошибок отдаёт JSON. */
export class ConsoleHttpError extends Error {
  override readonly name = 'ConsoleHttpError';
  readonly statusCode: number;
  readonly code: ConsoleErrorCode;

  constructor(statusCode: number, code: ConsoleErrorCode, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const JSON_TYPE = 'application/json; charset=utf-8';
/** Тело действия: JSON-объект не больше 16 КБ (контракт). */
export const BODY_LIMIT_BYTES = 16 * 1024;

const TOKEN_HEADER = 'x-console-token';
const USER_HEADER = 'x-console-user';
const USER_PATTERN = /^[a-z0-9._-]{1,32}$/;
const PROXY_HEADER = /^(?:x-forwarded-.+|forwarded|via)$/;
const BROWSER_HEADERS: readonly string[] = ['origin', 'sec-fetch-site'];
/** Ошибки SQLite (better-sqlite3 кладёт код в error.code): база недоступна или занята. */
const SQLITE_CODE = /^SQLITE_/;

export const TEXTS = {
  unauthorized: 'Нет доступа: токен консоли не передан или неверен.',
  peer: 'Запрос отклонён: API консоли принимает соединения только с этого компьютера.',
  browser: 'Запрос отклонён: API консоли не принимает запросы из браузера.',
  host: 'Неверный заголовок Host: только 127.0.0.1 или localhost с портом API.',
  proxy: 'Запрос отклонён: заголовки прокси (X-Forwarded-*, Forwarded, Via) не принимаются.',
  user: 'Нужен заголовок X-Console-User: латиница в нижнем регистре, цифры, точка, дефис и подчёркивание, до 32 знаков.',
  notFound: 'Такого адреса в API бота нет.',
  tooLarge: 'Слишком большой запрос: тело не больше 16 КБ.',
  badBody: 'Тело запроса: ожидается объект JSON с Content-Type: application/json.',
  badRequest: 'Некорректный запрос.',
  dbUnavailable: 'База бота недоступна. Подробности записаны в лог бота.',
  internal: 'Внутренняя ошибка бота. Подробности записаны в лог бота.',
} as const;

const API_HEADERS = securityHeaders(false);

/** Ответ JSON с заголовками безопасности и no-store: свой на каждом пути, не только через хук onSend. */
export function sendJson(reply: FastifyReply, status: number, body: unknown): FastifyReply {
  return reply.code(status).headers(API_HEADERS).type(JSON_TYPE).send(JSON.stringify(body));
}

/** Ошибка по контракту: {"error": код, "message": текст}, без стека и текста исключения. */
export function sendError(reply: FastifyReply, error: ConsoleHttpError): FastifyReply {
  return sendJson(reply, error.statusCode, { error: error.code, message: error.message });
}

export function badRequest(message: string): ConsoleHttpError {
  return new ConsoleHttpError(400, 'bad_request', message);
}

export function notFound(message: string = TEXTS.notFound): ConsoleHttpError {
  return new ConsoleHttpError(404, 'not_found', message);
}

/** Значение заголовка одной строкой; повтор заголовка (массив) и отсутствие => null. */
function headerOf(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' ? value : null;
}

/** Совпадает ли X-Console-Token с WA_CONSOLE_TOKEN (за постоянное время). */
function tokenValid(context: ConsoleContext, request: FastifyRequest): boolean {
  const sent = headerOf(request, TOKEN_HEADER);
  return sent !== null && constantTimeEqual(sent, context.deps.token);
}

/** Host точно 127.0.0.1:порт или localhost:порт (регистр не важен): защита от DNS rebinding. */
function hostValid(context: ConsoleContext, request: FastifyRequest): boolean {
  const host = headerOf(request, 'host')?.toLowerCase();
  const { port } = context.deps;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function hasProxyHeaders(request: FastifyRequest): boolean {
  return Object.keys(request.headers).some((name) => PROXY_HEADER.test(name.toLowerCase()));
}

function fromBrowser(request: FastifyRequest): boolean {
  return BROWSER_HEADERS.some((name) => request.headers[name] !== undefined);
}

/** Имя пользователя консоли из X-Console-User (уже проверено хуком у POST); нет или неверное => null. */
export function consoleUserOf(request: FastifyRequest): string | null {
  const user = headerOf(request, USER_HEADER);
  return user !== null && USER_PATTERN.test(user) ? user : null;
}

/** Отказ с записью в журнал: только действие и код, без адресов, токенов и заголовков. */
function refuse(
  context: ConsoleContext,
  action: string,
  error: ConsoleHttpError,
): ConsoleHttpError {
  context.audit.warn({ action }, 'API консоли: запрос отклонён');
  return error;
}

/**
 * Проверки до маршрута, по порядку: сокет с этого компьютера (403), токен консоли (401, первым из проверок самого
 * запроса: до Host, заголовков, тела, параметров и базы, в том числе на несуществующем пути), Host (400), заголовки
 * прокси (400), признаки браузера Origin и Sec-Fetch-Site (403), X-Console-User у POST (400). null: всё в порядке.
 */
export function guardRefusal(
  context: ConsoleContext,
  request: FastifyRequest,
): ConsoleHttpError | null {
  if (!isLoopbackPeer(request.socket.remoteAddress)) {
    return refuse(context, 'peer_rejected', new ConsoleHttpError(403, 'forbidden', TEXTS.peer));
  }
  if (!tokenValid(context, request)) {
    return refuse(
      context,
      'token_rejected',
      new ConsoleHttpError(401, 'unauthorized', TEXTS.unauthorized),
    );
  }
  if (!hostValid(context, request)) return refuse(context, 'host_rejected', badRequest(TEXTS.host));
  if (hasProxyHeaders(request)) return refuse(context, 'proxy_rejected', badRequest(TEXTS.proxy));
  if (fromBrowser(request)) {
    return refuse(
      context,
      'browser_rejected',
      new ConsoleHttpError(403, 'forbidden', TEXTS.browser),
    );
  }
  if (request.method === 'POST' && consoleUserOf(request) === null) {
    return refuse(context, 'user_rejected', badRequest(TEXTS.user));
  }
  return null;
}

/** Поле объекта ошибки (Fastify кладёт в ошибки statusCode и code). */
function fieldOf(error: unknown, name: 'statusCode' | 'code'): unknown {
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)[name]
    : undefined;
}

/** Ошибка Fastify или своя в ошибку контракта: 413 => too_large, прочие 4xx => bad_request, SQLite => 503. */
function toConsoleError(error: unknown): ConsoleHttpError {
  if (error instanceof ConsoleHttpError) return error;
  const status = fieldOf(error, 'statusCode');
  if (status === 413) return new ConsoleHttpError(413, 'too_large', TEXTS.tooLarge);
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return badRequest(status === 415 ? TEXTS.badBody : TEXTS.badRequest);
  }
  const code = fieldOf(error, 'code');
  if (typeof code === 'string' && SQLITE_CODE.test(code)) {
    return new ConsoleHttpError(503, 'db_unavailable', TEXTS.dbUnavailable);
  }
  return new ConsoleHttpError(500, 'internal', TEXTS.internal);
}

/** Ответ на ошибку: JSON по контракту; 5xx в лог целиком (логгер маскирует номера), 4xx Fastify только код. */
export function respondToError(
  error: unknown,
  request: Pick<FastifyRequest, 'log'>,
  reply: FastifyReply,
): FastifyReply {
  const converted = toConsoleError(error);
  if (converted.statusCode >= 500) {
    request.log.error({ err: error }, 'Ошибка API консоли');
  } else if (!(error instanceof ConsoleHttpError)) {
    request.log.warn(
      { status: converted.statusCode, code: fieldOf(error, 'code') },
      'Запрос к API консоли отклонён',
    );
  }
  return sendError(reply, converted);
}

/**
 * Ошибки самого Fastify до маршрутов (неверная запись адреса): хуки здесь не работают, поэтому сначала те же
 * проверки сокета и токена, иначе неверный адрес без токена ответил бы 400, а не 401.
 */
export function frameworkErrorsOf(
  context: ConsoleContext,
): (error: unknown, request: FastifyRequest, reply: FastifyReply) => void {
  return (error, request, reply) => {
    const refusal = guardRefusal(context, request);
    if (refusal !== null) {
      sendError(reply, refusal);
      return;
    }
    respondToError(error, request, reply);
  };
}

/** Объект JSON, а не массив, строка или null. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Только JSON-тела не больше BODY_LIMIT_BYTES, только объект. Тело читается после хука onRequest, то есть после
 * токена. Прочие типы тела Fastify отклоняет (415 => 400 по контракту).
 */
export function installJsonParser(app: FastifyInstance): void {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser<string>(
    'application/json',
    { parseAs: 'string', bodyLimit: BODY_LIMIT_BYTES },
    (_request, body, done) => {
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch {
        done(badRequest(TEXTS.badBody), undefined);
        return;
      }
      if (isJsonObject(value)) done(null, value);
      else done(badRequest(TEXTS.badBody), undefined);
    },
  );
}

/**
 * Строковое поле тела. Нет поля => fallback (undefined: поле обязательно); не строка => 400. Читается только своё
 * поле объекта (Object.hasOwn): ключ вроде __proto__ ничего не задевает.
 */
export function bodyString(body: unknown, name: string, fallback?: string): string {
  if (!isJsonObject(body)) throw badRequest(TEXTS.badBody);
  if (!Object.hasOwn(body, name)) {
    if (fallback !== undefined) return fallback;
    throw badRequest(`Тело запроса: нужно поле ${name} (строка).`);
  }
  const value = body[name];
  if (typeof value !== 'string')
    throw badRequest(`Тело запроса: поле ${name} должно быть строкой.`);
  return value;
}

/**
 * Хуки корневого экземпляра (действуют и на 404): onRequest с проверками guardRefusal, onSend с заголовками
 * безопасности и no-store на любом ответе.
 */
export function installConsoleHooks(app: FastifyInstance, context: ConsoleContext): void {
  app.addHook('onRequest', (request, reply, done) => {
    const refusal = guardRefusal(context, request);
    if (refusal === null) {
      done();
      return;
    }
    sendError(reply, refusal);
  });
  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.headers(API_HEADERS);
    done(null, payload);
  });
  app.setNotFoundHandler((_request, reply) => sendError(reply, notFound()));
  app.setErrorHandler((error, request, reply) => respondToError(error, request, reply));
}
