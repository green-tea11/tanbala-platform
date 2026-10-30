import type { Clock } from '../shared/clock.js';
import { ACTION_BODY_LIMIT_BYTES } from '../shared/limits.js';
import type { Logger } from '../shared/logger.js';
import { cleanLine } from '../shared/text.js';
import { createReadBreaker, type ReadBreaker } from './breaker.js';
import { createReadCache } from './read-cache.js';
import { CONSOLE_PREFIX, type BackendPath } from './paths.js';
import { readLimitedBytes } from './read-limited.js';
import { UNAVAILABLE, UNKNOWN_OUTCOME, type BackendName, type BackendResult } from './result.js';
import { parseSafeJson } from './safe-json.js';
import { createSemaphore, type Semaphore } from './semaphore.js';

/** fetch так, как его вызывает клиент: адрес строкой и настройки. В тестах подменяется. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface BackendClientOptions {
  readonly name: BackendName;
  /** http://127.0.0.1:<порт> (проверено config/env). */
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch: FetchLike;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly limits?: Partial<ClientLimits>;
}

export interface ClientLimits {
  readonly getTimeoutMs: number;
  /** Тестовое письмо ждёт SMTP до 30 с: у действий срок больше. */
  readonly postTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxConcurrent: number;
  /** Сколько из maxConcurrent мест чтения не занимают: они остаются действиям. */
  readonly reservedForActions: number;
  readonly maxQueued: number;
  readonly cacheMs: number;
}

export interface BackendClient {
  readonly name: BackendName;
  /**
   * Чтение: одинаковые одновременные запросы объединяются, ответ кэшируется на 1.5 с. После 3 таймаутов подряд
   * чтения 10 с сразу получают «недоступно» (предохранитель). Не бросает.
   */
  get(path: BackendPath): Promise<BackendResult>;
  /**
   * Действие от имени пользователя консоли (X-Console-User). Сбрасывает кэш чтения. Тело больше maxBodyBytes
   * (у приложений 16 КБ, у правки письма 32 КБ, у импорта 1.5 МБ) не отправляется: отказ 413. Одно место из 4
   * всегда оставлено действиям. Не бросает.
   */
  post(
    path: BackendPath,
    body: Readonly<Record<string, unknown>>,
    user: string,
    maxBodyBytes?: number,
  ): Promise<BackendResult>;
}

export const DEFAULT_CLIENT_LIMITS: ClientLimits = {
  getTimeoutMs: 8_000,
  postTimeoutMs: 35_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxConcurrent: 4,
  reservedForActions: 1,
  maxQueued: 100,
  cacheMs: 1_500,
};

/** Сообщения о недоступности в лог не чаще раза в минуту, об отказе токена — раз в 10 минут. */
const OUTAGE_LOG_INTERVAL_MS = 60_000;
const AUTH_LOG_INTERVAL_MS = 10 * 60_000;
const ERROR_CODE = /^[a-z_]{1,40}$/;
const MESSAGE_MAX = 500;
/** Статусы отказа, которые консоль передаёт дальше со своим кодом и текстом. */
const REJECT_STATUSES: ReadonlySet<number> = new Set([400, 404, 409, 413, 422, 429, 502, 503]);
const FALLBACK_CODES: Readonly<Record<number, string>> = {
  400: 'bad_request',
  404: 'not_found',
  409: 'conflict',
  413: 'too_large',
  422: 'refused',
  429: 'rate_limited',
  502: 'send_failed',
};
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** Целые поля отказа, которые консоль передаёт дальше (номер идущего запуска у 409 почты). */
const EXTRA_INTEGER_FIELDS: readonly string[] = ['activeRunId'];
/**
 * Сбои, при которых запрос точно не дошёл до приложения: соединение не открылось (отказ, нет доступа, нет сети или
 * адреса) или запрос не вышел из очереди консоли.
 */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'EACCES',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'queue_full',
  'timeout_in_queue',
]);
const TIMEOUT_CODE = 'timeout';

interface ExchangeInit {
  readonly method: 'GET' | 'POST';
  readonly body?: string;
  readonly user: string | null;
}

interface ClientContext {
  readonly options: BackendClientOptions;
  readonly limits: ClientLimits;
  readonly semaphore: Semaphore;
  readonly breaker: ReadBreaker;
  readonly logState: { outageAt: number; authAt: number };
}

/** Код сбоя для лога: таймаут, код ошибки или её причины (так undici отдаёт ECONNREFUSED). */
export function errorCodeOf(error: unknown): string {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return TIMEOUT_CODE;
  }
  const pick = (value: unknown): string | null => {
    if (typeof value !== 'object' || value === null) return null;
    const code = (value as { code?: unknown }).code;
    return typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : null;
  };
  const cause =
    typeof error === 'object' && error !== null ? (error as { cause?: unknown }).cause : null;
  return pick(error) ?? pick(cause) ?? 'network_error';
}

/** Ответ с отказом: код и текст из тела, если они есть и годятся; иначе код по статусу. null — не отказ. */
export function rejectionOf(status: number, json: unknown): BackendResult | null {
  if (!REJECT_STATUSES.has(status)) return null;
  const body = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  const rawCode = body['error'];
  const code = typeof rawCode === 'string' && ERROR_CODE.test(rawCode) ? rawCode : null;
  const finalCode = code ?? FALLBACK_CODES[status];
  if (finalCode === undefined) return null;
  const rawMessage = body['message'];
  const message =
    typeof rawMessage === 'string' ? cleanLine(rawMessage, MESSAGE_MAX) || null : null;
  const extra = Object.fromEntries(
    EXTRA_INTEGER_FIELDS.flatMap((field) => {
      const value = body[field];
      return typeof value === 'number' && Number.isSafeInteger(value) ? [[field, value]] : [];
    }),
  );
  return {
    ok: false,
    failure: {
      kind: 'rejected',
      status,
      code: finalCode,
      message,
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    },
  };
}

/** Тело ответа не нужно: поток закрывается, соединение не держит лишнее. */
function cancelBody(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Статус и тело приложения → результат консоли. 401/403 — отказ токена, тело не читается. Непонятный ответ
 * (unclear): у чтения — «недоступно», у действия — «итог неизвестен» (запрос дошёл, действие могло выполниться).
 */
async function interpret(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  unclear: BackendResult,
): Promise<BackendResult> {
  const { status } = response;
  if (status === 401 || status === 403) {
    cancelBody(response);
    return { ok: false, failure: { kind: 'auth' } };
  }
  const bytes = await readLimitedBytes(response, maxBytes, signal);
  const text = bytes === null ? null : decodeUtf8(bytes);
  const json = text === null ? undefined : parseSafeJson(text);
  if (status >= 200 && status <= 299) {
    return json === undefined ? unclear : { ok: true, status, data: json };
  }
  return rejectionOf(status, json) ?? unclear;
}

function logFailure(
  context: ClientContext,
  result: BackendResult,
  path: BackendPath,
  code: string,
): void {
  if (result.ok) return;
  const { options, logState } = context;
  const nowMs = options.clock.now();
  if (result.failure.kind === 'auth' && nowMs - logState.authAt >= AUTH_LOG_INTERVAL_MS) {
    logState.authAt = nowMs;
    options.logger.error(
      { backend: options.name, path: path.pathname },
      'Приложение не приняло токен консоли: проверьте LEADS_CONSOLE_TOKEN и WA_CONSOLE_TOKEN',
    );
  }
  const outage = result.failure.kind === 'unavailable' || result.failure.kind === 'unknown';
  if (outage && nowMs - logState.outageAt >= OUTAGE_LOG_INTERVAL_MS) {
    logState.outageAt = nowMs;
    options.logger.warn(
      { backend: options.name, path: path.pathname, code },
      'Приложение недоступно',
    );
  }
}

/** Полный адрес, если он остался на origin приложения и под /internal/console; иначе null. */
function urlOf(baseUrl: string, path: BackendPath): string | null {
  const url = new URL(path.full, baseUrl);
  const sameOrigin = url.origin === baseUrl;
  return sameOrigin && url.pathname.startsWith(`${CONSOLE_PREFIX}/`) ? url.href : null;
}

function requestInit(context: ClientContext, init: ExchangeInit, signal: AbortSignal): RequestInit {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Console-Token': context.options.token,
    ...(init.user === null ? {} : { 'X-Console-User': init.user }),
    ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
  };
  return {
    method: init.method,
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
    redirect: 'error',
    signal,
  };
}

/** Сбой обмена: у чтения — «недоступно»; у действия — «недоступно», только если запрос точно не ушёл. */
function failureFor(init: ExchangeInit, code: string): BackendResult {
  return init.method === 'GET' || NOT_SENT_CODES.has(code) ? UNAVAILABLE : UNKNOWN_OUTCOME;
}

/**
 * Ждёт ответ, но не дольше срока signal: fetch, не услышавший отмену, не держит очередь вечно. Ответ, пришедший уже
 * после срока, не нужен: его тело закрывается.
 */
function untilAborted(work: Promise<Response>, signal: AbortSignal): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const onAbort = (): void =>
      reject(Object.assign(new Error('Срок вышел'), { name: 'AbortError' }));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    work.then(
      (response) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) cancelBody(response);
        else resolve(response);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('Сбой запроса'));
      },
    );
  });
}

/** Обмен после получения места в очереди: запрос, чтение тела, разбор. Не бросает. */
async function sendOnce(
  context: ClientContext,
  url: string,
  init: ExchangeInit,
  signal: AbortSignal,
): Promise<{ readonly result: BackendResult; readonly code: string }> {
  try {
    const request = context.options.fetch(url, requestInit(context, init, signal));
    const response = await untilAborted(request, signal);
    const unclear = failureFor(init, 'bad_response');
    const result = await interpret(response, context.limits.maxResponseBytes, signal, unclear);
    return { result, code: `status_${response.status}` };
  } catch (error: unknown) {
    const code = errorCodeOf(error);
    return { result: failureFor(init, code), code };
  }
}

/** Итог обмена для предохранителя: таймаут или нет; разомкнулся — строка в лог. */
function recordForBreaker(context: ClientContext, code: string): void {
  const { options, breaker } = context;
  if (!breaker.record(code === TIMEOUT_CODE, options.clock.now())) return;
  options.logger.warn(
    { backend: options.name, code: 'breaker_open' },
    'Приложение не отвечает: чтение приостановлено на 10 с, действия идут',
  );
}

/**
 * Один обмен с приложением. Срок (8 с у чтения, 35 с у действия) считается с постановки в очередь и покрывает
 * ожидание места, запрос и чтение тела; по сроку fetch отменяется (AbortController), тело закрывается. Чтение при
 * разомкнутом предохранителе не отправляется. Не бросает.
 */
async function exchange(
  context: ClientContext,
  path: BackendPath,
  init: ExchangeInit,
): Promise<BackendResult> {
  const url = urlOf(context.options.baseUrl, path);
  if (url === null) return UNAVAILABLE;
  const isRead = init.method === 'GET';
  if (isRead && context.breaker.isOpen(context.options.clock.now())) {
    logFailure(context, UNAVAILABLE, path, 'breaker_open');
    return UNAVAILABLE;
  }
  const controller = new AbortController();
  const { limits } = context;
  const timeoutMs = isRead ? limits.getTimeoutMs : limits.postTimeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (!(await context.semaphore.acquire(controller.signal, isRead ? 'read' : 'action'))) {
      const code = controller.signal.aborted ? 'timeout_in_queue' : 'queue_full';
      logFailure(context, UNAVAILABLE, path, code);
      return UNAVAILABLE;
    }
    try {
      const { result, code } = await sendOnce(context, url, init, controller.signal);
      recordForBreaker(context, code);
      logFailure(context, result, path, code);
      return result;
    } finally {
      context.semaphore.release();
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Тело действия больше предела приложения: не отправляется, понятный отказ 413. */
function tooLarge(maxBodyBytes: number): BackendResult {
  const kilobytes = Math.floor(maxBodyBytes / 1024);
  return {
    ok: false,
    failure: {
      kind: 'rejected',
      status: 413,
      code: 'too_large',
      message: `Слишком длинный текст: приложение принимает до ${kilobytes} КБ. Сократите его.`,
    },
  };
}

/**
 * Клиент одного приложения (почта или бот). Адрес только из шаблона consolePath и только на своём origin под
 * /internal/console; redirect: 'error' (токен не уйдёт по перенаправлению), таймаут, предел размера, X-Console-Token.
 * Ответ разбирается как JSON в пределах и копируется заново: заголовки, статус и Content-Type приложения дальше
 * не идут. Ответ не JSON (например, text/html) — «недоступно».
 */
export function createBackendClient(options: BackendClientOptions): BackendClient {
  const limits: ClientLimits = { ...DEFAULT_CLIENT_LIMITS, ...options.limits };
  const context: ClientContext = {
    options,
    limits,
    semaphore: createSemaphore(limits.maxConcurrent, limits.maxQueued, limits.reservedForActions),
    breaker: createReadBreaker(),
    logState: { outageAt: -Infinity, authAt: -Infinity },
  };
  const reads = createReadCache(options.clock, limits.cacheMs);
  return {
    name: options.name,
    get: (path) =>
      reads.load(path.full, () => exchange(context, path, { method: 'GET', user: null })),
    async post(path, body, user, maxBodyBytes = ACTION_BODY_LIMIT_BYTES) {
      const json = JSON.stringify(body);
      if (Buffer.byteLength(json, 'utf8') > maxBodyBytes) return tooLarge(maxBodyBytes);
      reads.invalidate();
      const init: ExchangeInit = { method: 'POST', body: json, user };
      const result = await exchange(context, path, init);
      reads.invalidate();
      return result;
    },
  };
}
