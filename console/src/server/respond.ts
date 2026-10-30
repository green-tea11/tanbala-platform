import type { FastifyReply } from 'fastify';
import type { BackendFailure, BackendName } from '../backends/result.js';
import { errorMessage, UNAVAILABLE_MESSAGES } from '../domain/messages.js';
import { JSON_TYPE } from './headers.js';

/** Ответ-отказ консоли: {error, message} и при необходимости поля сверху. */
export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message?: string | null,
  extra: Readonly<Record<string, unknown>> = {},
): FastifyReply {
  return reply
    .code(status)
    .type(JSON_TYPE)
    .send({ ...extra, error: code, message: message ?? errorMessage(code) });
}

/** Успешный ответ: всегда свой JSON (данные приложений уже скопированы заново). */
export function sendJson(reply: FastifyReply, body: unknown, status = 200): FastifyReply {
  return reply.code(status).type(JSON_TYPE).send(body);
}

/** Тексты 404 по виду данных, когда приложение своего текста не дало. */
export interface FailureTexts {
  readonly source: BackendName;
  readonly notFound?: string;
}

type Rejection = Extract<BackendFailure, { kind: 'rejected' }>;

function sendRejected(reply: FastifyReply, failure: Rejection, texts: FailureTexts): FastifyReply {
  const fallback = failure.status === 404 ? (texts.notFound ?? null) : null;
  return sendError(reply, failure.status, failure.code, failure.message ?? fallback, failure.extra);
}

function sendUnavailable(
  reply: FastifyReply,
  texts: FailureTexts,
  message: string | null,
): FastifyReply {
  return sendJson(reply, {
    unavailable: true,
    reason: 'unavailable',
    source: texts.source,
    message: message ?? UNAVAILABLE_MESSAGES[texts.source],
  });
}

/** Ответа нет, а запрос ушёл: действие могло выполниться, повторять вслепую нельзя. */
export const UNKNOWN_OUTCOME_MESSAGE =
  'Ответа от приложения нет: действие могло выполниться. Проверьте результат, прежде чем повторять.';

/**
 * Чтение не удалось. Приложение недоступно (в том числе его 5xx, например база недоступна): 200 и
 * {unavailable: true} — раздел показывает «недоступно», опросы идут дальше; отказ токена (401/403 приложения):
 * 502 backend_auth; отказ по правилу (400, 404, 409…): его статус, код и текст.
 */
export function sendReadFailure(
  reply: FastifyReply,
  failure: BackendFailure,
  texts: FailureTexts,
): FastifyReply {
  if (failure.kind === 'auth') return sendError(reply, 502, 'backend_auth');
  if (failure.kind !== 'rejected') return sendUnavailable(reply, texts, null);
  if (failure.status >= 500) return sendUnavailable(reply, texts, failure.message);
  return sendRejected(reply, failure, texts);
}

/**
 * Действие не удалось: приложение недоступно и запрос не ушёл — 503 backend_unavailable («не выполнено»); запрос ушёл,
 * а ответа нет — 502 unknown_outcome; отказ токена — 502 backend_auth; отказ по правилу — его статус, код и текст.
 */
export function sendActionFailure(
  reply: FastifyReply,
  failure: BackendFailure,
  texts: FailureTexts,
): FastifyReply {
  switch (failure.kind) {
    case 'unavailable': {
      const message = `${UNAVAILABLE_MESSAGES[texts.source]} Действие не выполнено.`;
      return sendError(reply, 503, 'backend_unavailable', message, { source: texts.source });
    }
    case 'unknown':
      return sendError(reply, 502, 'unknown_outcome', UNKNOWN_OUTCOME_MESSAGE, {
        source: texts.source,
      });
    case 'auth':
      return sendError(reply, 502, 'backend_auth');
    case 'rejected':
      return sendRejected(reply, failure, texts);
  }
}

const FAILURE_CODES: Readonly<Record<Exclude<BackendFailure['kind'], 'rejected'>, string>> = {
  unavailable: 'backend_unavailable',
  unknown: 'unknown_outcome',
  auth: 'backend_auth',
};

/** Код исхода для журнала: код отказа приложения или вид сбоя. */
export function failureCode(failure: BackendFailure): string {
  return failure.kind === 'rejected' ? failure.code : FAILURE_CODES[failure.kind];
}
