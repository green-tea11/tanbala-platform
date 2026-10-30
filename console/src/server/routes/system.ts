import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isAlive } from '../../auth/sessions.js';
import { sectionOf } from '../../backends/result.js';
import type { SessionRecord } from '../../db/sessions.js';
import { addDays, almatyDay, daysInclusive } from '../../domain/time.js';
import { buildSpendReport } from '../../services/spend-report.js';
import type { AppContext } from '../context.js';
import { dayParam, emptyBody, idParams, pageQuery, parseBoth, parseInput } from '../params.js';
import { sendError, sendJson } from '../respond.js';
import { userRoute } from './define.js';

const AUDIT_PAGE_SIZE = 50;

/** Живые сессии: истёкшие, которые уборка ещё не удалила, не показываются. */
function liveSessions(context: AppContext): readonly SessionRecord[] {
  const nowMs = context.deps.clock.now();
  return context.sessionsRepo.listAll().filter((session) => isAlive(session, nowMs));
}
/** Расход по дням: не больше 62 дней (предел приложений), по умолчанию последние 30. */
const SPEND_MAX_DAYS = 62;
const SPEND_DEFAULT_DAYS = 30;

const spendQuery = z.object({ from: dayParam.optional(), to: dayParam.optional() });

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function registerOverview(app: FastifyInstance, context: AppContext): void {
  const { leads, wa, clock } = context.deps;
  // Состояние бота и почты, лимиты за сутки.
  userRoute(app, 'owner', 'GET', '/api/system', async (_request, reply) => {
    const [status, summary] = await Promise.all([wa.status(), leads.summary()]);
    return sendJson(reply, {
      botStatus: sectionOf(status, (data) => data),
      leadsSummary: sectionOf(summary, (data) => data),
    });
  });
  userRoute(app, 'owner', 'GET', '/api/system/spend', async (request, reply) => {
    const query = parseInput(spendQuery, request.query, reply);
    if (!query.ok) return reply;
    const to = query.data.to ?? almatyDay(clock.now());
    const from = query.data.from ?? addDays(to, 1 - SPEND_DEFAULT_DAYS);
    const days = daysInclusive(from, to);
    if (days < 1 || days > SPEND_MAX_DAYS) {
      return sendError(reply, 400, 'bad_request', `Период от 1 до ${SPEND_MAX_DAYS} дней.`);
    }
    return sendJson(reply, await buildSpendReport(context.deps, from, to));
  });
}

function registerRecords(app: FastifyInstance, context: AppContext): void {
  userRoute(app, 'owner', 'GET', '/api/system/audit', async (request, reply) => {
    const query = parseInput(pageQuery, request.query, reply);
    if (!query.ok) return reply;
    const page = query.data.page ?? 1;
    const { items, total } = context.audit.page(page, AUDIT_PAGE_SIZE);
    return sendJson(reply, {
      items: items.map((item) => ({ ...item, at: iso(item.at) })),
      total,
      page,
      pages: Math.ceil(total / AUDIT_PAGE_SIZE),
      pageSize: AUDIT_PAGE_SIZE,
    });
  });
  // Пользователи только для чтения: заводят и меняют их командой на сервере.
  userRoute(app, 'owner', 'GET', '/api/system/users', async (_request, reply) => {
    const sessions = liveSessions(context);
    const items = context.users.list().map((user) => ({
      name: user.name,
      role: user.role,
      active: user.active,
      createdAt: iso(user.createdAt),
      updatedAt: iso(user.updatedAt),
      sessions: sessions.filter((session) => session.userId === user.id).length,
    }));
    return sendJson(reply, { items });
  });
  userRoute(app, 'owner', 'GET', '/api/system/sessions', async (_request, reply, auth) => {
    const items = liveSessions(context).map((session) => ({
      id: session.id,
      user: session.userName,
      role: session.role,
      device: session.userAgent,
      ip: session.ip,
      createdAt: iso(session.createdAt),
      lastSeenAt: iso(session.lastSeenAt),
      current: session.id === auth.id,
    }));
    return sendJson(reply, { items });
  });
}

function registerSessionActions(app: FastifyInstance, context: AppContext): void {
  userRoute(
    app,
    'owner',
    'POST',
    '/api/system/sessions/:id/revoke',
    async (request, reply, auth) => {
      const input = parseBoth(reply, [idParams, request.params], [emptyBody, request.body]);
      if (!input.ok) return reply;
      const [{ id }] = input.data;
      const closed = context.sessionsRepo.deleteById(id);
      context.record({
        actor: auth.userName,
        action: 'session_revoke',
        target: `session:${id}`,
        outcome: closed ? 'revoked' : 'not_found',
        ip: request.ip,
      });
      if (!closed) return sendError(reply, 404, 'not_found', 'Сессия не найдена.');
      return sendJson(reply, { result: 'revoked', message: 'Сессия закрыта.' });
    },
  );
  // «Выйти везде»: закрыть все сессии всех пользователей, кроме текущей.
  userRoute(
    app,
    'owner',
    'POST',
    '/api/system/sessions/revoke-all',
    async (request, reply, auth) => {
      const body = parseInput(emptyBody, request.body, reply);
      if (!body.ok) return reply;
      const count = context.sessionsRepo.deleteAllExcept(auth.id);
      context.record({
        actor: auth.userName,
        action: 'session_revoke_all',
        outcome: `closed:${count}`,
        ip: request.ip,
      });
      return sendJson(reply, {
        result: 'revoked',
        count,
        message: `Закрыто сессий: ${count}. Текущая сессия осталась.`,
      });
    },
  );
}

/** «Система» (только владелец): состояние, расход по дням, журнал действий, пользователи и сессии. */
export function registerSystemRoutes(app: FastifyInstance, context: AppContext): void {
  registerOverview(app, context);
  registerRecords(app, context);
  registerSessionActions(app, context);
}
