import { createCompanyService } from '../../../src/company/service.js';
import { emptyCompanyState } from '../../../src/db/repos/chat-companies.js';
import type {
  ChatCompaniesRepo,
  ChatCompanyState,
  CompanyApiFailure,
  CompanyApiResult,
  CompanyBrief,
  CompanyCandidate,
  CompanyDirectory,
  CompanyId,
  CompanyLookupQuery,
  CompanyService,
  LogoReader,
  ResearchJobId,
  ResearchRequest,
  ResearchStart,
  ResearchStatus,
} from '../../../src/domain/company.js';
import type {
  BusinessProfileResult,
  ImageInput,
  WhatsAppContacts,
} from '../../../src/domain/ports.js';
import type {
  Chat,
  ChatId,
  ChatIdentity,
  InboundMessage,
  Jid,
  LlmResult,
  WaMessageId,
} from '../../../src/domain/types.js';
import {
  CLIENT_JID,
  createFakeLogger,
  createManualClock,
  makeChat,
  type LogEntry,
  type ManualClock,
} from '../handoff/fakes.js';
import { CHAT_ID, deepFreeze, NOW } from './builders.js';

// Подделки портов для тестов определения компании: ни сети, ни базы, ни WhatsApp, ни модели.

export function ok<T>(value: T): CompanyApiResult<T> {
  return { ok: true, value };
}

export function fail<T>(failure: CompanyApiFailure): CompanyApiResult<T> {
  return { ok: false, failure };
}

export type DirectoryCall =
  | { readonly method: 'lookup'; readonly query: CompanyLookupQuery }
  | { readonly method: 'brief'; readonly id: CompanyId }
  | { readonly method: 'startResearch'; readonly request: ResearchRequest }
  | { readonly method: 'researchStatus'; readonly jobId: ResearchJobId };

/**
 * Как поддельный API отвечает на каждый вызов. Без обработчика: lookup находит пусто, остальные вызовы
 * отвечают «недоступно». Обработчик вызывается при каждом обращении, поэтому ответы могут меняться от вызова
 * к вызову (счётчик в замыкании).
 */
export interface DirectoryHandlers {
  readonly lookup?: (query: CompanyLookupQuery) => CompanyApiResult<readonly CompanyCandidate[]>;
  readonly brief?: (id: CompanyId) => CompanyApiResult<CompanyBrief>;
  readonly startResearch?: (request: ResearchRequest) => CompanyApiResult<ResearchStart>;
  readonly researchStatus?: (jobId: ResearchJobId) => CompanyApiResult<ResearchStatus>;
}

export interface FakeDirectory {
  readonly directory: CompanyDirectory;
  /** Все вызовы по порядку. */
  readonly calls: DirectoryCall[];
  /** Запросы lookup по порядку. */
  lookups(): readonly CompanyLookupQuery[];
  /** Сколько раз вызван метод. */
  count(method: DirectoryCall['method']): number;
}

export function createFakeDirectory(
  handlers: DirectoryHandlers = {},
  events: string[] = [],
): FakeDirectory {
  const calls: DirectoryCall[] = [];
  const directory: CompanyDirectory = {
    enabled: true,
    lookup: (query) => {
      calls.push({ method: 'lookup', query });
      events.push(`directory.lookup:${query.by}`);
      return Promise.resolve(handlers.lookup?.(query) ?? ok([]));
    },
    brief: (id) => {
      calls.push({ method: 'brief', id });
      events.push('directory.brief');
      return Promise.resolve(handlers.brief?.(id) ?? fail('unavailable'));
    },
    startResearch: (request) => {
      calls.push({ method: 'startResearch', request });
      events.push('directory.startResearch');
      return Promise.resolve(handlers.startResearch?.(request) ?? fail('unavailable'));
    },
    researchStatus: (jobId) => {
      calls.push({ method: 'researchStatus', jobId });
      events.push('directory.researchStatus');
      return Promise.resolve(handlers.researchStatus?.(jobId) ?? fail('unavailable'));
    },
  };
  return {
    directory,
    calls,
    lookups: () => calls.flatMap((call) => (call.method === 'lookup' ? [call.query] : [])),
    count: (method) => calls.filter((call) => call.method === method).length,
  };
}

/** Обработчик lookup по виду признака: домен, телефон или название; на остальное пустой список. */
export function lookupBy(
  answers: Partial<Record<CompanyLookupQuery['by'], CompanyApiResult<readonly CompanyCandidate[]>>>,
): NonNullable<DirectoryHandlers['lookup']> {
  return (query) => answers[query.by] ?? ok([]);
}

export type ContactsCall =
  | { readonly method: 'businessProfile'; readonly jid: Jid }
  | { readonly method: 'profilePhoto'; readonly jid: Jid; readonly maxBytes: number };

export interface FakeContacts {
  readonly contacts: WhatsAppContacts;
  readonly calls: ContactsCall[];
  count(method: ContactsCall['method']): number;
}

export interface ContactsOptions {
  /** Ответ businessProfile (функция: ответ на каждый вызов свой); по умолчанию обычный аккаунт. */
  readonly profile?: BusinessProfileResult | (() => BusinessProfileResult);
  /** Ответ profilePhoto; по умолчанию фото нет. */
  readonly photo?: ImageInput | null;
}

export function createFakeContacts(
  options: ContactsOptions = {},
  events: string[] = [],
): FakeContacts {
  const calls: ContactsCall[] = [];
  const contacts: WhatsAppContacts = {
    businessProfile: (jid) => {
      calls.push({ method: 'businessProfile', jid });
      events.push('contacts.businessProfile');
      const { profile } = options;
      return Promise.resolve(
        typeof profile === 'function' ? profile() : (profile ?? { kind: 'personal' }),
      );
    },
    profilePhoto: (jid, maxBytes) => {
      calls.push({ method: 'profilePhoto', jid, maxBytes });
      events.push('contacts.profilePhoto');
      return Promise.resolve(options.photo ?? null);
    },
  };
  return {
    contacts,
    calls,
    count: (method) => calls.filter((call) => call.method === method).length,
  };
}

export interface FakeLogo {
  readonly logo: LogoReader;
  readonly calls: { readonly chatId: ChatId; readonly photo: ImageInput }[];
}

/** Чтение логотипа: всегда один и тот же ответ (по умолчанию название не найдено). */
export function createFakeLogo(
  answer: LlmResult<string | null> = { ok: true, value: null },
  events: string[] = [],
): FakeLogo {
  const calls: { chatId: ChatId; photo: ImageInput }[] = [];
  return {
    logo: {
      readLogo: (chatId, photo) => {
        calls.push({ chatId, photo });
        events.push('logo.readLogo');
        return Promise.resolve(answer);
      },
    },
    calls,
  };
}

export interface MemoryRepo extends ChatCompaniesRepo {
  /** Каждая запись по порядку, как её получил репозиторий. */
  readonly saves: ChatCompanyState[];
  /** Кладёт состояние без учёта в saves: заранее известное состояние чата. */
  seed(state: ChatCompanyState): void;
  /** Что лежит в базе сейчас (пустое состояние, если записи нет). */
  current(chatId?: ChatId): ChatCompanyState;
  /** Следующий вызов метода падает этой ошибкой (один раз): сбой базы. */
  failNext(method: 'get' | 'save', error: Error): void;
}

/**
 * Репозиторий в памяти по документации порта ChatCompaniesRepo: записи нет => пустое состояние; дневной предел
 * проверок считает отметки researchStartedAtMs и officialResearchStartedAtMs всех чатов. Все состояния заморожены: сервис, который изменил бы
 * состояние на месте, а не собрал новое, упал бы ошибкой.
 */
export function createMemoryRepo(events: string[] = []): MemoryRepo {
  const stored = new Map<ChatId, ChatCompanyState>();
  const saves: ChatCompanyState[] = [];
  const failures = new Map<'get' | 'save', Error>();
  const failIfScheduled = (method: 'get' | 'save'): void => {
    const error = failures.get(method);
    if (error === undefined) return;
    failures.delete(method);
    throw error;
  };
  const current = (chatId: ChatId = CHAT_ID): ChatCompanyState =>
    stored.get(chatId) ?? deepFreeze(emptyCompanyState(chatId));
  return {
    saves,
    get: (chatId) => {
      failIfScheduled('get');
      return current(chatId);
    },
    save: (state) => {
      failIfScheduled('save');
      events.push('repo.save');
      saves.push(deepFreeze(state));
      stored.set(state.chatId, state);
    },
    countResearchStarts: (sinceMs) =>
      [...stored.values()]
        .flatMap((state) => [state.researchStartedAtMs, state.officialResearchStartedAtMs])
        .filter((startedAtMs) => (startedAtMs ?? -1) > sinceMs).length,
    seed: (state) => {
      stored.set(state.chatId, deepFreeze(state));
    },
    current,
    failNext: (method, error) => {
      failures.set(method, error);
    },
  };
}

/** Чат без номера: только адрес @lid (WhatsApp скрыл номер). */
export const LID_JID = '100000000000001@lid' as Jid;
export const LID_ONLY: ChatIdentity = { replyJid: LID_JID, lidJid: LID_JID, pnJid: null };

export function lidChat(): Chat {
  return makeChat({ identity: LID_ONLY });
}

/** Сообщение клиента в пачке: важны только имена из профиля. */
export function makeMessage(
  overrides: Partial<Pick<InboundMessage, 'pushName' | 'verifiedName' | 'tsMs'>> = {},
  identity: ChatIdentity = { replyJid: CLIENT_JID, lidJid: null, pnJid: CLIENT_JID },
): InboundMessage {
  return {
    waId: 'WA-1' as WaMessageId,
    identity,
    pushName: null,
    content: { kind: 'text', text: 'Здравствуйте' },
    tsMs: NOW,
    ...overrides,
  };
}

export interface HarnessOptions {
  /** Ответы поддельного API; 'off': внутренний API выключен. */
  readonly directory?: DirectoryHandlers | 'off';
  readonly contacts?: ContactsOptions;
  readonly logo?: LlmResult<string | null>;
  readonly emailUiUrl?: string | null;
  /** Состояние чата до начала теста. */
  readonly state?: ChatCompanyState;
}

export interface Harness {
  readonly service: CompanyService;
  readonly repo: MemoryRepo;
  readonly directory: FakeDirectory;
  readonly contacts: FakeContacts;
  readonly logo: FakeLogo;
  readonly clock: ManualClock;
  readonly logs: LogEntry[];
  /** Порядок обращений к репозиторию, API, WhatsApp и модели: так проверяется, что было раньше. */
  readonly events: string[];
}

/** Сервис компании на подделках всех портов. */
export function createHarness(options: HarnessOptions = {}): Harness {
  const events: string[] = [];
  const logs: LogEntry[] = [];
  const repo = createMemoryRepo(events);
  if (options.state !== undefined) repo.seed(options.state);
  const directory = createFakeDirectory(
    options.directory === 'off' ? {} : options.directory,
    events,
  );
  const contacts = createFakeContacts(options.contacts, events);
  const logo = createFakeLogo(options.logo, events);
  const clock = createManualClock(NOW);
  const service = createCompanyService({
    directory: options.directory === 'off' ? { enabled: false } : directory.directory,
    contacts: contacts.contacts,
    logo: logo.logo,
    repo,
    clock,
    logger: createFakeLogger(logs),
    emailUiUrl: options.emailUiUrl === undefined ? null : options.emailUiUrl,
  });
  return { service, repo, directory, contacts, logo, clock, logs, events };
}

/** Картинка профиля для тестов шага д. */
export const PHOTO: ImageInput = { data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' };
