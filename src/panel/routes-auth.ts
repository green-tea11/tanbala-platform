import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  currentSession,
  isSecureRequest,
  redirectTo,
  sendHtml,
  type PanelContext,
} from './context.js';
import { passwordMatches } from './guard.js';
import {
  clearedSessionCookie,
  formField,
  readCookie,
  sessionCookie,
  SESSION_COOKIE,
} from './http.js';
import { renderLoginPage } from './view-login.js';

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;

/** Ответ на неверный пароль: без подсказки, что именно не так. */
const WRONG_PASSWORD = 'Неверный пароль';

function blockedText(waitMs: number): string {
  const minutes = Math.ceil(waitMs / MS_PER_MINUTE);
  return `Слишком много неудачных попыток входа. Повторите через ${minutes} мин.`;
}

/** Пароль верный. Пустой пароль в настройках никого не пускает: вход без пароля панель не допускает. */
function passwordAccepted(context: PanelContext, request: FastifyRequest): boolean {
  const { password } = context.deps;
  const typed = formField(request.body, 'password') ?? '';
  return password !== '' && passwordMatches(typed, password);
}

function handleLogin(
  context: PanelContext,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const nowMs = context.deps.clock.now();
  const client = request.ip;
  const waitMs = context.limiter.retryAfterMs(client, nowMs);
  if (waitMs > 0) {
    context.audit.warn(
      { action: 'login_blocked', ip: client },
      'Панель: вход заблокирован после неудачных попыток',
    );
    reply.header('retry-after', String(Math.ceil(waitMs / MS_PER_SECOND)));
    return sendHtml(reply, 429, renderLoginPage(blockedText(waitMs)));
  }
  if (!passwordAccepted(context, request)) {
    context.limiter.recordFailure(client, nowMs);
    context.audit.warn({ action: 'login_failed', ip: client }, 'Панель: неверный пароль');
    return sendHtml(reply, 401, renderLoginPage(WRONG_PASSWORD));
  }
  context.limiter.reset(client);
  // Новый ID при каждом входе; пришедший с запросом ID не переиспользуется и закрывается.
  const previous = readCookie(request.headers.cookie, SESSION_COOKIE);
  if (previous !== null) context.sessions.destroy(previous);
  const session = context.sessions.create(nowMs);
  reply.header('set-cookie', sessionCookie(session.id, isSecureRequest(request)));
  context.audit.info({ action: 'login', ip: client }, 'Панель: вход выполнен');
  return redirectTo(reply, '/chats');
}

function handleLogout(
  context: PanelContext,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const session = currentSession(context, request);
  if (session !== null) context.sessions.destroy(session.id);
  reply.header('set-cookie', clearedSessionCookie(isSecureRequest(request)));
  context.audit.info({ action: 'logout' }, 'Панель: выход');
  return redirectTo(reply, '/login');
}

/**
 * Вход по ADMIN_PASSWORD, выход и корень. Страница входа открыта без сессии; вошедшего она отправляет в список
 * чатов. Токен CSRF выхода и проверку Origin делают хуки (hooks.ts).
 */
export function registerAuthRoutes(app: FastifyInstance, context: PanelContext): void {
  app.get('/', (_request, reply) => redirectTo(reply, '/chats'));
  app.get('/login', (request, reply) =>
    currentSession(context, request) === null
      ? sendHtml(reply, 200, renderLoginPage(null))
      : redirectTo(reply, '/chats'),
  );
  app.post('/login', (request, reply) => handleLogin(context, request, reply));
  app.post('/logout', (request, reply) => handleLogout(context, request, reply));
}
