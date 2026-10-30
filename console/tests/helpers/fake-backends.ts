import type { FetchLike } from '../../src/backends/client.js';

export const LEADS_URL = 'http://127.0.0.1:8000';
export const WA_URL = 'http://127.0.0.1:3101';
export const LEADS_TOKEN = 'L'.repeat(40);
export const WA_TOKEN = 'W'.repeat(40);

const PREFIX = '/internal/console';

export interface RecordedCall {
  readonly backend: 'leads' | 'wa';
  readonly method: string;
  /** Путь без /internal/console, например /chats/12. */
  readonly path: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly init: RequestInit;
}

export type Handler = (call: RecordedCall) => Response | Promise<Response>;

/** Ответ приложения JSON со статусом и заголовками. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export interface FakeBackends {
  readonly fetch: FetchLike;
  readonly calls: RecordedCall[];
  /** Ответ на «METHOD backend:/путь», например «GET wa:/status»; значение — тело JSON (200) или обработчик. */
  on(key: string, response: unknown): void;
  /** Ответ на любой путь, для которого нет своего (по умолчанию — сетевой сбой). */
  fallback(handler: Handler): void;
  /** Все вызовы к приложению backend (по умолчанию все). */
  callsTo(backend?: 'leads' | 'wa'): RecordedCall[];
}

function headersOf(init: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init.headers).entries());
}

function bodyOf(init: RequestInit): unknown {
  return typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
}

/**
 * Подменённые почта и бот. Неизвестный путь — сетевой сбой (как не запущенное приложение): так проверяется
 * раздел «недоступно». Каждый вызов записывается с заголовками и телом.
 */
export function createFakeBackends(): FakeBackends {
  const routes = new Map<string, Handler>();
  let fallback: Handler | null = null;
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const backend = parsed.origin === LEADS_URL ? 'leads' : 'wa';
    const path = parsed.pathname.startsWith(PREFIX)
      ? parsed.pathname.slice(PREFIX.length)
      : parsed.pathname;
    const call: RecordedCall = {
      backend,
      method: init.method ?? 'GET',
      path,
      url: parsed,
      headers: headersOf(init),
      body: bodyOf(init),
      init,
    };
    calls.push(call);
    const handler = routes.get(`${call.method} ${backend}:${path}`) ?? fallback;
    if (handler === undefined || handler === null) {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    }
    return handler(call);
  };
  return {
    fetch,
    calls,
    on(key, response) {
      routes.set(
        key,
        typeof response === 'function' ? (response as Handler) : () => json(response),
      );
    },
    fallback(handler) {
      fallback = handler;
    },
    callsTo: (backend) => calls.filter((call) => backend === undefined || call.backend === backend),
  };
}
