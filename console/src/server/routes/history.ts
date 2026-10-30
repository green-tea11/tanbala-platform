import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { pageQuery, parseInput } from '../params.js';
import type { FailureTexts } from '../respond.js';
import { respondRead, runAction, userRoute } from './define.js';

const HISTORY_TEXTS: FailureTexts = { source: 'leads' };
/** Тело импорта до 1.5 МБ: файл до 1 МБ в base64 плюс текст (как предел почты). */
export const IMPORT_BODY_LIMIT = Math.floor(1.5 * 1024 * 1024);
const FILE_BASE64_MAX = Math.ceil((1024 * 1024 * 4) / 3) + 4;
const TEXT_MAX = 1024 * 1024;

const importBody = z
  .object({
    kind: z.enum(['written', 'refused']),
    text: z.string().max(TEXT_MAX).optional(),
    fileBase64: z
      .string()
      .max(FILE_BASE64_MAX)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .optional(),
  })
  .refine((body) => (body.text ?? '') !== '' || (body.fileBase64 ?? '') !== '', {
    message: 'нужен текст или файл',
    path: ['text'],
  });

function importMessage(added: number, existing: number, invalid: number): string {
  return `Добавлено: ${added}. Уже были (в том числе из «не писать»): ${existing}. Не распознано: ${invalid}.`;
}

/** «Кому писали»: история писем и «не писать»; два импорта (только владелец). */
export function registerHistoryRoutes(app: FastifyInstance, context: AppContext): void {
  const { leads } = context.deps;
  userRoute(app, 'manager', 'GET', '/api/history', async (request, reply) => {
    const query = parseInput(pageQuery, request.query, reply);
    return query.ok ? respondRead(reply, leads.history(query.data.page), HISTORY_TEXTS) : reply;
  });
  userRoute(app, 'manager', 'GET', '/api/blocked', async (request, reply) => {
    const query = parseInput(pageQuery, request.query, reply);
    return query.ok ? respondRead(reply, leads.blocked(query.data.page), HISTORY_TEXTS) : reply;
  });
  userRoute(
    app,
    'owner',
    'POST',
    '/api/history/import',
    async (request, reply, auth) => {
      const body = parseInput(importBody, request.body, reply);
      if (!body.ok) return reply;
      return runAction(context, request, reply, auth, {
        action: `history_import_${body.data.kind}`,
        target: null,
        texts: HISTORY_TEXTS,
        run: () => leads.importHistory(body.data, auth.userName),
        done: (data) => ({
          outcome: `added:${data.added}`,
          body: {
            result: 'imported',
            added: data.added,
            existing: data.existing,
            invalid: data.invalid,
            invalidMore: data.invalidMore,
            message: importMessage(
              data.added,
              data.existing,
              data.invalid.length + data.invalidMore,
            ),
          },
        }),
      });
    },
    { bodyLimit: IMPORT_BODY_LIMIT },
  );
}
