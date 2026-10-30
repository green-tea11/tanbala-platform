import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SEEN_KINDS } from '../../db/seen.js';
import { buildHome } from '../../services/home.js';
import type { AppContext } from '../context.js';
import { parseInput } from '../params.js';
import { sendJson } from '../respond.js';
import { userRoute } from './define.js';

/** Отметок «видел» за один запрос: как предел списков id у приложений. */
const SEEN_MAX_IDS = 100;

const seenBody = z.object({
  kind: z.enum(SEEN_KINDS),
  ids: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(SEEN_MAX_IDS),
});

/** Главная «Требует внимания» и отметка «видел» (новые передачи, писали после письма, уведомления). */
export function registerHomeRoutes(app: FastifyInstance, context: AppContext): void {
  userRoute(app, 'manager', 'GET', '/api/home', async (_request, reply, auth) =>
    sendJson(reply, await buildHome({ ...context.deps, seen: context.seen }, auth.userId)),
  );
  // Отметка «видел» — удобство интерфейса, а не действие над данными: в журнал действий не пишется.
  userRoute(app, 'manager', 'POST', '/api/seen', async (request, reply, auth) => {
    const body = parseInput(seenBody, request.body, reply);
    if (!body.ok) return reply;
    const ids = [...new Set(body.data.ids)];
    context.seen.mark(auth.userId, body.data.kind, ids, context.deps.clock.now());
    return sendJson(reply, { result: 'seen', kind: body.data.kind, count: ids.length });
  });
}
