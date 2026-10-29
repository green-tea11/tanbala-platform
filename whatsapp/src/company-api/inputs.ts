import type {
  CompanyId,
  CompanyLookupQuery,
  ResearchJobId,
  ResearchRequest,
} from '../domain/company.js';
import { limitChars } from '../shared/untrusted-text.js';

// Значения, которые уходят в API почтового проекта: проверка и обрезка до сети. Нормализует их и ищет по ним сам
// проект B; здесь только то, что он отверг бы кодом 400, и пределы длины из контракта (INTERNAL_API.md).

/** Пределы длины по контракту: name 200, domain 253, city 100 (phone ровно 11 цифр). */
export const MAX_NAME_CHARS = 200;
export const MAX_DOMAIN_CHARS = 253;
export const MAX_CITY_CHARS = 100;

/** Телефон для API: 11 цифр с 7 в начале, так проект B хранит номера компаний. */
const PHONE = /^7\d{10}$/;

/** ID задачи проверки: UUID, то есть буквы, цифры и дефис, не длиннее 100. */
const JOB_ID = /^[A-Za-z0-9-]{1,100}$/;

/** Тело POST /internal/research: до 4 КБ даже в худшем случае (все знаки экранируются, 553 знака по 6 байт). */
export interface ResearchBody {
  readonly name: string;
  readonly city: string | null;
  readonly phone: string | null;
  readonly domain: string | null;
}

/** Строка без пробелов по краям и не длиннее maxChars знаков; пустая: null. */
function trimmedOrNull(raw: string, maxChars: number): string | null {
  const text = raw.trim();
  return text === '' ? null : limitChars(text, maxChars);
}

function optionalText(raw: string | null, maxChars: number): string | null {
  return raw === null ? null : trimmedOrNull(raw, maxChars);
}

function lookupParam(query: CompanyLookupQuery): { key: string; value: string } | null {
  switch (query.by) {
    case 'domain': {
      const domain = trimmedOrNull(query.domain, MAX_DOMAIN_CHARS);
      return domain === null ? null : { key: 'domain', value: domain };
    }
    case 'phone':
      return PHONE.test(query.phone) ? { key: 'phone', value: query.phone } : null;
    case 'name': {
      const name = trimmedOrNull(query.name, MAX_NAME_CHARS);
      return name === null ? null : { key: 'name', value: name };
    }
  }
}

/** Путь GET /internal/lookup с ровно одним параметром; null: значение пустое или телефон не 7XXXXXXXXXX (bad_request). */
export function lookupPath(query: CompanyLookupQuery): string | null {
  const param = lookupParam(query);
  return param === null ? null : `/internal/lookup?${param.key}=${encodeURIComponent(param.value)}`;
}

/** Путь GET /internal/companies/{id}/brief; null: id не положительное целое. */
export function briefPath(id: CompanyId): string | null {
  return Number.isSafeInteger(id) && id > 0
    ? `/internal/companies/${encodeURIComponent(String(id))}/brief`
    : null;
}

/** Путь GET /internal/research/{job_id}; null: ID не из букв, цифр и дефиса или длиннее 100. */
export function statusPath(jobId: ResearchJobId): string | null {
  return JOB_ID.test(jobId) ? `/internal/research/${encodeURIComponent(jobId)}` : null;
}

/**
 * Тело POST /internal/research: name обрезается по краям и до 200, пустые city и domain становятся null, city до 100,
 * domain до 253. null: названия нет или телефон не 7XXXXXXXXXX (bad_request без запроса).
 */
export function researchBody(request: ResearchRequest): ResearchBody | null {
  const name = trimmedOrNull(request.name, MAX_NAME_CHARS);
  if (name === null || (request.phone !== null && !PHONE.test(request.phone))) return null;
  return {
    name,
    city: optionalText(request.city, MAX_CITY_CHARS),
    phone: request.phone,
    domain: optionalText(request.domain, MAX_DOMAIN_CHARS),
  };
}
