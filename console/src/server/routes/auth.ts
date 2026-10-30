import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { LoginOutcome } from '../../auth/login.js';
import type { AppContext } from '../context.js';
import { clearedSessionCookie, sessionCookie } from '../cookies.js';
import { isSecure, sessionToken } from '../hooks.js';
import { parseInput } from '../params.js';
import { sendError, sendJson } from '../respond.js';
import { publicRoute, userRoute } from './define.js';

/** Длины полей входа с запасом: проверка пароля сама решит, подходит ли он; сверх — 400 без расчёта хэша. */
const loginBody = z.object({
  name: z.string().max(64),
  password: z.string().max(1024),
});

const BUSY_RETRY_SECONDS = 2;
const MS_PER_SECOND = 1000;

function sendLoginOutcome(
  request: FastifyRequest,
  reply: FastifyReply,
  outcome: LoginOutcome,
): FastifyReply {
  switch (outcome.kind) {
    case 'ok':
      reply.header('set-cookie', sessionCookie(outcome.session.token, isSecure(request)));
      return sendJson(reply, { user: outcome.user, csrfToken: outcome.session.csrf });
    case 'invalid':
      // Единственный ответ 401 консоли: его считает fail2ban по журналу Caddy.
      return sendError(reply, 401, 'invalid_credentials');
    case 'limited': {
      const seconds = Math.max(1, Math.ceil(outcome.retryAfterMs / MS_PER_SECOND));
      reply.header('retry-after', String(seconds));
      const minutes = Math.ceil(seconds / 60);
      const message = `Слишком много попыток входа. Повторите через ${minutes} мин.`;
      return sendError(reply, 429, 'rate_limited', message, { retryAfterSeconds: seconds });
    }
    case 'busy':
      reply.header('retry-after', String(BUSY_RETRY_SECONDS));
      return sendError(reply, 429, 'busy', null, { retryAfterSeconds: BUSY_RETRY_SECONDS });
  }
}

/**
 * Вход, выход и текущая сессия. Вход и выход открыты без сессии, но хук требует у них JSON и Origin нашей
 * страницы. Сессия отдаёт токен CSRF для заголовка X-CSRF-Token изменяющих запросов.
 */
export function registerAuthRoutes(app: FastifyInstance, context: AppContext): void {
  userRoute(app, 'manager', 'GET', '/api/session', async (_request, reply, auth) =>
    sendJson(reply, { user: { name: auth.userName, role: auth.role }, csrfToken: auth.csrf }),
  );

  publicRoute(app, 'POST', '/api/login', async (request, reply) => {
    const body = parseInput(loginBody, request.body, reply);
    if (!body.ok) return reply;
    const outcome = await context.login({
      name: body.data.name,
      password: body.data.password,
      client: { ip: request.ip, userAgent: request.headers['user-agent'] },
      previousToken: sessionToken(request),
    });
    return sendLoginOutcome(request, reply, outcome);
  });

  publicRoute(app, 'POST', '/api/logout', async (request, reply) => {
    const token = sessionToken(request);
    const session = context.sessions.resolve(token);
    context.sessions.end(token);
    if (session !== null) {
      context.record({ actor: session.userName, action: 'logout', ip: request.ip });
    }
    reply.header('set-cookie', clearedSessionCookie(isSecure(request)));
    return sendJson(reply, { result: 'logged_out', message: 'Вы вышли из панели.' });
  });
}
