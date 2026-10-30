import type { FastifyInstance } from 'fastify';
import { checkBackends } from '../../services/spend-report.js';
import type { AppContext } from '../context.js';
import { normalizedHost } from '../guard.js';
import { sendError, sendJson } from '../respond.js';
import { publicRoute } from './define.js';

/**
 * /healthz для health.sh: только с локальным Host (снаружи через Caddy — 404), без сессии. Отдаёт только
 * «да/нет» по каждому приложению, без данных.
 */
export function registerHealthRoute(app: FastifyInstance, context: AppContext): void {
  publicRoute(app, 'GET', '/healthz', async (request, reply) => {
    const host = normalizedHost(request.headers.host);
    if (host === null || !context.hosts.local.has(host)) return sendError(reply, 404, 'not_found');
    const backends = await checkBackends(context.deps);
    return sendJson(reply, { console: true, ...backends });
  });
}
