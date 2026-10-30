import type { z } from 'zod';
import type { Logger } from '../shared/logger.js';
import { ACTION_BODY_LIMIT_BYTES, IMPORT_BODY_LIMIT_BYTES, type BackendClient } from './client.js';
import { parsed } from './parsed.js';
import { consolePath, type BackendPath, type QueryValue } from './paths.js';
import type { BackendResult } from './result.js';
import {
  activeRunSchema,
  anyObjectSchema,
  approvedSchema,
  blockedSchema,
  clearedSchema,
  digestSchema,
  importedSchema,
  leadsSpendSchema,
  leadsSummarySchema,
  listSchema,
  rejectedSchema,
  runStartedSchema,
  savedSchema,
  testSentSchema,
} from './schemas.js';

/** Предел id в одном запросе digest (контракт: не больше 100). */
export const DIGEST_MAX_IDS = 100;

export interface CompaniesQuery {
  readonly status?: string;
  readonly query?: string;
  readonly run?: number;
  readonly q?: string;
  readonly via?: 'whatsapp' | 'regular';
  readonly wa?: 1;
  readonly blocked?: 1;
  readonly letter?: 1;
  readonly sort?: 'new' | 'score' | 'letter';
  readonly page?: number;
}

export interface LettersQuery {
  readonly status?: 'pending' | 'approved' | 'rejected' | 'all';
  readonly run?: number;
  readonly page?: number;
}

export interface ResearchQuery {
  readonly status?: string;
  readonly page?: number;
}

export interface RunStart {
  readonly query: string;
  readonly city: string;
  readonly count: number;
}

export interface LetterEdit {
  readonly subject: string;
  readonly body: string;
}

export interface HistoryImport {
  readonly kind: 'written' | 'refused';
  readonly text?: string;
  readonly fileBase64?: string;
}

type Result<S extends z.ZodType> = Promise<BackendResult<z.output<S>>>;

/** Почта (leads): эндпоинты /internal/console/* по контракту CONSOLE_API, раздел 2. */
export function createLeadsApi(client: BackendClient, logger: Logger) {
  const get = <S extends z.ZodType>(path: BackendPath, schema: S): Result<S> =>
    parsed(client.get(path), schema, { backend: 'leads', path, logger });
  const post = <S extends z.ZodType>(
    path: BackendPath,
    body: Readonly<Record<string, unknown>>,
    user: string,
    schema: S,
    maxBodyBytes = ACTION_BODY_LIMIT_BYTES,
  ): Result<S> =>
    parsed(client.post(path, body, user, maxBodyBytes), schema, {
      backend: 'leads',
      path,
      logger,
      action: true,
    });
  const page = (page: number | undefined): Record<string, QueryValue> => ({ page });

  return {
    summary: () => get(consolePath(['summary']), leadsSummarySchema),
    spend: (from: string, to: string) =>
      get(consolePath(['spend'], { from, to }), leadsSpendSchema),
    companies: (query: CompaniesQuery) => get(consolePath(['companies'], { ...query }), listSchema),
    company: (id: number) => get(consolePath(['companies', id]), anyObjectSchema),
    digest: (ids: readonly number[]) =>
      get(
        consolePath(['companies', 'digest'], { ids: ids.slice(0, DIGEST_MAX_IDS).join(',') }),
        digestSchema,
      ),
    letters: (query: LettersQuery) => get(consolePath(['letters'], { ...query }), listSchema),
    letter: (id: number) => get(consolePath(['letters', id]), anyObjectSchema),
    runs: (pageNo?: number) => get(consolePath(['runs'], page(pageNo)), listSchema),
    activeRun: () => get(consolePath(['runs', 'active']), activeRunSchema),
    run: (id: number) => get(consolePath(['runs', id]), anyObjectSchema),
    searchOptions: () => get(consolePath(['search', 'options']), anyObjectSchema),
    history: (pageNo?: number) => get(consolePath(['history'], page(pageNo)), listSchema),
    blocked: (pageNo?: number) => get(consolePath(['blocked'], page(pageNo)), listSchema),
    researchJobs: (query: ResearchQuery) =>
      get(consolePath(['research-jobs'], { ...query }), listSchema),
    startRun: (body: RunStart, user: string) =>
      post(consolePath(['runs']), { ...body }, user, runStartedSchema),
    approve: (id: number, user: string) =>
      post(consolePath(['drafts', id, 'approve']), {}, user, approvedSchema),
    reject: (id: number, user: string) =>
      post(consolePath(['drafts', id, 'reject']), {}, user, rejectedSchema),
    edit: (id: number, body: LetterEdit, user: string) =>
      post(consolePath(['drafts', id, 'edit']), { ...body }, user, savedSchema),
    sendTest: (id: number, user: string) =>
      post(consolePath(['drafts', id, 'send-test']), {}, user, testSentSchema),
    block: (id: number, user: string) =>
      post(consolePath(['companies', id, 'block']), {}, user, blockedSchema),
    clearWhatsapp: (id: number, user: string) =>
      post(consolePath(['companies', id, 'whatsapp-clear']), {}, user, clearedSchema),
    importHistory: (body: HistoryImport, user: string) =>
      post(
        consolePath(['history', 'import']),
        { ...body },
        user,
        importedSchema,
        IMPORT_BODY_LIMIT_BYTES,
      ),
  };
}

export type LeadsApi = ReturnType<typeof createLeadsApi>;
