import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  currentSession,
  isSecureRequest,
  redirectTo,
  sendHtml,
  type PanelContext,
} from './context.js';
import { constantTimeEqual, hostHeaderAllowed } from './guard.js';
import { formField, originAllowed, securityHeaders } from './http.js';
import { renderMessagePage } from './layout.js';

/** Маршруты без входа: страница входа, сам вход и стили для неё. Всё остальное, включая 404, требует сессии. */
const PUBLIC_ROUTES: ReadonlySet<string> = new Set(['GET /login', 'POST /login', 'GET /panel.css']);
/** Методы без побочных действий: Origin и токен CSRF у них не проверяются. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const PLAIN_TYPE = 'text/plain; charset=utf-8';

const REJECTED_TITLE = 'Запрос отклонён';
const REJECTED_TEXT =
  'Страница устарела или запрос пришёл не из панели. Откройте страницу заново и повторите действие.';

/** HEAD ходит теми же маршрутами, что GET. Нет совпавшего маршрута (404): пустое имя маршрута. */
function routeKey(request: FastifyRequest): string {
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  return `${method} ${request.routeOptions.url ?? ''}`;
}

function isPublic(request: FastifyRequest): boolean {
  return PUBLIC_ROUTES.has(routeKey(request));
}

function rejectRequest(reply: FastifyReply): true {
  sendHtml(reply, 403, renderMessagePage(REJECTED_TITLE, REJECTED_TEXT));
  return true;
}

/** Чужой заголовок Host (DNS rebinding, вход за Caddy со слабым паролем): ответ 403, true. */
function rejectForeignHost(
  context: PanelContext,
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const { port, password, allowedHosts } = context.deps;
  if (hostHeaderAllowed({ hostHeader: request.headers.host, port, password, allowedHosts })) {
    return false;
  }
  context.audit.warn(
    { action: 'host_rejected' },
    'Панель: запрос с чужим заголовком Host отклонён',
  );
  reply.code(403).type(PLAIN_TYPE).send('Запрос отклонён');
  return true;
}

/** Изменяющий запрос не с нашей страницы (чужой Origin): 403, true. */
function rejectForeignOrigin(
  context: PanelContext,
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (SAFE_METHODS.has(request.method)) return false;
  const { origin, referer, host } = request.headers;
  if (originAllowed({ origin, referer, hostHeader: host, protocol: request.protocol }))
    return false;
  context.audit.warn({ action: 'origin_rejected' }, 'Панель: запрос с чужим Origin отклонён');
  return rejectRequest(reply);
}

/** Нет сессии на закрытом маршруте (в том числе 404): переход на вход, true. */
function requireLogin(
  context: PanelContext,
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (isPublic(request) || currentSession(context, request) !== null) return false;
  redirectTo(reply, '/login');
  return true;
}

/** Токен CSRF из формы совпадает с токеном сессии (сравнение за постоянное время). */
function csrfValid(context: PanelContext, request: FastifyRequest): boolean {
  const session = currentSession(context, request);
  const sent = formField(request.body, 'csrf');
  return session !== null && sent !== null && constantTimeEqual(sent, session.csrf);
}

/**
 * Хуки корневого экземпляра, поэтому они действуют и на 404:
 * onRequest: заголовок Host, Origin изменяющих запросов, вход; preHandler: токен CSRF (тело уже разобрано);
 * onSend: заголовки безопасности на каждом ответе, в том числе на ошибках и перенаправлениях.
 */
export function installPanelHooks(app: FastifyInstance, context: PanelContext): void {
  app.addHook('onRequest', (request, reply, done) => {
    const blocked =
      rejectForeignHost(context, request, reply) ||
      rejectForeignOrigin(context, request, reply) ||
      requireLogin(context, request, reply);
    if (!blocked) done();
  });
  app.addHook('preHandler', (request, reply, done) => {
    // Нет такого маршрута (404): отвечает страница ошибки, менять там нечего.
    const exempt = SAFE_METHODS.has(request.method) || isPublic(request) || request.is404;
    if (exempt || csrfValid(context, request)) {
      done();
      return;
    }
    context.audit.warn(
      { action: 'csrf_rejected' },
      'Панель: запрос без верного токена CSRF отклонён',
    );
    rejectRequest(reply);
  });
  app.addHook('onSend', (request, reply, payload, done) => {
    reply.headers(securityHeaders(isSecureRequest(request)));
    done(null, payload);
  });
}
