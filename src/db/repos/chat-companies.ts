import type Database from 'better-sqlite3';
import { z } from 'zod';
import type {
  CandidateSource,
  ChatCandidate,
  ChatCompaniesRepo,
  ChatCompanyState,
  CompanyBrief,
  CompanyId,
  CompanyPain,
  ConfirmedCompany,
  ResearchJobId,
  ResearchState,
} from '../../domain/company.js';
import type { Logger } from '../../domain/ports.js';
import type { ChatId } from '../../domain/types.js';
import { assertTimeMs } from '../time.js';

/** То, что лежит в колонке state: состояние без ID чата (его хранит chat_id). */
type StoredState = Omit<ChatCompanyState, 'chatId'>;

const CANDIDATE_SOURCES = [
  'profile_domain',
  'phone',
  'profile_name',
  'message',
  'logo',
  'research',
] as const satisfies readonly CandidateSource[];

const FAIL_REASONS = [
  'not_in_2gis',
  'city_unsupported',
  'budget_exhausted',
  'error',
  'rate_limited',
  'timeout',
  'not_found',
] as const;

/** Время в мс UTC: целое не меньше нуля. */
const timeMs = z.int().nonnegative();

/** ID компании приводится к бренду здесь, на границе базы: положительное целое. */
const companyId = z
  .int()
  .positive()
  .transform((value) => value as CompanyId);

const jobId = z.string().transform((value) => value as ResearchJobId);

const nullableText = z.string().nullable();

const painSchema: z.ZodType<CompanyPain> = z.object({
  pain: z.string(),
  evidence: nullableText,
  source: z.enum(['site', '2gis']).nullable(),
});

/** Поля справки, которые в базе хранятся: их читают промпт (рубрика, боли, «писали ли»), сводка и панель. */
type StoredBrief = Pick<CompanyBrief, 'id' | 'name' | 'city' | 'rubric' | 'pains' | 'emailed'>;

/**
 * Поля справки, которые ничему в боте не нужны (сегмент, оценка, обоснование, дата и тема письма): в базу они не
 * пишутся, при чтении null. В старых записях они ещё есть: такие поля пропускаются без проверки.
 */
const UNUSED_BRIEF_FIELDS = {
  segment: null,
  fit: null,
  fitScore: null,
  reason: null,
  emailedAt: null,
  emailSubject: null,
} as const satisfies Partial<CompanyBrief>;

/** Счётчик попыток: целое не меньше нуля; в старых записях его нет, тогда 0. */
const counter = z.int().nonnegative().default(0);

const briefSchema: z.ZodType<CompanyBrief> = z
  .object({
    id: companyId,
    name: z.string(),
    city: nullableText,
    rubric: nullableText,
    pains: z.array(painSchema),
    emailed: z.boolean(),
  })
  .transform((brief): CompanyBrief => ({ ...brief, ...UNUSED_BRIEF_FIELDS }));

const candidateSchema: z.ZodType<ChatCandidate> = z.object({
  id: companyId,
  name: z.string(),
  city: nullableText,
  source: z.enum(CANDIDATE_SOURCES),
  askedAtMs: timeMs.nullable(),
  awaitingAnswer: z.boolean(),
});

const confirmedSchema: z.ZodType<ConfirmedCompany> = z.object({
  id: companyId,
  name: z.string(),
  city: nullableText,
  confirmedAtMs: timeMs,
  brief: briefSchema.nullable(),
  briefAtMs: timeMs.nullable(),
});

const researchSchema: z.ZodType<ResearchState> = z.discriminatedUnion('status', [
  z.object({
    status: z.enum(['queued', 'running']),
    jobId,
    startedAtMs: timeMs,
    checkedAtMs: timeMs,
  }),
  z.object({ status: z.literal('done'), companyId, finishedAtMs: timeMs }),
  z.object({
    status: z.literal('failed'),
    reason: z.enum(FAIL_REASONS).nullable(),
    finishedAtMs: timeMs,
  }),
]);

const storedSchema: z.ZodType<StoredState> = z.object({
  profileKind: z.enum(['business', 'personal', 'unknown']).nullable(),
  profileRequests: counter,
  profileDomain: nullableText,
  freeStepsAtMs: timeMs.nullable(),
  logoCheckedAtMs: timeMs.nullable(),
  statedName: nullableText,
  statedCity: nullableText,
  lookedUpName: nullableText,
  candidate: candidateSchema.nullable(),
  rejectedIds: z.array(companyId),
  confirmed: confirmedSchema.nullable(),
  briefFailures: counter,
  nameAskedAtMs: timeMs.nullable(),
  research: researchSchema.nullable(),
  researchStartedAtMs: timeMs.nullable().default(null),
  adoptFailures: counter,
  confirmedPains: z.array(z.string()),
});

/** Пустое состояние чата: ничего не известно, списки пусты. Его отдаёт get, пока записи нет или она испорчена. */
export function emptyCompanyState(chatId: ChatId): ChatCompanyState {
  return {
    chatId,
    profileKind: null,
    profileRequests: 0,
    profileDomain: null,
    freeStepsAtMs: null,
    logoCheckedAtMs: null,
    statedName: null,
    statedCity: null,
    lookedUpName: null,
    candidate: null,
    rejectedIds: [],
    confirmed: null,
    briefFailures: 0,
    nameAskedAtMs: null,
    research: null,
    researchStartedAtMs: null,
    adoptFailures: 0,
    confirmedPains: [],
  };
}

/**
 * Состояние определения компании в SQLite (таблица chat_companies): одна строка на чат, state это JSON без ID чата.
 * Здесь же числа из JSON приводятся к брендам (CompanyId, ResearchJobId), а форма проверяется zod.
 * get: записи нет => пустое состояние; запись испорчена (не JSON или не по схеме) => тоже пустое состояние и
 * предупреждение в лог (только ID чата, без содержимого записи), исключения нет: бот работает без данных о
 * компании, а следующая запись исправит строку. Неизвестные поля в JSON отбрасываются; счётчиков и отметки запуска
 * проверки в старых записях нет: 0 и null.
 * save: записывает состояние целиком (по state.chatId), справку без неиспользуемых полей; чата нет => ошибка
 * внешнего ключа, как у остальных репозиториев.
 * countResearchStarts: отметки researchStartedAtMs всех чатов позже границы; испорченная запись не считается.
 * Только подготовленные запросы.
 */
export function createChatCompaniesRepo(db: Database.Database, logger: Logger): ChatCompaniesRepo {
  const selectState = db
    .prepare<[ChatId], string>('SELECT state FROM chat_companies WHERE chat_id = ?')
    .pluck();
  const upsertState = db.prepare<{ chatId: ChatId; state: string; nowMs: number }>(
    `INSERT INTO chat_companies (chat_id, state, updated_at) VALUES (@chatId, @state, @nowMs)
     ON CONFLICT (chat_id) DO UPDATE SET
       state = excluded.state,
       updated_at = excluded.updated_at`,
  );
  // CASE, а не AND: json_extract на тексте не JSON бросает ошибку, а порядок условий в AND SQLite не обещает.
  const countStarts = db
    .prepare<[number], number>(
      `SELECT count(*) FROM chat_companies
       WHERE CASE WHEN json_valid(state)
         THEN json_type(state, '$.researchStartedAtMs') = 'integer'
           AND json_extract(state, '$.researchStartedAtMs') > ?
         ELSE 0 END`,
    )
    .pluck();
  return {
    get(chatId: ChatId): ChatCompanyState {
      const text = selectState.get(chatId);
      if (text === undefined) return emptyCompanyState(chatId);
      const stored = parseStored(text);
      if (stored === null) {
        logger.warn({ chatId }, 'Состояние компании чата в базе испорчено: взято пустое');
        return emptyCompanyState(chatId);
      }
      return { chatId, ...stored };
    },
    save(state: ChatCompanyState, nowMs: number): void {
      assertTimeMs(nowMs, 'nowMs');
      const { chatId, ...stored } = state;
      upsertState.run({ chatId, state: JSON.stringify(compactOf(stored)), nowMs });
    },
    countResearchStarts(sinceMs: number): number {
      assertTimeMs(sinceMs, 'sinceMs');
      return countStarts.get(sinceMs) ?? 0;
    },
  };
}

/** Справка для записи: только поля, которые читают промпт, сводка и панель. */
function storedBriefOf(brief: CompanyBrief): StoredBrief {
  const { id, name, city, rubric, pains, emailed } = brief;
  return { id, name, city, rubric, pains, emailed };
}

/** Состояние для записи в колонку: справка подтверждённой компании без неиспользуемых полей. */
function compactOf(stored: StoredState): unknown {
  const { confirmed } = stored;
  if (confirmed === null || confirmed.brief === null) return stored;
  return { ...stored, confirmed: { ...confirmed, brief: storedBriefOf(confirmed.brief) } };
}

/** Состояние из текста колонки; null, если текст не JSON или не подходит под схему. */
function parseStored(text: string): StoredState | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = storedSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
