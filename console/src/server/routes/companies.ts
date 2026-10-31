import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LEADS_RESULT_MESSAGES } from '../../domain/messages.js';
import { buildCompanyCard } from '../../services/cards.js';
import type { AppContext } from '../context.js';
import {
  emptyBody,
  flagParam,
  idParam,
  idParams,
  pageParam,
  parseBoth,
  parseInput,
  searchText,
} from '../params.js';
import { sendJson, sendReadFailure, type FailureTexts } from '../respond.js';
import { respondRead, runAction, userRoute } from './define.js';

const COMPANY_TEXTS: FailureTexts = { source: 'leads', notFound: 'Компания не найдена.' };
/** Отрасль (query) почта принимает до 60 символов, поиск по названию (q) — до 100. */
const INDUSTRY_MAX = 60;

/**
 * Статусы компании почты (COMPANY_STATUSES в leads/tanbala_leads/web/labels.py): 9 статусов базы
 * и no_email — «Нет почты» (в базе rejected без оценки, отдельная карточка быстрого фильтра).
 */
const COMPANY_STATUSES = [
  'new',
  'crawled',
  'qualified',
  'rejected',
  'no_email',
  'verified',
  'drafted',
  'approved',
  'sent',
  'replied',
] as const;

const companiesQuery = z.object({
  status: z.enum(COMPANY_STATUSES).optional(),
  query: searchText(INDUSTRY_MAX).optional(),
  run: idParam.optional(),
  q: searchText(100).optional(),
  via: z.enum(['whatsapp', 'regular']).optional(),
  wa: flagParam.optional(),
  blocked: flagParam.optional(),
  letter: flagParam.optional(),
  sort: z.enum(['new', 'score', 'letter']).optional(),
  page: pageParam.optional(),
});

function registerCompanyReads(app: FastifyInstance, context: AppContext): void {
  userRoute(app, 'manager', 'GET', '/api/companies', async (request, reply) => {
    const query = parseInput(companiesQuery, request.query, reply);
    return query.ok
      ? respondRead(reply, context.deps.leads.companies(query.data), COMPANY_TEXTS)
      : reply;
  });
  userRoute(app, 'manager', 'GET', '/api/companies/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply);
    if (!params.ok) return reply;
    const card = await buildCompanyCard(context.deps, params.data.id);
    return card.ok
      ? sendJson(reply, card.body)
      : sendReadFailure(reply, card.failure, COMPANY_TEXTS);
  });
}

function registerCompanyActions(app: FastifyInstance, context: AppContext): void {
  const { leads } = context.deps;
  // «Больше не писать»: компания, её домен и адреса в список «не писать». Не отменяется.
  userRoute(app, 'owner', 'POST', '/api/companies/:id/block', async (request, reply, auth) => {
    const input = parseBoth(reply, [idParams, request.params], [emptyBody, request.body]);
    if (!input.ok) return reply;
    const [{ id }] = input.data;
    return runAction(context, request, reply, auth, {
      action: 'company_block',
      target: `company:${id}`,
      texts: COMPANY_TEXTS,
      run: () => leads.block(id, auth.userName),
      done: () => ({
        outcome: 'blocked',
        body: { result: 'blocked', message: LEADS_RESULT_MESSAGES.blocked },
      }),
    });
  });
  // «Снять отметку WhatsApp»: компания становится обычной и может попасть в рассылку.
  userRoute(
    app,
    'owner',
    'POST',
    '/api/companies/:id/whatsapp-clear',
    async (request, reply, auth) => {
      const input = parseBoth(reply, [idParams, request.params], [emptyBody, request.body]);
      if (!input.ok) return reply;
      const [{ id }] = input.data;
      return runAction(context, request, reply, auth, {
        action: 'company_whatsapp_clear',
        target: `company:${id}`,
        texts: COMPANY_TEXTS,
        run: () => leads.clearWhatsapp(id, auth.userName),
        done: (data) => ({
          outcome: 'cleared',
          body: {
            result: 'cleared',
            wasRequestedVia: data.wasRequestedVia ?? null,
            message: LEADS_RESULT_MESSAGES.cleared,
          },
        }),
      });
    },
  );
}

/** Компании почты: список с фильтрами, карточка со связанными чатами; «не писать» и «снять отметку WhatsApp». */
export function registerCompanyRoutes(app: FastifyInstance, context: AppContext): void {
  registerCompanyReads(app, context);
  registerCompanyActions(app, context);
}
