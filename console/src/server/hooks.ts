import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import { cookieName, readCookie } from './cookies.js';
import {
  constantTimeEqual,
  isJsonContentType,
  isLoopbackPeer,
  normalizedHost,
  originMatches,
} from './guard.js';
import { NO_STORE, securityHeaders } from './headers.js';
import { sendError } from './respond.js';

/** Методы без побочных действий: Origin, CSRF и JSON у них не проверяются. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Фоновый опрос страницы: срок простоя сессии не продлевает. */
const POLL_HEADER = 'x-console-poll';
const CSRF_HEADER = 'x-csrf-token';

interface Denial {
  readonly status: number;
  readonly code: string;
}

export function isSecure(request: FastifyRequest): boolean {
  return request.protocol === 'https';
}

/**
 * Путь запроса так, как его видит маршрутизатор: без строки запроса, раскодированный (/%61pi → /api), у адреса
 * в абсолютной форме (http://host/api/…) — только путь. Не раскодировался — null.
 */
function routedPath(url: string): string | null {
  try {
    const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? new URL(url).pathname : url;
    return decodeURIComponent(raw.split('?')[0] ?? '');
  } catch {
    return null;
  }
}

export function isApiPath(url: string): boolean {
  const path = routedPath(url);
  return path !== null && (path === '/api' || path.startsWith('/api/'));
}

/** Запрос к API: по найденному маршруту, а без своего маршрута (404, статика) — по раскодированному пути. */
function isApiRequest(request: FastifyRequest): boolean {
  const route = request.routeOptions.url;
  if (route !== undefined && route !== '/*') return route === '/api' || route.startsWith('/api/');
  return isApiPath(request.url);
}

/** Значение cookie сессии с именем по протоколу запроса. */
export function sessionToken(request: FastifyRequest): string | null {
  return readCookie(request.headers.cookie, cookieName(isSecure(request)));
}

/**
 * Транспорт: соединение только с этой машины (адрес сокета), Host из разрешённых (защита от DNS rebinding),
 * домен только по HTTPS (протокол из X-Forwarded-Proto верен только от 127.0.0.1, trustProxy).
 */
function transportDenial(context: AppContext, request: FastifyRequest): Denial | null {
  if (!isLoopbackPeer(request.socket.remoteAddress)) return { status: 403, code: 'forbidden' };
  const host = normalizedHost(request.headers.host);
  if (host === null || !context.hosts.allowed.has(host)) return { status: 403, code: 'bad_host' };
  if (!context.hosts.local.has(host) && !isSecure(request)) {
    return { status: 403, code: 'https_required' };
  }
  return null;
}

/** Изменяющий запрос: только JSON и только с Origin нашей же страницы (вход и выход тоже). */
function mutationDenial(request: FastifyRequest): Denial | null {
  if (!isJsonContentType(request.headers['content-type'])) {
    return { status: 415, code: 'unsupported_media_type' };
  }
  const host = normalizedHost(request.headers.host) ?? '';
  if (!originMatches(request.headers.origin, request.protocol, host)) {
    return { status: 403, code: 'bad_origin' };
  }
  return null;
}

function csrfValid(request: FastifyRequest, expected: string): boolean {
  const sent = request.headers[CSRF_HEADER];
  return typeof sent === 'string' && constantTimeEqual(sent, expected);
}

/**
 * Доступ к маршруту /api: по умолчанию отказ (маршрут без объявленной роли), сессия, роль из базы на каждом
 * запросе, токен CSRF у изменяющих запросов. Отметка активности только у запросов без X-Console-Poll.
 */
function accessDenial(
  context: AppContext,
  request: FastifyRequest,
  mutating: boolean,
): Denial | null {
  const access = request.routeOptions.config.access;
  if (access === undefined) return { status: 403, code: 'forbidden' };
  if (access === 'public') return null;
  const auth = request.auth;
  if (auth === null) return { status: 403, code: 'no_session' };
  if (access === 'owner' && auth.role !== 'owner') return { status: 403, code: 'forbidden' };
  if (mutating && !csrfValid(request, auth.csrf)) return { status: 403, code: 'csrf' };
  if (request.headers[POLL_HEADER] !== '1') context.sessions.touch(auth, request.ip);
  return null;
}

function requestDenial(context: AppContext, request: FastifyRequest): Denial | null {
  const transport = transportDenial(context, request);
  if (transport !== null) return transport;
  // JSON и Origin — у любого изменяющего запроса, на любом пути (в том числе /%61pi/logout и 404).
  const mutating = !SAFE_METHODS.has(request.method);
  const mutation = mutating ? mutationDenial(request) : null;
  if (mutation !== null) return mutation;
  if (!isApiRequest(request)) {
    // Статика и /healthz: маршрут обязан быть объявлен открытым; 404 отвечает обработчик.
    const access = request.routeOptions.config.access;
    return request.is404 || access === 'public' ? null : { status: 403, code: 'forbidden' };
  }
  request.auth = context.sessions.resolve(sessionToken(request));
  if (request.is404) return null;
  return accessDenial(context, request, mutating);
}

/**
 * Хуки корневого экземпляра (действуют и на 404). onRequest — всё до чтения тела: транспорт, Origin и JSON,
 * сессия, роль, CSRF. onSend — заголовки безопасности на каждом ответе и no-store, если обработчик не задал своё.
 */
export function installHooks(app: FastifyInstance, context: AppContext): void {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const denial = requestDenial(context, request);
    if (denial === null) return;
    // «Нет сессии» — обычное дело (страница входа, истёкшая сессия): в лог только необычные отказы.
    if (denial.code !== 'no_session') {
      context.deps.logger.warn(
        { action: 'request_denied', code: denial.code, method: request.method },
        'Запрос отклонён',
      );
    }
    return sendError(reply, denial.status, denial.code);
  });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.headers(securityHeaders(isSecure(request)));
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', NO_STORE);
    reply.removeHeader('x-powered-by');
    return payload;
  });
}
