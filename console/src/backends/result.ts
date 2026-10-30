/** За каким приложением раздел: почта (leads) или бот (wa). */
export type BackendName = 'leads' | 'wa';

/**
 * Почему приложение не дало данных:
 * unavailable — не отвечает, таймаут, 5xx без кода, ответ не JSON, больше предела или не по схеме;
 * auth — 401/403 от приложения (токен консоли не принят);
 * rejected — отказ по правилу приложения с кодом и понятным текстом (404, 409, 422, 429, 502, 503…);
 * unknown — только у действий: запрос ушёл, а ответа нет или он непонятен (таймаут, обрыв, 500, ответ не по схеме) —
 * действие могло выполниться.
 */
export type BackendFailure =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'auth' }
  | { readonly kind: 'unknown' }
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly code: string;
      readonly message: string | null;
      /** Целые поля отказа из белого списка, например activeRunId у 409 «идёт запуск». */
      readonly extra?: Readonly<Record<string, number>>;
    };

export type BackendResult<T = unknown> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | { readonly ok: false; readonly failure: BackendFailure };

export const UNAVAILABLE: BackendResult<never> = Object.freeze({
  ok: false,
  failure: Object.freeze({ kind: 'unavailable' }),
});

export const UNKNOWN_OUTCOME: BackendResult<never> = Object.freeze({
  ok: false,
  failure: Object.freeze({ kind: 'unknown' }),
});

/** Раздел ответа консоли, когда приложение не дало данных: остальные разделы при этом работают. */
export interface UnavailableSection {
  readonly unavailable: true;
  readonly reason: 'unavailable' | 'backend_auth';
}

export type Section<T> = T | UnavailableSection;

export function unavailableSection(failure: BackendFailure): UnavailableSection {
  return { unavailable: true, reason: failure.kind === 'auth' ? 'backend_auth' : 'unavailable' };
}

/** Раздел из результата: данные или пометка «недоступно» (отказ с кодом тоже значит «нет данных»). */
export function sectionOf<T, R>(result: BackendResult<T>, map: (data: T) => R): Section<R> {
  return result.ok ? map(result.data) : unavailableSection(result.failure);
}
