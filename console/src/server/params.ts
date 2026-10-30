import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { isValidDay } from '../domain/time.js';
import { codePointLength, hasControlChars } from '../shared/text.js';
import { sendError } from './respond.js';

/** id из адреса: только целое от 1, без знаков и ведущих нулей, не больше 2^53. */
export const idParam = z
  .string()
  .regex(/^[1-9]\d{0,15}$/)
  .transform(Number)
  .refine(Number.isSafeInteger);

/** Номер страницы с 1. */
export const pageParam = z
  .string()
  .regex(/^[1-9]\d{0,5}$/)
  .transform(Number);

/** Флаг фильтра «1» (как в контракте: wa=1, blocked=1, letter=1, waiting=1). */
export const flagParam = z.literal('1').transform(() => 1 as const);

/** День ГГГГ-ММ-ДД, настоящая дата. */
export const dayParam = z.string().refine(isValidDay);

/** Текст фильтра или поиска: без управляющих символов, до max символов Unicode (как считают приложения). */
export function searchText(max: number) {
  return z
    .string()
    .max(max * 2)
    .refine((value) => !hasControlChars(value) && codePointLength(value) <= max)
    .transform((value) => value.trim());
}

/** Код из белого списка вида status=pending (латиница, подчёркивание). */
export const codeParam = z.string().regex(/^[a-z_]{1,32}$/);

export const idParams = z.object({ id: idParam });
export const pageQuery = z.object({ page: pageParam.optional() });

/** Пустое тело действия: {} (поля, если пришли, не нужны и не передаются). */
export const emptyBody = z.object({});

export type Parsed<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };

/** Путь до неверного поля для текста ошибки: только имена полей, без значений. */
function fieldList(error: z.ZodError): string {
  const fields = [...new Set(error.issues.map((issue) => issue.path.map(String).join('.')))];
  return fields.filter((field) => field !== '').join(', ');
}

/**
 * Проверяет вход схемой; неверный — ответ 400 bad_request с перечнем полей (без значений) и ok: false.
 * Лишние поля отбрасываются: дальше идёт только то, что объявлено в схеме.
 */
export function parseInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
  reply: FastifyReply,
): Parsed<z.output<S>> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return { ok: true, data: result.data };
  const fields = fieldList(result.error);
  sendError(reply, 400, 'bad_request', fields === '' ? null : `Неверный запрос: ${fields}.`);
  return { ok: false };
}

/** Две части запроса сразу (например, id из адреса и тело): первая неверная отвечает 400. */
export function parseBoth<A extends z.ZodType, B extends z.ZodType>(
  reply: FastifyReply,
  first: readonly [A, unknown],
  second: readonly [B, unknown],
): Parsed<readonly [z.output<A>, z.output<B>]> {
  const a = parseInput(first[0], first[1], reply);
  if (!a.ok) return a;
  const b = parseInput(second[0], second[1], reply);
  if (!b.ok) return b;
  return { ok: true, data: [a.data, b.data] };
}
