import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { onTestFinished, vi, type Mock } from 'vitest';
import type { CompanyFetch } from '../../../src/company-api/directory.js';
import { loadConfig, type AppConfig } from '../../../src/config/env.js';
import { createUnitOfWork } from '../../../src/db/connection.js';
import { createBacklogRepo } from '../../../src/db/repos/backlog.js';
import { createCallBudget } from '../../../src/db/repos/call-budget.js';
import { createChatCompaniesRepo } from '../../../src/db/repos/chat-companies.js';
import { createChatsRepo } from '../../../src/db/repos/chats.js';
import { createHandoffsRepo } from '../../../src/db/repos/handoffs.js';
import { createManagerNotificationsRepo } from '../../../src/db/repos/manager-notifications.js';
import { createMessagesRepo } from '../../../src/db/repos/messages.js';
import { createOutboundIdsRepo } from '../../../src/db/repos/outbound-ids.js';
import type { ChatCompaniesRepo, ChatCompanyState } from '../../../src/domain/company.js';
import type {
  BusinessProfileResult,
  Clock,
  Logger,
  WhatsAppContacts,
} from '../../../src/domain/ports.js';
import type {
  ChatId,
  ChatIdentity,
  InboundMessage,
  Jid,
  LlmPurpose,
  WaMessageId,
} from '../../../src/domain/types.js';
import { assembleCompany, type CompanySetup } from '../../../src/pipeline/company-setup.js';
import type { PipelineOutcome } from '../../../src/pipeline/handle-inbound.js';
import {
  assembleResponder,
  type ResponderConnection,
  type ResponderStorage,
} from '../../../src/pipeline/responder-setup.js';
import {
  assembleServices,
  type Services,
  type ServicesStorage,
} from '../../../src/pipeline/services.js';
import { createFakeLogger, type LogEntry } from '../../helpers/fake-logger.js';
import { ROOT as PROJECT_ROOT } from '../../helpers/source-files.js';
import { useMigratedDb, useTempDir } from '../db/fixture.js';
import {
  scriptedLlm,
  type LlmScript,
  type RecordedRequest,
  type ScriptedLlm,
} from './scripted-llm.js';

// Стенд сценариев владельца о компании клиента (pipeline/company-scenarios.test.ts). Сборка как в main.ts:
// assembleCompany (настоящие сервис компании и клиент внутреннего API), assembleServices (outbox, передача,
// уведомления), assembleResponder (агент, конвейер, очередь склейки), настоящие знания и репозитории на SQLite в
// памяти. Поддельные только сеть (fetch внутреннего API), WhatsApp (подключение и профиль собеседника) и модель
// (scripted-llm.ts): 0 токенов. Каждая реплика клиента проходит очередь склейки до конца (drain), поэтому её
// результат виден целиком, включая поиск компании после ответа. Модель своя на каждую реплику: агент и очередь
// (assembleResponder) собираются заново, а база, сервис компании, outbox и передача общие (как после перезапуска).

export const CLIENT_PHONE = '77000000002';
export const CLIENT_JID = `${CLIENT_PHONE}@s.whatsapp.net` as Jid;
export const CLIENT_LID = '100000000000002@lid' as Jid;
export const MANAGER_PHONE = '77000000009';
export const MANAGER_JID = `${MANAGER_PHONE}@s.whatsapp.net` as Jid;
export const API_URL = 'http://127.0.0.1:8000';
export const API_TOKEN = 'internal-token-0123456789-0123456789-abcdef';
export const EMAIL_UI_URL = 'https://mail.example.kz';
export const START_MS = Date.UTC(2026, 9, 28, 9, 0, 0);
/** Пауза между репликами клиента: больше 5 с, так идущую проверку компании опрашивают на каждой реплике. */
export const TURN_GAP_MS = 30_000;

const MODELS: unknown = JSON.parse(
  readFileSync(join(PROJECT_ROOT, 'config', 'models.json'), 'utf8'),
);

// Поддельный проект B.

/** Запрос к внутреннему API, который ушёл бы по сети. */
export interface ApiCall {
  readonly method: string;
  /** Схема, хост и порт: запросы только на эту машину. */
  readonly origin: string;
  /** Путь без параметров: /internal/lookup, /internal/companies/8/brief и т.п. */
  readonly path: string;
  /** Параметры строки запроса (у lookup ровно один). */
  readonly query: Readonly<Record<string, string>>;
  /** Тело POST, разобранное из JSON; у GET null. */
  readonly body: unknown;
  /** Заголовок X-Internal-Token. */
  readonly token: string | null;
}

/** Ответ поддельного API: готовый ответ или сетевой сбой (как fetch у undici, когда сервер не слушает). */
export type ApiAnswer = Response | 'network_error';

/** Ответы проекта B по вызовам контракта INTERNAL_API.md. Ответ строится на каждый запрос заново. */
export interface ApiRoutes {
  /** GET /internal/lookup: query с одним из domain, phone, name. По умолчанию ничего не найдено. */
  readonly lookup?: (query: Readonly<Record<string, string>>) => ApiAnswer;
  /** GET /internal/companies/{id}/brief. По умолчанию 404. */
  readonly brief?: (id: number) => ApiAnswer;
  /** POST /internal/research. По умолчанию 404. */
  readonly research?: (body: unknown) => ApiAnswer;
  /** GET /internal/research/{job_id}. По умолчанию 404. */
  readonly status?: (jobId: string) => ApiAnswer;
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function nothingFound(): Response {
  return json(200, { candidates: [] });
}

function notFound(): Response {
  return json(404, { error: 'not_found' });
}

const BRIEF_PATH = /^\/internal\/companies\/(\d+)\/brief$/;
const STATUS_PATH = /^\/internal\/research\/([A-Za-z0-9-]+)$/;

function route(routes: ApiRoutes, call: ApiCall): ApiAnswer {
  if (call.path === '/internal/lookup') return (routes.lookup ?? nothingFound)(call.query);
  if (call.path === '/internal/research' && call.method === 'POST') {
    return routes.research?.(call.body) ?? notFound();
  }
  const brief = BRIEF_PATH.exec(call.path)?.[1];
  if (brief !== undefined) return routes.brief?.(Number(brief)) ?? notFound();
  const jobId = STATUS_PATH.exec(call.path)?.[1];
  if (jobId !== undefined) return routes.status?.(jobId) ?? notFound();
  return notFound();
}

function networkError(): Error {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
  });
}

/** fetch внутреннего API: запрос записывается в calls, ответ даёт routes. Сети нет. */
function fakeFetch(routes: ApiRoutes, calls: ApiCall[]): CompanyFetch {
  return (url, init) => {
    const parsed = new URL(url);
    const call: ApiCall = {
      method: init.method ?? 'GET',
      origin: parsed.origin,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
      token: new Headers(init.headers).get('X-Internal-Token'),
    };
    calls.push(call);
    const answer = route(routes, call);
    return answer === 'network_error' ? Promise.reject(networkError()) : Promise.resolve(answer);
  };
}

// Стенд.

/** Как устроен клиент и что отвечает проект B. */
export interface ScenarioOptions {
  /** Ответы проекта B; null: INTERNAL_API_TOKEN не задан и определение компании выключено. */
  readonly api?: ApiRoutes | null;
  /** Бизнес-профиль собеседника в WhatsApp; по умолчанию обычный аккаунт. */
  readonly profile?: BusinessProfileResult;
  /** Номер скрыт: клиент пишет только с адреса @lid. */
  readonly hiddenNumber?: boolean;
  readonly pushName?: string | null;
  readonly verifiedName?: string;
  /** TEST_ALLOWLIST; по умолчанию номер клиента. */
  readonly allowlist?: string;
  /** Закрытый режим выключен, как после этапа 8: только так бот отвечает чату без номера (@lid). */
  readonly openMode?: boolean;
}

/** Одна реплика клиента от сообщения до конца поиска компании после ответа. */
export interface Turn {
  /** Время реплики: часы во время её обработки стоят. */
  readonly atMs: number;
  /** Итог пачки из лога конвейера; null, если пачка не дошла до итога. */
  readonly outcome: PipelineOutcome | null;
  readonly llm: ScriptedLlm;
  readonly toClient: readonly string[];
  readonly toManager: readonly string[];
  /** Запросы к внутреннему API за эту реплику. */
  readonly api: readonly ApiCall[];
  /** Блок данных первого вызова с этим назначением: то, что система передала модели кроме переписки. */
  data(purpose: LlmPurpose): string;
}

/** Профиль собеседника из WhatsApp: только на чтение, ничего не отправляет. */
export interface FakeContacts {
  readonly businessProfile: Mock<WhatsAppContacts['businessProfile']>;
  readonly profilePhoto: Mock<WhatsAppContacts['profilePhoto']>;
}

type Storage = ResponderStorage & ServicesStorage & { readonly chatCompanies: ChatCompaniesRepo };

export interface Scenario {
  /** Клиент пишет сообщение; модель в этой реплике отвечает по script. */
  say(text: string, script: LlmScript): Promise<Turn>;
  /**
   * Менеджер возвращает чат боту, как кнопка панели: returnToBot, затем ответ бота на неотвеченное (Responder.resume);
   * модель отвечает по script.
   */
  returnToBot(script: LlmScript): Promise<Turn>;
  /** Менеджер пишет клиенту с телефона: сообщение в истории и перехват чата (как pipeline/takeover.ts). */
  managerWrites(text: string): Promise<void>;
  /** Сдвигает часы сценария (например, на 13 часов простоя). */
  advance(ms: number): void;
  readonly contacts: FakeContacts;
  /** Все запросы к внутреннему API по порядку. */
  readonly api: readonly ApiCall[];
  /** Всё, что ушло в лог, до любой маскировки. */
  readonly logs: readonly LogEntry[];
  readonly storage: Storage;
  readonly company: CompanySetup;
  /** Общие службы: передача и возврат чата боту (как из панели). */
  readonly services: Services;
  readonly chatId: () => ChatId;
  /** Состояние определения компании в базе. */
  readonly state: () => ChatCompanyState;
}

function configOf(options: ScenarioOptions): AppConfig {
  const root = useTempDir().path;
  mkdirSync(join(root, 'knowledge'));
  for (const name of ['tanbala-agent.md', 'whatsapp.md']) {
    copyFileSync(join(PROJECT_ROOT, 'knowledge', name), join(root, 'knowledge', name));
  }
  const company =
    options.api === null
      ? {}
      : { INTERNAL_API_TOKEN: API_TOKEN, EMAIL_API_URL: API_URL, EMAIL_UI_URL };
  const env = {
    TEST_MODE: 'true',
    TEST_ALLOWLIST: options.allowlist ?? CLIENT_PHONE,
    MANAGER_WHATSAPP: MANAGER_PHONE,
    VENMART_ANTHROPIC_KEY: 'sk-test-not-a-real-key',
    ...company,
  };
  const config = loadConfig(env, MODELS, root).config;
  // До этапа 8 настройки закрытый режим не выключают: открытый режим собирается здесь, как его соберёт этап 8.
  return options.openMode === true
    ? { ...config, testMode: { ...config.testMode, enabled: false } }
    : config;
}

function storageOf(config: AppConfig, logger: Logger): Storage {
  const db = useMigratedDb();
  return {
    chats: createChatsRepo(db),
    messages: createMessagesRepo(db),
    outboundIds: createOutboundIdsRepo(db),
    budget: createCallBudget(db, config.limits),
    backlog: createBacklogRepo(db),
    handoffs: createHandoffsRepo(db),
    notifications: createManagerNotificationsRepo(db),
    unitOfWork: createUnitOfWork(db),
    chatCompanies: createChatCompaniesRepo(db, logger),
  };
}

function contactsOf(options: ScenarioOptions): FakeContacts {
  const profile = options.profile ?? { kind: 'personal' };
  return {
    businessProfile: vi.fn<WhatsAppContacts['businessProfile']>(() => Promise.resolve(profile)),
    profilePhoto: vi.fn<WhatsAppContacts['profilePhoto']>(() => Promise.resolve(null)),
  };
}

function identityOf(options: ScenarioOptions): ChatIdentity {
  return options.hiddenNumber === true
    ? { replyJid: CLIENT_LID, lidJid: CLIENT_LID, pnJid: null }
    : { replyJid: CLIENT_JID, lidJid: null, pnJid: CLIENT_JID };
}

/** Подключение WhatsApp: отправленное копится в sendText, остальное ничего не делает. */
function connectionOf(sendText: Mock<ResponderConnection['sendText']>): ResponderConnection {
  let sent = 0;
  return {
    newMessageId: () => `OUT-${(sent += 1)}` as WaMessageId,
    sendText,
    setTyping: () => Promise.resolve(),
    markRead: () => Promise.resolve(),
    downloadAudio: () => Promise.reject(new Error('голосовых в сценарии нет')),
  };
}

/** Итог пачки из записи конвейера в лог (logOutcome): вид итога и причина. */
function outcomeOf(logs: readonly LogEntry[]): PipelineOutcome | null {
  const entry = logs.findLast((log) => typeof log.context['outcome'] === 'string');
  if (entry === undefined) return null;
  const { outcome, reason } = entry.context;
  return (reason === undefined ? { kind: outcome } : { kind: outcome, reason }) as PipelineOutcome;
}

/** Блок <данные> последней реплики user: выжимка, данные о компании, черновик на проверку. */
export function dataOf(request: RecordedRequest | undefined): string {
  const text = request?.turns.at(-1)?.text ?? '';
  return /<данные>\n([\s\S]*)\n<\/данные>$/u.exec(text)?.[1] ?? '';
}

/** Мутабельные часы сценария: сон «печатает» и склейки не ждёт. */
function clockOf(): Clock & { advance(ms: number): void } {
  let nowMs = START_MS;
  return {
    now: () => nowMs,
    sleep: () => Promise.resolve(),
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

/** Приложение сценария: всё, что в main.ts живёт от запуска до остановки. */
interface Rig {
  readonly config: AppConfig;
  readonly clock: ReturnType<typeof clockOf>;
  readonly logger: Logger;
  readonly logs: LogEntry[];
  readonly apiCalls: ApiCall[];
  readonly storage: Storage;
  readonly services: Services;
  readonly company: CompanySetup;
  readonly contacts: FakeContacts;
  readonly sendText: Mock<ResponderConnection['sendText']>;
  readonly link: ResponderConnection;
}

/** Сборка как в main.ts: определение компании, общие службы, затем подключение WhatsApp. */
function rigOf(options: ScenarioOptions): Rig {
  const logs: LogEntry[] = [];
  const apiCalls: ApiCall[] = [];
  const logger = createFakeLogger(logs);
  const config = configOf(options);
  const clock = clockOf();
  const storage = storageOf(config, logger);
  const company = assembleCompany({
    config,
    logger,
    clock,
    repo: storage.chatCompanies,
    fetch: fakeFetch(options.api ?? {}, apiCalls),
  });
  const services = assembleServices({ config, logger, clock, storage, company: company.service });
  onTestFinished(() => services.stop());
  const contacts = contactsOf(options);
  const sendText = vi.fn<ResponderConnection['sendText']>(() => Promise.resolve());
  const link = connectionOf(sendText);
  services.connect(link);
  company.connect(contacts);
  return {
    config,
    clock,
    logger,
    logs,
    apiCalls,
    storage,
    services,
    company,
    contacts,
    sendText,
    link,
  };
}

/** Ответы клиентам на модели этой реплики: собираются заново, база и службы общие (как после перезапуска). */
async function responderOf(rig: Rig, llm: ScriptedLlm) {
  const responder = await assembleResponder({
    config: rig.config,
    logger: rig.logger,
    clock: rig.clock,
    storage: rig.storage,
    services: rig.services,
    company: rig.company.service,
    createLlm: () => llm.llm,
  });
  if (responder === null) throw new Error('ответы не собраны');
  rig.company.useLogo(responder.logo);
  responder.connect(rig.link);
  return responder;
}

/** Реплика клиента целиком: сообщение в базе (как после recorder.ts), очередь склейки, конвейер до конца. */
async function handleText(
  rig: Rig,
  message: InboundMessage,
  text: string,
  llm: ScriptedLlm,
): Promise<ChatId> {
  const responder = await responderOf(rig, llm);
  const { chats, messages } = rig.storage;
  const chat = chats.upsertByIdentity(message.identity, message.pushName, message.tsMs);
  const { waId, tsMs } = message;
  messages.insertIfNew({ chatId: chat.id, waId, author: 'client', kind: 'text', text, tsMs });
  responder.batcher.push(chat.id, message);
  await responder.batcher.drain();
  return chat.id;
}

/** Где начинается реплика в общих журналах: отправленное, запросы к API и лог. */
interface Mark {
  readonly sent: number;
  readonly api: number;
  readonly logs: number;
}

/** Что произошло за реплику: всё после отметки mark. */
function turnOf(rig: Rig, mark: Mark, atMs: number, llm: ScriptedLlm, client: Jid): Turn {
  const sent = rig.sendText.mock.calls.slice(mark.sent);
  const sentTo = (jid: Jid): string[] => sent.filter(([to]) => to === jid).map(([, body]) => body);
  return {
    atMs,
    outcome: outcomeOf(rig.logs.slice(mark.logs)),
    llm,
    toClient: sentTo(client),
    toManager: sentTo(MANAGER_JID),
    api: rig.apiCalls.slice(mark.api),
    data: (purpose) => dataOf(llm.requests.find((request) => request.purpose === purpose)),
  };
}

export function createScenario(options: ScenarioOptions = {}): Scenario {
  const rig = rigOf(options);
  const identity = identityOf(options);
  let chatId: ChatId | null = null;
  let count = 0;

  const say = async (text: string, script: LlmScript): Promise<Turn> => {
    const mark = {
      sent: rig.sendText.mock.calls.length,
      api: rig.apiCalls.length,
      logs: rig.logs.length,
    };
    const atMs = rig.clock.now();
    count += 1;
    const message: InboundMessage = {
      waId: `WA-${count}` as WaMessageId,
      identity,
      pushName: options.pushName ?? null,
      ...(options.verifiedName === undefined ? {} : { verifiedName: options.verifiedName }),
      content: { kind: 'text', text },
      tsMs: atMs,
    };
    const llm = scriptedLlm(script);
    chatId = await handleText(rig, message, text, llm);
    rig.clock.advance(TURN_GAP_MS);
    return turnOf(rig, mark, atMs, llm, identity.replyJid);
  };

  const currentChatId = (): ChatId => {
    if (chatId === null) throw new Error('Клиент ещё не писал: чата нет');
    return chatId;
  };

  const returnToBot = async (script: LlmScript): Promise<Turn> => {
    const mark = {
      sent: rig.sendText.mock.calls.length,
      api: rig.apiCalls.length,
      logs: rig.logs.length,
    };
    const atMs = rig.clock.now();
    const llm = scriptedLlm(script);
    const responder = await responderOf(rig, llm);
    await rig.services.handoff.returnToBot(currentChatId());
    responder.resume(currentChatId());
    await responder.batcher.drain();
    rig.clock.advance(TURN_GAP_MS);
    return turnOf(rig, mark, atMs, llm, identity.replyJid);
  };

  const managerWrites = async (text: string): Promise<void> => {
    count += 1;
    rig.storage.messages.insertIfNew({
      chatId: currentChatId(),
      waId: `PHONE-${count}` as WaMessageId,
      author: 'human_phone',
      kind: 'text',
      text,
      tsMs: rig.clock.now(),
    });
    await rig.services.handoff.handOff(currentChatId(), { reason: 'human_took_over', by: 'phone' });
    rig.clock.advance(TURN_GAP_MS);
  };

  return {
    say,
    returnToBot,
    managerWrites,
    advance: (ms) => {
      rig.clock.advance(ms);
    },
    contacts: rig.contacts,
    api: rig.apiCalls,
    logs: rig.logs,
    storage: rig.storage,
    company: rig.company,
    services: rig.services,
    chatId: currentChatId,
    state: () => rig.storage.chatCompanies.get(currentChatId()),
  };
}
