import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { vi, type Mock } from 'vitest';
import type { CompanyService, CompanySummary } from '../../../src/domain/company.js';
import type {
  ChatsRepo,
  Clock,
  HandoffsRepo,
  ManagerNotificationsRepo,
  MessagesRepo,
  RejectedDraftsRepo,
} from '../../../src/domain/ports.js';
import type {
  BotNote,
  Chat,
  ChatId,
  ClientProfile,
  Jid,
  ManagerNotification,
  OpenHandoff,
  PanelChatRow,
  StoredMessage,
  StoredRejectedDraft,
} from '../../../src/domain/types.js';
import type { HandoffService } from '../../../src/handoff/handoff.js';
import type { Outbox } from '../../../src/messaging/outbox.js';
import { buildPanel, type PanelDeps } from '../../../src/panel/server.js';
import { createLogger } from '../../../src/shared/logger.js';

export const PORT = 3100;
export const HOST_HEADER = `127.0.0.1:${PORT}`;
export const ORIGIN = `http://${HOST_HEADER}`;
export const WEAK_PASSWORD = 'admin';
export const STRONG_PASSWORD = 'correct-horse-battery';
export const T0 = Date.UTC(2026, 9, 26, 10, 0);
export const MINUTE_MS = 60_000;

export const EMPTY_PROFILE: ClientProfile = {
  business: null,
  area: null,
  scope: null,
  itemCount: null,
  has1C: null,
  oneCName: null,
  problem: null,
  specifics: null,
  problemAgreed: false,
};

/** Сводка выключенной функции определения компании: так панель работает по умолчанию в тестах. */
export const OFF_COMPANY: CompanySummary = {
  status: 'off',
  companyId: null,
  name: null,
  city: null,
  rubric: null,
  candidateSource: null,
  cardUrl: null,
  confirmedPains: [],
  briefPains: [],
  emailed: null,
  research: null,
  statedName: null,
};

export function chatIdOf(id: number): ChatId {
  return id as ChatId;
}

/** Чат с вымышленным номером 77000000000 + id и именем «Клиент id». */
export function makeChat(id: number, overrides: Partial<Omit<Chat, 'id'>> = {}): Chat {
  const jid = `77${String(id).padStart(9, '0')}@s.whatsapp.net` as Jid;
  return {
    id: chatIdOf(id),
    identity: { replyJid: jid, lidJid: null, pnJid: jid },
    pushName: `Клиент ${String(id)}`,
    control: { status: 'bot', by: null },
    level: 'cold',
    profile: EMPTY_PROFILE,
    ...overrides,
  };
}

export function makeMessage(
  id: number,
  chat: number,
  overrides: Partial<Omit<StoredMessage, 'id' | 'chatId'>> = {},
): StoredMessage {
  return {
    id,
    chatId: chatIdOf(chat),
    author: 'client',
    kind: 'text',
    text: `Сообщение ${String(id)}`,
    tsMs: T0 + id * MINUTE_MS,
    ...overrides,
  };
}

export function makeNotification(
  id: number,
  overrides: Partial<Omit<ManagerNotification, 'id'>> = {},
): ManagerNotification {
  return {
    id,
    kind: 'handoff',
    chatId: chatIdOf(1),
    text: `Уведомление ${String(id)}`,
    status: 'sent',
    attempts: 1,
    createdAtMs: T0 + id * MINUTE_MS,
    updatedAtMs: T0 + id * MINUTE_MS,
    ...overrides,
  };
}

/** Данные, которые отдают поддельные репозитории. Порядок как в списке: сортировку делает настоящая база. */
export interface PanelData {
  chats: Chat[];
  messages: StoredMessage[];
  handoffs: Map<number, OpenHandoff>;
  notifications: ManagerNotification[];
  /** Времена последних сообщений для списка чатов (по умолчанию из messages). */
  lastMessageAt: Map<number, number>;
  /** Сводки о компании по ID чата (по умолчанию OFF_COMPANY); Error: чтение сводки падает этой ошибкой. */
  companies: Map<number, CompanySummary | Error>;
  /** Заметки для бота по ID чата (по умолчанию нет). */
  notes: Map<number, BotNote>;
  /** Отклонённые черновики (по умолчанию нет); репозиторий отдаёт свежие первыми. */
  rejectedDrafts: StoredRejectedDraft[];
}

export interface HarnessOptions {
  readonly password?: string;
  readonly allowedHosts?: readonly string[];
  readonly data?: Partial<PanelData>;
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly cookie?: string;
  readonly host?: string;
  /** Origin по умолчанию у POST свой; null: без заголовка. */
  readonly origin?: string | null;
  readonly referer?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly form?: Readonly<Record<string, string>>;
  readonly payload?: string;
  readonly contentType?: string;
  readonly remoteAddress?: string;
}

export interface Auth {
  readonly cookie: string;
  readonly csrf: string;
}

export interface Harness {
  readonly app: FastifyInstance;
  readonly data: PanelData;
  readonly deps: PanelDeps;
  readonly chats: { [K in keyof ChatsRepo]: Mock<ChatsRepo[K]> };
  readonly messages: { [K in keyof MessagesRepo]: Mock<MessagesRepo[K]> };
  readonly handoffs: { [K in keyof HandoffsRepo]: Mock<HandoffsRepo[K]> };
  readonly notifications: {
    [K in keyof ManagerNotificationsRepo]: Mock<ManagerNotificationsRepo[K]>;
  };
  readonly outbox: { [K in keyof Outbox]: Mock<Outbox[K]> };
  readonly handoff: { [K in keyof HandoffService]: Mock<HandoffService[K]> };
  readonly company: { summary: Mock<CompanyService['summary']> };
  readonly rejectedDrafts: { listForChat: Mock<RejectedDraftsRepo['listForChat']> };
  /** Ответ бота на неотвеченное после возврата: по умолчанию отвечать не на что (0). */
  readonly resume: Mock<NonNullable<PanelDeps['resume']>>;
  /** Действия над чатом в порядке вызова: handOff, sendFromPanel, returnToBot, resume. */
  actions(): string[];
  advance(ms: number): void;
  request(options: RequestOptions): Promise<LightMyRequestResponse>;
  /** Вход по паролю и токен CSRF с первой страницы. */
  login(password?: string): Promise<Auth>;
  /** Строки лога как объекты. */
  logs(): Record<string, unknown>[];
  /** Сырой текст лога: проверить, что в нём нет текста сообщений и номеров. */
  rawLog(): string;
}

function notUsed(name: string): never {
  throw new Error(`Панель не должна вызывать ${name}`);
}

/** Метод, которого панель вызывать не должна: вызов роняет тест, а мок позволяет проверить, что его не было. */
function unused<T extends (...args: never[]) => unknown>(name: string): Mock<T> {
  return vi.fn<T>((() => notUsed(name)) as unknown as T);
}

function createChatsRepo(data: PanelData): Harness['chats'] {
  const rowOf = (chat: Chat): PanelChatRow => ({
    chat,
    lastMessageAtMs: data.lastMessageAt.get(chat.id) ?? lastTimeOf(data.messages, chat.id),
    openHandoff: data.handoffs.get(chat.id) ?? null,
  });
  const filtered = (status: string | undefined): Chat[] =>
    data.chats.filter((chat) => status === undefined || chat.control.status === status);
  return {
    upsertByIdentity: unused('chats.upsertByIdentity'),
    findByJid: unused('chats.findByJid'),
    getById: vi.fn((id) => data.chats.find((chat) => chat.id === id) ?? null),
    setStatus: unused('chats.setStatus'),
    saveAssessment: unused('chats.saveAssessment'),
    listForPanel: vi.fn((query) =>
      filtered(query.status)
        .slice(query.offset, query.offset + query.limit)
        .map(rowOf),
    ),
    countForPanel: vi.fn((query) => filtered(query.status).length),
    getProgress: unused('chats.getProgress'),
    recordTurn: unused('chats.recordTurn'),
    resetProgress: unused('chats.resetProgress'),
    getNote: vi.fn((id) => data.notes.get(id) ?? null),
    setNote: unused('chats.setNote'),
  };
}

function lastTimeOf(messages: readonly StoredMessage[], chat: ChatId): number | null {
  const times = messages.filter((message) => message.chatId === chat).map((m) => m.tsMs);
  return times.length === 0 ? null : Math.max(...times);
}

function createMessagesRepo(data: PanelData): Harness['messages'] {
  return {
    insertIfNew: unused('messages.insertIfNew'),
    recent: unused('messages.recent'),
    isUnansweredInbound: unused('messages.isUnansweredInbound'),
    markAnswered: unused('messages.markAnswered'),
    setTranscript: unused('messages.setTranscript'),
    unansweredAfterLastOutbound: unused('messages.unansweredAfterLastOutbound'),
    reopenAnsweredByHandoff: unused('messages.reopenAnsweredByHandoff'),
    history: vi.fn((chat, query) => {
      const ordered = data.messages
        .filter((message) => message.chatId === chat)
        .filter((message) => query.beforeId === undefined || message.id < query.beforeId)
        .sort((a, b) => a.tsMs - b.tsMs || a.id - b.id);
      return query.limit === 0 ? [] : ordered.slice(-query.limit);
    }),
  };
}

function createHandoffsRepo(data: PanelData): Harness['handoffs'] {
  return {
    open: unused('handoffs.open'),
    findOpen: vi.fn((chat) => data.handoffs.get(chat) ?? null),
    resolve: unused('handoffs.resolve'),
  };
}

function createNotificationsRepo(data: PanelData): Harness['notifications'] {
  const newestFirst = (): ManagerNotification[] =>
    [...data.notifications].sort((a, b) => b.id - a.id);
  return {
    add: unused('notifications.add'),
    setResult: unused('notifications.setResult'),
    listRetryable: unused('notifications.listRetryable'),
    listRecent: vi.fn((query) => newestFirst().slice(query.offset, query.offset + query.limit)),
    countAll: vi.fn(() => data.notifications.length),
    latestForChat: vi.fn((chat) => newestFirst().find((item) => item.chatId === chat) ?? null),
  };
}

function orderedCalls(
  name: string,
  mock: Mock<(...args: never[]) => unknown>,
): { name: string; order: number }[] {
  return mock.mock.invocationCallOrder.map((order) => ({ name, order }));
}

function setCookieValues(response: LightMyRequestResponse): string[] {
  const header = response.headers['set-cookie'];
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [header];
}

/** Значение cookie сессии из ответа: «tanbala_sid=...» без флагов. */
export function sessionCookieOf(response: LightMyRequestResponse): string | null {
  const line = setCookieValues(response).find((value) => value.startsWith('tanbala_sid='));
  return line === undefined ? null : (line.split(';')[0] ?? null);
}

export function setCookieLines(response: LightMyRequestResponse): string[] {
  return setCookieValues(response);
}

export function csrfOf(html: string): string {
  const match = /name="csrf" value="([^"]+)"/.exec(html);
  if (match?.[1] === undefined) throw new Error('В странице нет скрытого поля csrf');
  return match[1];
}

function encodeForm(fields: Readonly<Record<string, string>>): string {
  return new URLSearchParams(fields).toString();
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const data: PanelData = {
    chats: [],
    messages: [],
    handoffs: new Map(),
    notifications: [],
    lastMessageAt: new Map(),
    companies: new Map(),
    notes: new Map(),
    rejectedDrafts: [],
    ...options.data,
  };
  const password = options.password ?? WEAK_PASSWORD;
  let now = T0;
  const clock: Clock = { now: () => now, sleep: () => Promise.resolve() };
  const lines: string[] = [];
  const logger = createLogger({
    level: 'info',
    destination: {
      write: (line) => {
        lines.push(line);
      },
    },
  });
  const outbox: Harness['outbox'] = {
    sendBotReply: unused('outbox.sendBotReply'),
    sendHandoffNotice: unused('outbox.sendHandoffNotice'),
    sendHandoffText: unused('outbox.sendHandoffText'),
    sendVoiceNotice: unused('outbox.sendVoiceNotice'),
    notifyManager: unused('outbox.notifyManager'),
    canSendFromPanel: vi.fn(() => true),
    sendFromPanel: vi.fn(() => Promise.resolve('sent' as const)),
  };
  const handoff: Harness['handoff'] = {
    handOff: vi.fn(() => Promise.resolve()),
    returnToBot: vi.fn(() => Promise.resolve()),
  };
  const company: Harness['company'] = {
    summary: vi.fn((chatId) => {
      const summary = data.companies.get(chatId) ?? OFF_COMPANY;
      if (summary instanceof Error) throw summary;
      return summary;
    }),
  };
  const chats = createChatsRepo(data);
  const messages = createMessagesRepo(data);
  const handoffs = createHandoffsRepo(data);
  const notifications = createNotificationsRepo(data);
  const resume = vi.fn<NonNullable<PanelDeps['resume']>>(() => 0);
  const rejectedDrafts: Harness['rejectedDrafts'] = {
    listForChat: vi.fn((chatId, limit) =>
      data.rejectedDrafts
        .filter((item) => item.chatId === chatId)
        .toSorted((a, b) => b.atMs - a.atMs || b.id - a.id)
        .slice(0, limit),
    ),
  };
  const deps: PanelDeps = {
    chats,
    messages,
    handoffs,
    notifications,
    outbox,
    handoff,
    company,
    resume,
    rejectedDrafts,
    clock,
    logger,
    password,
    port: PORT,
    allowedHosts: options.allowedHosts,
  };
  const app = buildPanel(deps);
  const request: Harness['request'] = (req) => {
    const method =
      req.method ?? (req.form === undefined && req.payload === undefined ? 'GET' : 'POST');
    const headers: Record<string, string> = { host: req.host ?? HOST_HEADER, ...req.headers };
    if (req.cookie !== undefined) headers['cookie'] = req.cookie;
    if (method !== 'GET' && req.origin !== null) headers['origin'] = req.origin ?? ORIGIN;
    if (req.referer !== undefined) headers['referer'] = req.referer;
    const payload = req.payload ?? (req.form === undefined ? undefined : encodeForm(req.form));
    if (payload !== undefined) {
      headers['content-type'] = req.contentType ?? 'application/x-www-form-urlencoded';
    }
    return app.inject({ method, url: req.url, headers, payload, remoteAddress: req.remoteAddress });
  };
  const login: Harness['login'] = async (typed = password) => {
    const response = await request({ url: '/login', form: { password: typed } });
    const cookie = sessionCookieOf(response);
    if (response.statusCode !== 303 || cookie === null) {
      throw new Error(`Вход не удался: статус ${String(response.statusCode)}`);
    }
    const page = await request({ url: '/chats', cookie });
    return { cookie, csrf: csrfOf(page.body) };
  };
  return {
    app,
    data,
    deps,
    chats,
    messages,
    handoffs,
    notifications,
    outbox,
    handoff,
    company,
    resume,
    rejectedDrafts,
    actions: () =>
      [
        ...orderedCalls('handOff', handoff.handOff),
        ...orderedCalls('sendFromPanel', outbox.sendFromPanel),
        ...orderedCalls('returnToBot', handoff.returnToBot),
        ...orderedCalls('resume', resume),
      ]
        .sort((a, b) => a.order - b.order)
        .map((call) => call.name),
    advance: (ms) => {
      now += ms;
    },
    request,
    login,
    logs: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    rawLog: () => lines.join(''),
  };
}
