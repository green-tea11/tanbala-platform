import type { CompanyApiFailure } from '../domain/company.js';
import type { Clock, Logger } from '../domain/ports.js';
import { readLimitedBytes } from '../shared/read-limited.js';

// Транспорт внутреннего API почтового проекта: один HTTP-обмен с таймаутом и пределом тела, перевод статусов
// в CompanyApiFailure, пауза после недоступности и записи в лог. Содержимое запросов и ответов в лог не пишется.

/** fetch так, как его вызывает клиент: адрес строкой и настройки. В тестах подменяется. */
export type CompanyFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Какой вызов API: попадает в лог вместо адреса, в котором были бы домен, телефон и название. */
export type Endpoint = 'lookup' | 'brief' | 'research' | 'research_status';

/** Запрос к API: путь уже закодирован, тело POST уже JSON-строка. */
export interface ApiRequest {
  readonly endpoint: Endpoint;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: string;
  /** Статусы, чьё тело разбирается по контракту: 200 и 202. */
  readonly accept: readonly number[];
}

/** Итог обмена: тело успешного ответа как JSON (форму проверяет responses.ts) или причина сбоя. */
export type ApiReply =
  | { readonly ok: true; readonly status: number; readonly json: unknown }
  | { readonly ok: false; readonly failure: CompanyApiFailure };

export interface Transport {
  /** Не бросает: любой сбой приходит значением. */
  send(request: ApiRequest): Promise<ApiReply>;
}

export interface TransportDeps {
  /** Схема, хост и порт без хвостового «/» (parseEmailApiUrl). */
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs: number;
  readonly cooldownMs: number;
  readonly fetch: CompanyFetch;
  readonly clock: Pick<Clock, 'now'>;
  readonly logger: Logger;
}

/** Предел тела ответа: больше 256 КБ читать не нужно, ответы API на порядок меньше. */
const MAX_BODY_BYTES = 256 * 1024;

/** Ошибку 401 (токен не принят) в лог не чаще раза в 10 минут: она повторится на каждом вызове. */
const UNAUTHORIZED_LOG_INTERVAL_MS = 10 * 60_000;

const TIMED_OUT = Symbol('timed-out');

/** Код сетевой ошибки, который можно показать в логе: ECONNREFUSED, UND_ERR_SOCKET и подобные. */
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Обмен дошёл до ответа (text: тело, null: его не читали или оно больше предела) либо оборвался. */
type Attempt =
  | { readonly kind: 'answered'; readonly status: number; readonly text: string | null }
  | { readonly kind: 'unreachable'; readonly code: string };

/** Что записать в лог в начале паузы: статус ответа или код сбоя. */
type Outage = { readonly status: number } | { readonly code: string };

/** Разбор обмена: ответ вызывающему и побочные действия (пауза, запись об отказе токена). */
interface Verdict {
  readonly reply: ApiReply;
  readonly outage?: Outage;
  readonly unauthorized?: boolean;
}

/** Состояние транспорта: меняется только здесь, наружу не отдаётся. */
interface TransportState {
  /** До этого момента (мс по часам deps) вызовы возвращают unavailable без сети. */
  cooldownUntilMs: number;
  /** Когда последний раз писали об отказе токена; null: ещё не писали. */
  unauthorizedLoggedAtMs: number | null;
}

function failed(failure: CompanyApiFailure): ApiReply {
  return { ok: false, failure };
}

/**
 * Транспорт одного клиента. Порядок вызова: пауза после недоступности (сети нет), обмен с таймаутом timeoutMs на всё
 * (запрос и чтение тела), разбор статуса. Недоступность (сеть, таймаут, 5xx) включает паузу cooldownMs для всех вызовов
 * и одно предупреждение в лог на паузу (endpoint и status или code). Отказ токена (401) пишется в лог не чаще раза в
 * 10 минут. Ничего другого не логируется: в запросах и ответах домены, телефоны, названия компаний и токен.
 * Редиректы не выполняются: токен не должен уйти на другой адрес.
 */
export function createTransport(deps: TransportDeps): Transport {
  const state: TransportState = { cooldownUntilMs: 0, unauthorizedLoggedAtMs: null };
  return {
    async send(request: ApiRequest): Promise<ApiReply> {
      if (deps.clock.now() < state.cooldownUntilMs) return failed('unavailable');
      const verdict = classify(await attemptOnce(deps, request), request.accept);
      if (verdict.outage !== undefined) startPause(deps, state, request.endpoint, verdict.outage);
      if (verdict.unauthorized === true) logUnauthorized(deps, state, request.endpoint);
      return verdict.reply;
    },
  };
}

// Обмен: запрос, таймаут, чтение тела с пределом.

/** Работа за timeoutMs: по сроку сигнал отмены уходит в fetch, а результатом становится TIMED_OUT. */
async function withDeadline<T>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T | typeof TIMED_OUT> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      resolve(TIMED_OUT);
      controller.abort();
    }, timeoutMs);
  });
  const running = work(controller.signal);
  // Сбой после срока уже никому не нужен: он не должен стать необработанным отказом.
  running.catch(() => undefined);
  try {
    return await Promise.race([running, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function attemptOnce(deps: TransportDeps, request: ApiRequest): Promise<Attempt> {
  const outcome = await withDeadline(deps.timeoutMs, (signal) => exchange(deps, request, signal));
  return outcome === TIMED_OUT ? { kind: 'unreachable', code: 'timeout' } : outcome;
}

function requestInit(deps: TransportDeps, request: ApiRequest, signal: AbortSignal): RequestInit {
  const headers: Record<string, string> = {
    'X-Internal-Token': deps.token,
    Accept: 'application/json',
  };
  if (request.body === undefined) {
    return { method: request.method, headers, redirect: 'manual', signal };
  }
  return {
    method: request.method,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: request.body,
    redirect: 'manual',
    signal,
  };
}

/** Один обмен без исключений: сеть и обрыв потока становятся unreachable. */
async function exchange(
  deps: TransportDeps,
  request: ApiRequest,
  signal: AbortSignal,
): Promise<Attempt> {
  try {
    const url = `${deps.baseUrl}${request.path}`;
    const response = await deps.fetch(url, requestInit(deps, request, signal));
    const { status } = response;
    // Тело нужно только по контракту (200, 202) и у 429 (код отказа); у остальных статусов оно не читается.
    if (request.accept.includes(status) || status === 429) {
      return { kind: 'answered', status, text: await readLimited(response, signal) };
    }
    response.body?.cancel().catch(() => undefined);
    return { kind: 'answered', status, text: null };
  } catch (error: unknown) {
    return { kind: 'unreachable', code: errorCode(error) };
  }
}

/**
 * Тело ответа текстом UTF-8: не больше MAX_BODY_BYTES (больше: null, поток закрыт). Срок вышел: чтение останавливается
 * отменой потока и завершается ошибкой. Пустое тело: пустая строка.
 */
async function readLimited(response: Response, signal: AbortSignal): Promise<string | null> {
  const bytes = await readLimitedBytes(response, MAX_BODY_BYTES, signal);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

function codeOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const { code } = value as { readonly code?: unknown };
  return typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : null;
}

/** Код сбоя для лога: код ошибки или её причины (так undici отдаёт ECONNREFUSED), иначе общий network_error. */
function errorCode(error: unknown): string {
  const cause =
    typeof error === 'object' && error !== null ? (error as { cause?: unknown }).cause : null;
  return codeOf(error) ?? codeOf(cause) ?? 'network_error';
}

// Разбор статуса.

function parseJson(
  text: string | null,
): { readonly ok: true; readonly json: unknown } | { readonly ok: false } {
  if (text === null) return { ok: false };
  try {
    return { ok: true, json: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Причина отказа 429 по коду в теле: budget_exhausted, всё остальное (в том числе не JSON) rate_limited. */
function limitFailure(text: string | null): CompanyApiFailure {
  const body = parseJson(text);
  if (!body.ok || typeof body.json !== 'object' || body.json === null) return 'rate_limited';
  return (body.json as { readonly error?: unknown }).error === 'budget_exhausted'
    ? 'budget_exhausted'
    : 'rate_limited';
}

function classify(attempt: Attempt, accept: readonly number[]): Verdict {
  if (attempt.kind === 'unreachable') {
    return { reply: failed('unavailable'), outage: { code: attempt.code } };
  }
  const { status, text } = attempt;
  if (accept.includes(status)) {
    const body = parseJson(text);
    return {
      reply: body.ok ? { ok: true, status, json: body.json } : failed('invalid_response'),
    };
  }
  if (status === 429) return { reply: failed(limitFailure(text)) };
  if (status === 400) return { reply: failed('bad_request') };
  if (status === 401) return { reply: failed('unauthorized'), unauthorized: true };
  if (status === 404) return { reply: failed('not_found') };
  if (status >= 500 && status <= 599) return { reply: failed('unavailable'), outage: { status } };
  return { reply: failed('invalid_response') };
}

// Пауза и записи в лог.

/** Начало паузы: одно предупреждение на паузу. Сбой, пришедший во время уже идущей паузы, её не продлевает. */
function startPause(
  deps: TransportDeps,
  state: TransportState,
  endpoint: Endpoint,
  outage: Outage,
): void {
  const nowMs = deps.clock.now();
  if (nowMs < state.cooldownUntilMs) return;
  state.cooldownUntilMs = nowMs + deps.cooldownMs;
  deps.logger.warn(
    { endpoint, ...outage, pauseMs: deps.cooldownMs },
    'API почтового проекта недоступно, запросы к нему приостановлены',
  );
}

function logUnauthorized(deps: TransportDeps, state: TransportState, endpoint: Endpoint): void {
  const nowMs = deps.clock.now();
  const loggedAtMs = state.unauthorizedLoggedAtMs;
  if (loggedAtMs !== null && nowMs - loggedAtMs < UNAUTHORIZED_LOG_INTERVAL_MS) return;
  state.unauthorizedLoggedAtMs = nowMs;
  deps.logger.error(
    { endpoint, status: 401 },
    'API почтового проекта не принял токен: проверьте INTERNAL_API_TOKEN',
  );
}
