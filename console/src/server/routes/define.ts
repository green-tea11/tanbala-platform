import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BackendResult } from '../../backends/result.js';
import type { SessionRecord } from '../../db/sessions.js';
import type { AppContext } from '../context.js';
import {
  failureCode,
  sendActionFailure,
  sendError,
  sendJson,
  sendReadFailure,
  type FailureTexts,
} from '../respond.js';
import type { Access } from '../types.js';

type Method = 'GET' | 'POST';

export type PublicHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>;
export type UserHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
  auth: SessionRecord,
) => Promise<FastifyReply>;

interface RouteOptions {
  readonly bodyLimit?: number;
}

/** Открытый маршрут (вход, выход, статика, /healthz): доступ public объявлен явно. */
export function publicRoute(
  app: FastifyInstance,
  method: Method,
  url: string,
  handler: PublicHandler,
  options: RouteOptions = {},
): void {
  app.route({ method, url, config: { access: 'public' }, ...options, handler });
}

/**
 * Маршрут для вошедших с ролью manager (менеджер и владелец) или owner. Роль проверяет хук onRequest (по
 * config.access); обработчик ещё раз убеждается, что сессия есть, и получает её третьим аргументом.
 */
export function userRoute(
  app: FastifyInstance,
  access: Exclude<Access, 'public'>,
  method: Method,
  url: string,
  handler: UserHandler,
  options: RouteOptions = {},
): void {
  app.route({
    method,
    url,
    config: { access },
    ...options,
    handler: (request, reply) => {
      const auth = request.auth;
      if (auth === null) return Promise.resolve(sendError(reply, 403, 'no_session'));
      return handler(request, reply, auth);
    },
  });
}

/** Ответ на чтение из одного приложения: данные или отказ по правилам sendReadFailure. */
export async function respondRead(
  reply: FastifyReply,
  request: Promise<BackendResult>,
  texts: FailureTexts,
): Promise<FastifyReply> {
  const result = await request;
  return result.ok ? sendJson(reply, result.data) : sendReadFailure(reply, result.failure, texts);
}

export interface ActionSpec<T> {
  readonly action: string;
  /** Над чем: «chat:12», «draft:5»… — только id. */
  readonly target: string | null;
  readonly texts: FailureTexts;
  readonly run: () => Promise<BackendResult<T>>;
  /** Тело успешного ответа и код исхода для журнала. */
  readonly done: (data: T) => { readonly outcome: string; readonly body: Record<string, unknown> };
}

export interface Refusal {
  readonly action: string;
  readonly target: string | null;
  readonly status: number;
  readonly code: string;
  readonly message: string;
  /** Код исхода для журнала, если отличается от code. */
  readonly outcome?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** Консоль отказала в действии сама, до вызова приложения: запись в журнал и ответ-отказ. */
export function refuseAction(
  context: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  auth: SessionRecord,
  refusal: Refusal,
): FastifyReply {
  context.record({
    actor: auth.userName,
    action: refusal.action,
    target: refusal.target,
    outcome: refusal.outcome ?? refusal.code,
    ip: request.ip,
  });
  return sendError(reply, refusal.status, refusal.code, refusal.message, refusal.extra);
}

/** Действие через приложение: вызов, запись в журнал (кто, что, над чем, итог), ответ. */
export async function runAction<T>(
  context: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  auth: SessionRecord,
  spec: ActionSpec<T>,
): Promise<FastifyReply> {
  const result = await spec.run();
  const entry = { actor: auth.userName, action: spec.action, target: spec.target, ip: request.ip };
  if (!result.ok) {
    context.record({ ...entry, outcome: failureCode(result.failure) });
    return sendActionFailure(reply, result.failure, spec.texts);
  }
  const done = spec.done(result.data);
  context.record({ ...entry, outcome: done.outcome });
  return sendJson(reply, done.body);
}
