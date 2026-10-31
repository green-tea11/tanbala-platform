import { z } from 'zod';
import type {
  CompanyApiResult,
  CompanyBrief,
  CompanyCandidate,
  CompanyId,
  CompanyPain,
  ResearchFailReason,
  ResearchJobId,
  ResearchStart,
  ResearchStatus,
} from '../domain/company.js';
import { cleanSingleLine } from '../shared/untrusted-text.js';
import { fail, ok } from './result.js';

// Ответы API почтового проекта: схема по контракту (INTERNAL_API.md), затем очистка строк. Тексты в ответах
// недоверенные (сайты, 2ГИС, модель): каждая строка однострочная (разрывы строк и абзацев, в том числе U+2028 и U+2029,
// становятся пробелом), NFKC, без управляющих и невидимых символов, по краям обрезаны, длины из контракта.

/** До трёх кандидатов в lookup и до трёх болей в справке: больше проект B не отдаёт, лишнее отбрасывается. */
const MAX_CANDIDATES = 3;
const MAX_PAINS = 3;

/** Длины после очистки. Из контракта: name и rubric 200, segment 100, reason 600, pain 200, evidence 300. */
const LIMITS = {
  name: 200,
  rubric: 200,
  segment: 100,
  reason: 600,
  pain: 200,
  evidence: 300,
  emailSubject: 300,
  city: 100,
  emailedAt: 64,
} as const;

const FAIL_REASONS: readonly ResearchFailReason[] = [
  'not_in_2gis',
  'city_unsupported',
  'budget_exhausted',
  'error',
];

/** ID компании: положительное безопасное целое. Приведение к бренду здесь, на границе адаптера. */
const companyId = z
  .number()
  .int()
  .positive()
  .transform((value) => value as CompanyId);

/** ID задачи: буквы, цифры и дефис, от 1 до 100 знаков (UUID). */
const researchJobId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9-]+$/)
  .transform((value) => value as ResearchJobId);

/** match_score по контракту 0..1: за границами ответ не по схеме. */
const matchScore = z.number().min(0).max(1);

const nullableText = z.string().nullable();

const candidateSchema = z.object({
  id: companyId,
  name: z.string(),
  city: nullableText,
  rubric: nullableText,
  match_by: z.enum(['domain', 'phone', 'name']),
  match_score: matchScore,
  emailed: z.boolean(),
});

const lookupSchema = z.object({ candidates: z.array(candidateSchema) });

const painSchema = z.object({
  pain: z.string(),
  evidence: nullableText,
  source: z.enum(['2gis', 'site']).nullable(),
});

const briefSchema = z.object({
  id: companyId,
  name: z.string(),
  city: nullableText,
  rubric: nullableText,
  segment: nullableText,
  fit: z.enum(['yes', 'maybe', 'no']).nullable(),
  fit_score: z.number().int().min(0).max(100).nullable(),
  reason: nullableText,
  pains: z.array(painSchema),
  emailed: z.boolean(),
  emailed_at: nullableText,
  email_subject: nullableText,
});

const researchDoneSchema = z.object({ status: z.literal('done'), company_id: companyId });
const researchQueuedSchema = z.object({ job_id: researchJobId });

/**
 * Поле reason статуса необязательное (добавлено позже по решению владельца): его может не быть, а неожиданное
 * значение не делает ответ негодным, потому что клиент работает и без него (failReasonOf).
 */
const researchStatusSchema = z.object({
  status: z.enum(['queued', 'running', 'done', 'failed', 'not_found']),
  brief: briefSchema.nullable().optional(),
  reason: z.unknown().optional(),
});

type RawCandidate = z.output<typeof candidateSchema>;
type RawPain = z.output<typeof painSchema>;
type RawBrief = z.output<typeof briefSchema>;
type RawResearchStatus = z.output<typeof researchStatusSchema>;

function clean(raw: string | null, maxChars: number): string | null {
  return cleanSingleLine(raw, maxChars);
}

/** Кандидат без названия после очистки не нужен: null. */
function toCandidate(raw: RawCandidate): CompanyCandidate | null {
  const name = clean(raw.name, LIMITS.name);
  if (name === null) return null;
  return {
    id: raw.id,
    name,
    city: clean(raw.city, LIMITS.city),
    rubric: clean(raw.rubric, LIMITS.rubric),
    matchBy: raw.match_by,
    matchScore: raw.match_score,
    emailed: raw.emailed,
  };
}

/** Боль без текста после очистки отбрасывается. */
function toPains(raw: RawPain): readonly CompanyPain[] {
  const pain = clean(raw.pain, LIMITS.pain);
  if (pain === null) return [];
  return [{ pain, evidence: clean(raw.evidence, LIMITS.evidence), source: raw.source }];
}

/** Справка без названия после очистки не годится: null. */
function toBrief(raw: RawBrief): CompanyBrief | null {
  const name = clean(raw.name, LIMITS.name);
  if (name === null) return null;
  return {
    id: raw.id,
    name,
    city: clean(raw.city, LIMITS.city),
    rubric: clean(raw.rubric, LIMITS.rubric),
    segment: clean(raw.segment, LIMITS.segment),
    fit: raw.fit,
    fitScore: raw.fit_score,
    reason: clean(raw.reason, LIMITS.reason),
    pains: raw.pains.flatMap(toPains).slice(0, MAX_PAINS),
    emailed: raw.emailed,
    emailedAt: clean(raw.emailed_at, LIMITS.emailedAt),
    emailSubject: clean(raw.email_subject, LIMITS.emailSubject),
  };
}

function failReasonOf(raw: unknown): ResearchFailReason | null {
  return FAIL_REASONS.find((reason) => reason === raw) ?? null;
}

function toResearchStatus(raw: RawResearchStatus): CompanyApiResult<ResearchStatus> {
  switch (raw.status) {
    case 'queued':
    case 'running':
      return ok<ResearchStatus>({ status: raw.status });
    case 'not_found':
      return ok<ResearchStatus>({ status: 'not_found' });
    case 'failed':
      return ok<ResearchStatus>({ status: 'failed', reason: failReasonOf(raw.reason) });
    case 'done': {
      const brief = raw.brief === undefined || raw.brief === null ? null : toBrief(raw.brief);
      return brief === null
        ? fail('invalid_response')
        : ok<ResearchStatus>({ status: 'done', brief });
    }
  }
}

/** Ответ GET /internal/lookup: до трёх кандидатов, ответ не по схеме: invalid_response. */
export function parseCandidates(json: unknown): CompanyApiResult<readonly CompanyCandidate[]> {
  const parsed = lookupSchema.safeParse(json);
  if (!parsed.success) return fail('invalid_response');
  const candidates = parsed.data.candidates.flatMap((raw) => toCandidate(raw) ?? []);
  return ok(candidates.slice(0, MAX_CANDIDATES));
}

/** Ответ GET /internal/companies/{id}/brief: справка о другой компании (id не тот, что запрошен) => invalid_response. */
export function parseBrief(json: unknown, requestedId: CompanyId): CompanyApiResult<CompanyBrief> {
  const parsed = briefSchema.safeParse(json);
  const brief = parsed.success ? toBrief(parsed.data) : null;
  return brief === null || brief.id !== requestedId ? fail('invalid_response') : ok(brief);
}

/** Ответ POST /internal/research: 202 с job_id (задача в очереди) или 200 done с company_id. */
export function parseResearchStart(status: number, json: unknown): CompanyApiResult<ResearchStart> {
  if (status === 202) {
    const queued = researchQueuedSchema.safeParse(json);
    return queued.success
      ? ok<ResearchStart>({ kind: 'queued', jobId: queued.data.job_id })
      : fail('invalid_response');
  }
  const done = researchDoneSchema.safeParse(json);
  return done.success
    ? ok<ResearchStart>({ kind: 'done', companyId: done.data.company_id })
    : fail('invalid_response');
}

/** Ответ GET /internal/research/{job_id}. */
export function parseResearchStatus(json: unknown): CompanyApiResult<ResearchStatus> {
  const parsed = researchStatusSchema.safeParse(json);
  return parsed.success ? toResearchStatus(parsed.data) : fail('invalid_response');
}
