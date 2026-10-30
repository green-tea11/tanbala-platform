import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BackendResult } from '../../backends/result.js';
import { LEADS_RESULT_MESSAGES } from '../../domain/messages.js';
import { almatyClock } from '../../domain/time.js';
import type { AppContext } from '../context.js';
import { emptyBody, idParam, idParams, pageParam, parseBoth, parseInput } from '../params.js';
import type { FailureTexts } from '../respond.js';
import { respondRead, runAction, userRoute } from './define.js';

const LETTER_TEXTS: FailureTexts = { source: 'leads', notFound: 'Письмо не найдено.' };
/** Пределы правки письма, как у почты (MAX_SUBJECT_LENGTH, MAX_BODY_LENGTH). */
const SUBJECT_MAX = 200;
const BODY_MAX = 10_000;

const lettersQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'all']).optional(),
  run: idParam.optional(),
  page: pageParam.optional(),
});

/** Пустую тему и длину проверяет почта со своими текстами; консоль режет только явный мусор. */
const editBody = z.object({
  subject: z.string().max(SUBJECT_MAX * 2),
  body: z.string().max(BODY_MAX * 2),
});

type SimpleAction = 'approve' | 'reject';

const SIMPLE_ACTIONS: Readonly<Record<SimpleAction, { audit: string; message: string }>> = {
  approve: { audit: 'letter_approve', message: LEADS_RESULT_MESSAGES.approved },
  reject: { audit: 'letter_reject', message: LEADS_RESULT_MESSAGES.rejected },
};

function registerLetterReads(app: FastifyInstance, context: AppContext): void {
  const { leads } = context.deps;
  userRoute(app, 'manager', 'GET', '/api/letters', async (request, reply) => {
    const query = parseInput(lettersQuery, request.query, reply);
    return query.ok ? respondRead(reply, leads.letters(query.data), LETTER_TEXTS) : reply;
  });
  userRoute(app, 'manager', 'GET', '/api/letters/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply);
    return params.ok ? respondRead(reply, leads.letter(params.data.id), LETTER_TEXTS) : reply;
  });
}

function registerSimpleAction(app: FastifyInstance, context: AppContext, kind: SimpleAction): void {
  const spec = SIMPLE_ACTIONS[kind];
  userRoute(app, 'owner', 'POST', `/api/letters/:id/${kind}`, async (request, reply, auth) => {
    const input = parseBoth(reply, [idParams, request.params], [emptyBody, request.body]);
    if (!input.ok) return reply;
    const [{ id }] = input.data;
    const run = (): Promise<BackendResult<{ readonly result: string }>> =>
      kind === 'approve'
        ? context.deps.leads.approve(id, auth.userName)
        : context.deps.leads.reject(id, auth.userName);
    return runAction(context, request, reply, auth, {
      action: spec.audit,
      target: `draft:${id}`,
      texts: LETTER_TEXTS,
      run,
      done: (data) => ({
        outcome: data.result,
        body: { result: data.result, message: spec.message },
      }),
    });
  });
}

function registerLetterActions(app: FastifyInstance, context: AppContext): void {
  const { leads } = context.deps;
  registerSimpleAction(app, context, 'approve');
  registerSimpleAction(app, context, 'reject');
  // Правка: проверки прогоняются заново, одобрение снимается.
  userRoute(app, 'owner', 'POST', '/api/letters/:id/edit', async (request, reply, auth) => {
    const input = parseBoth(reply, [idParams, request.params], [editBody, request.body]);
    if (!input.ok) return reply;
    const [{ id }, body] = input.data;
    return runAction(context, request, reply, auth, {
      action: 'letter_edit',
      target: `draft:${id}`,
      texts: LETTER_TEXTS,
      run: () => leads.edit(id, body, auth.userName),
      done: (data) => ({
        outcome: 'saved',
        body: {
          result: 'saved',
          checksTotal: data.checksTotal,
          checksFailed: data.checksFailed,
          message: LEADS_RESULT_MESSAGES.saved,
        },
      }),
    });
  });
  // Тест письма: уходит только на тестовый адрес владельца, компании не отправляется.
  userRoute(app, 'owner', 'POST', '/api/letters/:id/send-test', async (request, reply, auth) => {
    const input = parseBoth(reply, [idParams, request.params], [emptyBody, request.body]);
    if (!input.ok) return reply;
    const [{ id }] = input.data;
    return runAction(context, request, reply, auth, {
      action: 'letter_send_test',
      target: `draft:${id}`,
      texts: LETTER_TEXTS,
      run: () => leads.sendTest(id, auth.userName),
      done: (data) => ({
        outcome: 'sent',
        body: {
          result: 'sent',
          sentTo: data.sentTo,
          at: data.at,
          message: `Тест отправлен на ${data.sentTo} в ${almatyClock(Date.parse(data.at))}.`,
        },
      }),
    });
  });
}

/** Письма: очередь и письмо целиком; одобрить, отклонить, изменить, тест (только владелец). */
export function registerLetterRoutes(app: FastifyInstance, context: AppContext): void {
  registerLetterReads(app, context);
  registerLetterActions(app, context);
}
