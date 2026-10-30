import type { Session } from './types';

// Запросы к /api консоли (console/docs/API.md): cookie сессии шлёт браузер, у POST — JSON и X-CSRF-Token.

export interface ApiError {
  readonly status: number;
  readonly error: string;
  readonly message: string;
}

export type ApiResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly failure: ApiError };

const NETWORK_FAILURE: ApiError = { status: 0, error: 'network', message: 'Нет связи с сервером, пробую снова.' };

let csrfToken: string | null = null;

function asApiError(status: number, body: unknown): ApiError {
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    const error = typeof record['error'] === 'string' ? record['error'] : `http_${status}`;
    const message = typeof record['message'] === 'string' ? record['message'] : 'Сервер ответил ошибкой.';
    return { status, error, message };
  }
  return status >= 500 ? NETWORK_FAILURE : { status, error: `http_${status}`, message: 'Сервер ответил ошибкой.' };
}

async function exchange<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  } catch {
    return { ok: false, failure: NETWORK_FAILURE };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok) return { ok: true, data: body as T };
  return { ok: false, failure: asApiError(response.status, body) };
}

/** Чтение. poll — фоновый опрос: он не продлевает сессию (X-Console-Poll). */
export function apiGet<T>(path: string, poll = false): Promise<ApiResult<T>> {
  return exchange<T>(path, { method: 'GET', headers: poll ? { 'X-Console-Poll': '1' } : {} });
}

export async function loadSession(): Promise<ApiResult<Session>> {
  const result = await apiGet<Session>('/api/session');
  if (result.ok) csrfToken = result.data.csrfToken;
  return result;
}

/** Действие: JSON-тело (даже пустое) и токен CSRF; устаревший токен перечитывается один раз. */
export async function apiPost<T>(path: string, body: Readonly<Record<string, unknown>> = {}): Promise<ApiResult<T>> {
  if (csrfToken === null) await loadSession();
  const send = (): Promise<ApiResult<T>> =>
    exchange<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken ?? '' },
      body: JSON.stringify(body),
    });
  const first = await send();
  if (first.ok || first.failure.error !== 'csrf') return first;
  await loadSession();
  return send();
}
