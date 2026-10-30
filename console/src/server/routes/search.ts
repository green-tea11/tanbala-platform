import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hasControlChars } from '../../shared/text.js';
import type { AppContext } from '../context.js';
import { codeParam, idParams, pageParam, pageQuery, parseInput } from '../params.js';
import type { FailureTexts } from '../respond.js';
import { respondRead, runAction, userRoute } from './define.js';

const RUN_TEXTS: FailureTexts = { source: 'leads', notFound: 'Запуск не найден.' };
/** Длина поля отраслей у почты (MAX_QUERY_TEXT_LENGTH); число компаний на отрасль 1–20. */
const QUERY_TEXT_MAX = 620;
const COUNT_MAX = 20;

const runBody = z.object({
  // Отрасли через запятую, точку с запятой или с новой строки: перевод строки допускается.
  query: z
    .string()
    .max(QUERY_TEXT_MAX)
    .refine((value) => !hasControlChars(value, true)),
  city: codeParam,
  count: z.number().int().min(1).max(COUNT_MAX),
});

const researchQuery = z.object({ status: codeParam.optional(), page: pageParam.optional() });

function registerRunReads(app: FastifyInstance, context: AppContext): void {
  const { leads } = context.deps;
  userRoute(app, 'manager', 'GET', '/api/runs', async (request, reply) => {
    const query = parseInput(pageQuery, request.query, reply);
    return query.ok ? respondRead(reply, leads.runs(query.data.page), RUN_TEXTS) : reply;
  });
  userRoute(app, 'manager', 'GET', '/api/runs/active', async (_request, reply) =>
    respondRead(reply, leads.activeRun(), RUN_TEXTS),
  );
  userRoute(app, 'manager', 'GET', '/api/runs/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply);
    return params.ok ? respondRead(reply, leads.run(params.data.id), RUN_TEXTS) : reply;
  });
  userRoute(app, 'manager', 'GET', '/api/search/options', async (_request, reply) =>
    respondRead(reply, leads.searchOptions(), RUN_TEXTS),
  );
  userRoute(app, 'manager', 'GET', '/api/research-jobs', async (request, reply) => {
    const query = parseInput(researchQuery, request.query, reply);
    return query.ok ? respondRead(reply, leads.researchJobs(query.data), RUN_TEXTS) : reply;
  });
}

/**
 * Поиск компаний: прошлые запуски и ход любого, варианты поиска (города, подсказки, лимиты, цена), проверки из
 * WhatsApp; запуск поиска — только владелец (платный: 2ГИС и Claude).
 */
export function registerSearchRoutes(app: FastifyInstance, context: AppContext): void {
  registerRunReads(app, context);
  userRoute(app, 'owner', 'POST', '/api/runs', async (request, reply, auth) => {
    const body = parseInput(runBody, request.body, reply);
    if (!body.ok) return reply;
    return runAction(context, request, reply, auth, {
      action: 'run_start',
      target: null,
      texts: RUN_TEXTS,
      run: () => context.deps.leads.startRun(body.data, auth.userName),
      done: (data) => ({
        outcome: `run:${data.runId}`,
        body: {
          result: 'started',
          runId: data.runId,
          message: `Поиск запущен: запуск №${data.runId}.`,
        },
      }),
    });
  });
}
