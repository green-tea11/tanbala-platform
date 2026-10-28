import type {
  CompanyApiResult,
  CompanyBrief,
  CompanyCandidate,
  CompanyDirectory,
  CompanyId,
  CompanyLookupQuery,
  ResearchJobId,
  ResearchRequest,
  ResearchStart,
  ResearchStatus,
} from '../domain/company.js';
import { parseEmailApiUrl } from '../config/company-settings.js';
import type { Clock, Logger } from '../domain/ports.js';
import { SafeError } from '../shared/safe-error.js';
import { briefPath, lookupPath, researchBody, statusPath } from './inputs.js';
import { fail } from './result.js';
import {
  parseBrief,
  parseCandidates,
  parseResearchStart,
  parseResearchStatus,
} from './responses.js';
import {
  createTransport,
  type ApiReply,
  type ApiRequest,
  type CompanyFetch,
  type Endpoint,
  type Transport,
} from './transport.js';

export type { CompanyFetch } from './transport.js';

/** Таймаут запроса по требованию владельца: бот не ждёт почтовый проект дольше 3 секунд. */
export const COMPANY_API_TIMEOUT_MS = 3000;

/** Пауза после недоступности API: минуту вызовы возвращают unavailable без сети. */
export const COMPANY_API_COOLDOWN_MS = 60_000;

/** Зависимости клиента внутреннего API. */
export interface CompanyApiDeps {
  /** EMAIL_API_URL: только эта машина (config/env.ts); клиент проверяет адрес ещё раз. */
  readonly baseUrl: string;
  /** INTERNAL_API_TOKEN: уходит только в заголовок X-Internal-Token, в логи и ошибки не попадает. */
  readonly token: string;
  /** По умолчанию COMPANY_API_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /** По умолчанию COMPANY_API_COOLDOWN_MS. */
  readonly cooldownMs?: number;
  /** Для тестов: подмена fetch. По умолчанию глобальный fetch на момент вызова. */
  readonly fetch?: CompanyFetch;
  readonly clock: Pick<Clock, 'now'>;
  readonly logger: Logger;
}

/** Включённый вариант порта CompanyDirectory: выключенный `{ enabled: false }` собирает main по конфигу. */
export type EnabledCompanyDirectory = Extract<CompanyDirectory, { readonly enabled: true }>;

type SuccessfulReply = Extract<ApiReply, { readonly ok: true }>;

function get(endpoint: Endpoint, path: string | null): ApiRequest | null {
  return path === null ? null : { endpoint, method: 'GET', path, accept: [200] };
}

/** Запрос до сети: null значит «неверные значения», вызов сразу возвращает bad_request. */
async function call<T>(
  transport: Transport,
  request: ApiRequest | null,
  parse: (reply: SuccessfulReply) => CompanyApiResult<T>,
): Promise<CompanyApiResult<T>> {
  if (request === null) return fail('bad_request');
  const reply = await transport.send(request);
  return reply.ok ? parse(reply) : fail(reply.failure);
}

function researchRequest(request: ResearchRequest): ApiRequest | null {
  const body = researchBody(request);
  if (body === null) return null;
  return {
    endpoint: 'research',
    method: 'POST',
    path: '/internal/research',
    body: JSON.stringify(body),
    accept: [200, 202],
  };
}

/**
 * Клиент внутреннего API почтового проекта (вариант enabled: true порта CompanyDirectory). Запросы строго по контракту
 * INTERNAL_API.md: GET /internal/lookup (один признак), GET /internal/companies/{id}/brief, POST /internal/research,
 * GET /internal/research/{job_id}; заголовки X-Internal-Token и Accept, у POST ещё Content-Type: application/json.
 * До сети: значения обрезаются по краям и до пределов контракта, пустое название и неверный телефон дают bad_request
 * без запроса. Ответы 200 и 202 разбираются схемой zod, строки очищаются как недоверенные. Сбои приходят значением:
 * 400 bad_request, 401 unauthorized, 404 not_found, 429 rate_limited или budget_exhausted по коду в теле, сеть,
 * таймаут (по умолчанию 3 с) и 5xx unavailable, остальное и ответ не по схеме invalid_response. После unavailable
 * пауза (по умолчанию минута): вызовы сразу возвращают unavailable без сети. Пустой токен или адрес не на этой машине
 * (те же правила, что у EMAIL_API_URL): SafeError без значений, клиент не создан и токен никуда не уходит.
 */
export function createCompanyDirectory(deps: CompanyApiDeps): EnabledCompanyDirectory {
  if (deps.token.trim() === '') {
    throw new SafeError('Токен внутреннего API пуст: клиент почтового проекта не создан');
  }
  const baseUrl = parseEmailApiUrl(deps.baseUrl);
  if (baseUrl === null) {
    throw new SafeError(
      'Адрес внутреннего API не на этой машине или неверен: клиент почтового проекта не создан',
    );
  }
  const transport = createTransport({
    baseUrl,
    token: deps.token,
    timeoutMs: deps.timeoutMs ?? COMPANY_API_TIMEOUT_MS,
    cooldownMs: deps.cooldownMs ?? COMPANY_API_COOLDOWN_MS,
    // Глобальный fetch берётся при вызове, а не при создании: так его видно и подмене в тестах.
    fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
    clock: deps.clock,
    logger: deps.logger,
  });
  return {
    enabled: true,
    lookup: (query: CompanyLookupQuery): Promise<CompanyApiResult<readonly CompanyCandidate[]>> =>
      call(transport, get('lookup', lookupPath(query)), (reply) => parseCandidates(reply.json)),
    brief: (id: CompanyId): Promise<CompanyApiResult<CompanyBrief>> =>
      call(transport, get('brief', briefPath(id)), (reply) => parseBrief(reply.json)),
    startResearch: (request: ResearchRequest): Promise<CompanyApiResult<ResearchStart>> =>
      call(transport, researchRequest(request), (reply) =>
        parseResearchStart(reply.status, reply.json),
      ),
    researchStatus: (jobId: ResearchJobId): Promise<CompanyApiResult<ResearchStatus>> =>
      call(transport, get('research_status', statusPath(jobId)), (reply) =>
        parseResearchStatus(reply.json),
      ),
  };
}
