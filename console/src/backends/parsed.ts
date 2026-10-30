import type { z } from 'zod';
import type { Logger } from '../shared/logger.js';
import type { BackendPath } from './paths.js';
import { UNAVAILABLE, UNKNOWN_OUTCOME, type BackendName, type BackendResult } from './result.js';

export interface ParseContext {
  readonly backend: BackendName;
  readonly path: BackendPath;
  readonly logger: Logger;
  /** Действие: ответ не по схеме значит «итог неизвестен» (действие могло выполниться), а не «недоступно». */
  readonly action?: boolean;
}

/**
 * Проверяет данные успешного ответа схемой. Не прошли: «недоступно» (у действия — «итог неизвестен»), в лог только
 * путь до поля и код ошибки схемы (без значений: в них имена, номера и тексты клиентов).
 */
export async function parsed<S extends z.ZodType>(
  request: Promise<BackendResult>,
  schema: S,
  context: ParseContext,
): Promise<BackendResult<z.output<S>>> {
  const result = await request;
  if (!result.ok) return result;
  const check = schema.safeParse(result.data);
  if (check.success) return { ok: true, status: result.status, data: check.data };
  const issues = check.error.issues
    .slice(0, 5)
    .map((issue) => ({ path: issue.path.map(String).join('.'), code: issue.code }));
  context.logger.warn(
    { backend: context.backend, path: context.path.pathname, issues },
    'Ответ приложения не прошёл проверку схемы',
  );
  return context.action === true ? UNKNOWN_OUTCOME : UNAVAILABLE;
}
