import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { vi, type Mock } from 'vitest';
import type { ConsoleReads } from '../../../src/domain/console.js';
import type { AppStateRepo, ChatsRepo } from '../../../src/domain/ports.js';
import {
  buildConsoleApi,
  type ConsoleApiDeps,
  type ConsoleStatusFacts,
  type ConsoleWhatsAppState,
} from '../../../src/panel/console-api.js';
import { createRecentReplies } from '../../../src/panel/recent-replies.js';
import { buildPanel } from '../../../src/panel/server.js';
import {
  createHarness,
  csrfOf,
  HOST_HEADER,
  ORIGIN,
  sessionCookieOf,
  T0,
  type Harness,
  type HarnessOptions,
} from './harness.js';

// API консоли на тех же моках, что старая панель (harness.ts): действия видны в h.actions() в общем порядке.
// Рядом своя панель с той же памятью недавних ответов, как в pipeline/panel-setup.ts.

export const CONSOLE_PORT = 3101;
export const CONSOLE_HOST = `127.0.0.1:${CONSOLE_PORT}`;
export const CONSOLE_TOKEN = 'console-token-0123456789-abcdefghijklmnop';
export const CONSOLE_USER = 'manager.1';

export const FACTS: ConsoleStatusFacts = {
  waEnabled: true,
  testMode: true,
  allowlistSize: 2,
  managerConfigured: true,
  companyFeature: true,
  llmConfigured: true,
  apiDailyLimit: 500,
  apiPerChatLimit: 100,
};

/** Выборки-моки; транзакция чтения просто вызывает work и считает вызовы. */
export type ReadsMocks = {
  [K in Exclude<keyof ConsoleReads, 'readTransaction'>]: Mock<ConsoleReads[K]>;
} & { readonly readTransaction: ConsoleReads['readTransaction']; transactions(): number };

/** Выборки консоли по умолчанию пустые: тест подставляет нужные строки. */
export function emptyReads(): ReadsMocks {
  let transactions = 0;
  return {
    readTransaction: <T>(work: () => T): T => {
      transactions += 1;
      return work();
    },
    transactions: () => transactions,
    listChats: vi.fn<ConsoleReads['listChats']>(() => []),
    countChats: vi.fn<ConsoleReads['countChats']>(() => 0),
    openHandoffs: vi.fn<ConsoleReads['openHandoffs']>(() => []),
    hotChats: vi.fn<ConsoleReads['hotChats']>(() => []),
    waitingChats: vi.fn<ConsoleReads['waitingChats']>(() => []),
    attentionCounts: vi.fn<ConsoleReads['attentionCounts']>(() => ({
      handoffs: 0,
      hot: 0,
      waiting: 0,
      staleWaiting: 0,
    })),
    pendingBacklogCount: vi.fn<ConsoleReads['pendingBacklogCount']>(() => 0),
    chatMeta: vi.fn<ConsoleReads['chatMeta']>(() => ({
      statusChangedAtMs: null,
      createdAtMs: T0,
    })),
    profileMeta: vi.fn<ConsoleReads['profileMeta']>(() => null),
    handoffHistory: vi.fn<ConsoleReads['handoffHistory']>(() => []),
    countRejected: vi.fn<ConsoleReads['countRejected']>(() => 0),
    listNotifications: vi.fn<ConsoleReads['listNotifications']>(() => []),
    countNotifications: vi.fn<ConsoleReads['countNotifications']>(() => 0),
    companyLinks: vi.fn<ConsoleReads['companyLinks']>(() => []),
    countCompanyLinks: vi.fn<ConsoleReads['countCompanyLinks']>(() => 0),
    apiCallsOn: vi.fn<ConsoleReads['apiCallsOn']>(() => 0),
    pairingAttemptsSince: vi.fn<ConsoleReads['pairingAttemptsSince']>(() => 0),
  };
}

export interface ConsoleRequest {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD' | 'OPTIONS';
  readonly url: string;
  /** Тело объектом (уйдёт JSON) или строкой как есть. */
  readonly body?: unknown;
  readonly contentType?: string;
  /** Заголовки поверх стандартных; значение null убирает заголовок. */
  readonly headers?: Readonly<Record<string, string | null>>;
  readonly remoteAddress?: string;
}

export interface ConsoleHarnessOptions extends HarnessOptions {
  readonly facts?: Partial<ConsoleStatusFacts>;
  readonly tokenLogPath?: string;
  readonly whatsapp?: ConsoleWhatsAppState;
}

export interface ConsoleHarness {
  /** Моки и данные старой панели (harness.ts): репозитории, outbox, передача, порядок действий, лог. */
  readonly h: Harness;
  readonly app: FastifyInstance;
  /** Старая панель с той же памятью недавних ответов, что у консоли. */
  readonly panel: FastifyInstance;
  readonly deps: ConsoleApiDeps;
  readonly reads: ReadsMocks;
  readonly getProgress: Mock<ChatsRepo['getProgress']>;
  readonly appState: {
    [K in 'getLinkedAtMs' | 'getWorkingSinceMs' | 'getHistoryIncomplete']: Mock<AppStateRepo[K]>;
  };
  readonly researchStarts: Mock<(sinceMs: number) => number>;
  readonly whatsapp: Mock<() => ConsoleWhatsAppState>;
  request(options: ConsoleRequest): Promise<LightMyRequestResponse>;
  /** Ответ формой старой панели (вход, токен CSRF, POST) по адресу path. */
  panelPost(path: string, form: Readonly<Record<string, string>>): Promise<LightMyRequestResponse>;
}

/** Заголовки запроса консоли: Host, токен, у POST имя пользователя; null убирает заголовок. */
function headersOf(request: ConsoleRequest, method: string): Record<string, string> {
  const base: Record<string, string | null> = {
    host: CONSOLE_HOST,
    'x-console-token': CONSOLE_TOKEN,
    ...(method === 'POST' ? { 'x-console-user': CONSOLE_USER } : {}),
    ...(request.body === undefined
      ? {}
      : { 'content-type': request.contentType ?? 'application/json' }),
    ...request.headers,
  };
  return Object.fromEntries(
    Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== null),
  );
}

export function createConsoleHarness(options: ConsoleHarnessOptions = {}): ConsoleHarness {
  const h = createHarness(options);
  const recentReplies = createRecentReplies(h.deps.clock);
  const panel = buildPanel({ ...h.deps, recentReplies });
  const reads = emptyReads();
  const getProgress = vi.fn<ChatsRepo['getProgress']>(() => ({ priceAsks: 0, refused: false }));
  const appState = {
    getLinkedAtMs: vi.fn<AppStateRepo['getLinkedAtMs']>(() => null),
    getWorkingSinceMs: vi.fn<AppStateRepo['getWorkingSinceMs']>(() => null),
    getHistoryIncomplete: vi.fn<AppStateRepo['getHistoryIncomplete']>(() => null),
  };
  const researchStarts = vi.fn((_sinceMs: number) => 0);
  const whatsapp = vi.fn(() => options.whatsapp ?? { state: 'open' as const, sinceMs: T0 });
  const deps: ConsoleApiDeps = {
    token: CONSOLE_TOKEN,
    port: CONSOLE_PORT,
    chats: { getById: h.chats.getById, getNote: h.chats.getNote, getProgress },
    messages: h.messages,
    handoffs: h.handoffs,
    notifications: h.notifications,
    rejectedDrafts: h.rejectedDrafts,
    company: h.company,
    reads,
    appState,
    researchStarts,
    whatsapp,
    facts: { ...FACTS, ...options.facts },
    tokenLogPath: options.tokenLogPath ?? 'нет-такого-файла.jsonl',
    outbox: h.outbox,
    handoff: h.handoff,
    resume: h.resume,
    recentReplies,
    clock: h.deps.clock,
    logger: h.deps.logger,
  };
  const app = buildConsoleApi(deps);
  const request: ConsoleHarness['request'] = (req) => {
    const method = req.method ?? (req.body === undefined ? 'GET' : 'POST');
    const payload =
      req.body === undefined || typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    return app.inject({
      method,
      url: req.url,
      headers: headersOf(req, method),
      payload,
      remoteAddress: req.remoteAddress,
    });
  };
  const panelPost: ConsoleHarness['panelPost'] = async (path, form) => {
    const form_ = 'application/x-www-form-urlencoded';
    const login = await panel.inject({
      method: 'POST',
      url: '/login',
      headers: { host: HOST_HEADER, origin: ORIGIN, 'content-type': form_ },
      payload: 'password=admin',
    });
    const cookie = sessionCookieOf(login) ?? '';
    const page = await panel.inject({ url: '/chats', headers: { host: HOST_HEADER, cookie } });
    const csrf = csrfOf(page.body);
    return panel.inject({
      method: 'POST',
      url: path,
      headers: { host: HOST_HEADER, origin: ORIGIN, cookie, 'content-type': form_ },
      payload: new URLSearchParams({ csrf, ...form }).toString(),
    });
  };
  return {
    h,
    app,
    panel,
    deps,
    reads,
    getProgress,
    appState,
    researchStarts,
    whatsapp,
    request,
    panelPost,
  };
}

/** Тело ответа JSON. */
export function jsonOf(response: LightMyRequestResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}
