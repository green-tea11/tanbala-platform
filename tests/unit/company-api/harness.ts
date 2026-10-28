import { vi, type Mock } from 'vitest';
import {
  createCompanyDirectory,
  type CompanyApiDeps,
  type EnabledCompanyDirectory,
} from '../../../src/company-api/directory.js';
import type { CompanyFetch } from '../../../src/company-api/transport.js';
import { createFakeLogger, type LogEntry } from '../../helpers/fake-logger.js';

// Поддельный fetch для клиента внутреннего API: ни одного запроса в сеть, ответы готовятся в очереди.

export const BASE_URL = 'http://127.0.0.1:8000';
export const TOKEN = 'internal-token-0123456789-0123456789-abcdef';
export const START_MS = Date.UTC(2026, 9, 27, 12, 0, 0);

/** Запрос, который ушёл бы по сети. */
export interface SentRequest {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly redirect: RequestInit['redirect'];
}

export type Responder = (
  request: SentRequest,
  signal: AbortSignal | undefined,
) => Promise<Response>;

/** Ответ на запрос: готовый Response или функция, которая его строит (или не строит: висит, падает). */
export type Reply = Response | Responder;

export interface Clock {
  now(): number;
  set(ms: number): void;
  advance(ms: number): void;
}

export interface Harness {
  readonly directory: EnabledCompanyDirectory;
  readonly sent: SentRequest[];
  readonly logs: LogEntry[];
  readonly clock: Clock;
  readonly fetch: Mock<CompanyFetch>;
  /** Следующий запрос получит этот ответ; очередь по порядку. */
  reply(...responses: readonly Reply[]): void;
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function plain(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

/** Ответ с телом из кусков: так видно, где поток оборвётся. */
export function chunked(status: number, chunks: readonly Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'application/json' } });
}

/** Запрос, который не заканчивается, пока его не прервут (сигнал отмены). */
export function hanging(): Responder {
  return (_request, signal) =>
    new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        reject(new DOMException('This operation was aborted', 'AbortError'));
      });
    });
}

/** Запрос, который падает сетевой ошибкой, как fetch у undici: TypeError с причиной. */
export function networkError(code = 'ECONNREFUSED'): Responder {
  return () =>
    Promise.reject(
      new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code }) }),
    );
}

function headersOf(init: RequestInit): Readonly<Record<string, string>> {
  return { ...(init.headers as Record<string, string> | undefined) };
}

export function createHarness(overrides: Partial<CompanyApiDeps> = {}): Harness {
  const sent: SentRequest[] = [];
  const logs: LogEntry[] = [];
  const queue: Reply[] = [];
  let nowMs = START_MS;
  const fetchMock = vi.fn<CompanyFetch>((url, init) => {
    const request: SentRequest = {
      url,
      method: init.method,
      headers: headersOf(init),
      body: typeof init.body === 'string' ? init.body : undefined,
      redirect: init.redirect,
    };
    sent.push(request);
    const next = queue.shift();
    if (next === undefined) return Promise.reject(new Error('Ответ на запрос не подготовлен'));
    return typeof next === 'function'
      ? next(request, init.signal ?? undefined)
      : Promise.resolve(next);
  });
  const clock: Clock = {
    now: () => nowMs,
    set: (ms) => {
      nowMs = ms;
    },
    advance: (ms) => {
      nowMs += ms;
    },
  };
  const directory = createCompanyDirectory({
    baseUrl: BASE_URL,
    token: TOKEN,
    fetch: fetchMock,
    clock,
    logger: createFakeLogger(logs),
    ...overrides,
  });
  return {
    directory,
    sent,
    logs,
    clock,
    fetch: fetchMock,
    reply: (...responses) => {
      queue.push(...responses);
    },
  };
}
