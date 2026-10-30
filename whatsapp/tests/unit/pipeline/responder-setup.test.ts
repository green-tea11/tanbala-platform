import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { loadConfig, type AppConfig } from '../../../src/config/env.js';
import { createUnitOfWork } from '../../../src/db/connection.js';
import { createBacklogRepo } from '../../../src/db/repos/backlog.js';
import { createCallBudget } from '../../../src/db/repos/call-budget.js';
import { createChatsRepo } from '../../../src/db/repos/chats.js';
import { createHandoffsRepo } from '../../../src/db/repos/handoffs.js';
import { createManagerNotificationsRepo } from '../../../src/db/repos/manager-notifications.js';
import { createMessagesRepo } from '../../../src/db/repos/messages.js';
import { createOutboundIdsRepo } from '../../../src/db/repos/outbound-ids.js';
import { createRejectedDraftsRepo } from '../../../src/db/repos/rejected-drafts.js';
import type { CompanyService, CompanySummary, CompanyTurn } from '../../../src/domain/company.js';
import type { Clock, ImageInput, LlmClient, Logger } from '../../../src/domain/ports.js';
import type { ChatId, InboundMessage, Jid, WaMessageId } from '../../../src/domain/types.js';
import {
  assembleResponder,
  NO_CLAUDE_KEY_WARNING,
  type ResponderConnection,
  type ResponderStorage,
} from '../../../src/pipeline/responder-setup.js';
import {
  assembleServices,
  type Services,
  type ServicesStorage,
} from '../../../src/pipeline/services.js';
import { ROOT as PROJECT_ROOT } from '../../helpers/source-files.js';
import { useMigratedDb, useTempDir } from '../db/fixture.js';
import { scriptedLlm } from './scripted-llm.js';

// Настоящие репозитории на SQLite в памяти, LLM поддельный, подключение WhatsApp поддельное: сети нет.

const PHONE = '77000000002';
const JID = `${PHONE}@s.whatsapp.net` as Jid;
const MANAGER_PHONE = '77000000009';
const MANAGER_JID = `${MANAGER_PHONE}@s.whatsapp.net` as Jid;
const REPLY = 'Расскажите, пожалуйста, что вы храните?';
/** Сообщение передачи от модели: ответ из знаний и одна фраза о передаче, без времени. */
const HOT_REPLY =
  'Да, мы проводим интеграцию с вашей 1С. Стоимость зависит от вашей задачи, уточню у коллеги и вернусь к вам.';
const MODELS: unknown = JSON.parse(
  readFileSync(join(PROJECT_ROOT, 'config', 'models.json'), 'utf8'),
);
/** Паузы склейки и «печатает» мгновенные, время настоящее. */
const CLOCK: Clock = { now: () => Date.now(), sleep: () => Promise.resolve() };

interface LogEntry {
  readonly level: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly message: string | undefined;
}

function createLogger(entries: LogEntry[]): Logger {
  const log =
    (level: string) =>
    (context: Readonly<Record<string, unknown>>, message?: string): void => {
      entries.push({ level, context, message });
    };
  const logger: Logger = {
    level: 'info',
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    fatal: log('fatal'),
    silent: log('silent'),
    child: () => logger,
  };
  return logger;
}

/** Настройки во временном корне со знаниями; ключи вымышленные. */
function configWith(env: Readonly<Record<string, string>>): AppConfig {
  const root = useTempDir().path;
  mkdirSync(join(root, 'knowledge'));
  writeFileSync(join(root, 'knowledge', 'tanbala-agent.md'), 'Учёт вещей на RFID-метках.');
  writeFileSync(join(root, 'knowledge', 'whatsapp.md'), 'Отвечай коротко.');
  writeFileSync(join(root, 'knowledge', 'consult.md'), 'Сначала боль, потом плюс.');
  const base = { TEST_MODE: 'true', TEST_ALLOWLIST: PHONE };
  return loadConfig({ ...base, ...env }, MODELS, root).config;
}

/** LLM отвечает по назначению вызова в форме схем агента: черновик answer, проверка пройдена, клиент холодный. */
const ANSWERING_LLM: LlmClient = scriptedLlm({ replies: [REPLY] }).llm;

/** Определение компании выключено: так сервис отвечает без INTERNAL_API_TOKEN. */
const OFF_TURN: CompanyTurn = { prompt: { kind: 'off' }, awaitingAnswer: false };

const OFF_SUMMARY: CompanySummary = {
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

/** Поддельный сервис компании: выключен (блок off), вызовы видны тесту. */
type CompanyFake = { readonly [K in keyof CompanyService]: Mock<CompanyService[K]> };

function companyOff(): CompanyFake {
  return {
    prepare: vi.fn<CompanyService['prepare']>(() => Promise.resolve(OFF_TURN)),
    applyAssessment: vi.fn<CompanyService['applyAssessment']>(() =>
      Promise.resolve(OFF_TURN.prompt),
    ),
    markAsked: vi.fn<CompanyService['markAsked']>(),
    stopAwaiting: vi.fn<CompanyService['stopAwaiting']>(),
    identifyAfterReply: vi.fn<CompanyService['identifyAfterReply']>(() => Promise.resolve()),
    summary: vi.fn<CompanyService['summary']>(() => OFF_SUMMARY),
  };
}

/** Всё хранилище на одной базе в памяти: для ответов и для общих служб этапа 5. */
type Storage = ResponderStorage & ServicesStorage;

function storageOf(config: AppConfig): Storage {
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
    rejectedDrafts: createRejectedDraftsRepo(db),
  };
}

/** Общие службы на том же хранилище; отправляют они через подключение, которое тест передаёт в connect. */
function servicesOf(
  config: AppConfig,
  storage: Storage,
  logger: Logger,
  company: CompanyFake = companyOff(),
): Services {
  return assembleServices({ config, logger, clock: CLOCK, storage, company });
}

/** Входящее клиента, уже записанное в базу, как это делает pipeline/recorder.ts. */
function recorded(storage: Storage, waId: string): InboundMessage {
  const message: InboundMessage = {
    waId: waId as WaMessageId,
    identity: { replyJid: JID, lidJid: null, pnJid: JID },
    pushName: null,
    content: { kind: 'text', text: 'Здравствуйте' },
    tsMs: Date.now(),
  };
  const chat = storage.chats.upsertByIdentity(message.identity, null, message.tsMs);
  storage.messages.insertIfNew({
    chatId: chat.id,
    waId: message.waId,
    author: 'client',
    kind: 'text',
    text: 'Здравствуйте',
    tsMs: message.tsMs,
  });
  return message;
}

/** Поддельное подключение WhatsApp; sendText отдельно: по нему видно, что ответ ушёл. */
function connection(): {
  readonly link: ResponderConnection;
  readonly sendText: Mock<ResponderConnection['sendText']>;
} {
  const sendText = vi.fn<ResponderConnection['sendText']>(() => Promise.resolve());
  let sent = 0;
  const link: ResponderConnection = {
    newMessageId: () => `OUT-${(sent += 1)}` as WaMessageId,
    sendText,
    setTyping: () => Promise.resolve(),
    markRead: () => Promise.resolve(),
    downloadAudio: () => Promise.reject(new Error('голосовых в тесте нет')),
  };
  return { link, sendText };
}

describe('pipeline/responder-setup', () => {
  it('без ключа Claude: ответов нет, предупреждение в лог', async () => {
    const entries: LogEntry[] = [];
    const config = configWith({});
    const logger = createLogger(entries);
    const storage = storageOf(config);

    const responder = await assembleResponder({
      config,
      logger,
      clock: CLOCK,
      storage,
      services: servicesOf(config, storage, logger),
      company: companyOff(),
    });

    expect(responder).toBeNull();
    expect(entries).toEqual([{ level: 'warn', context: {}, message: NO_CLAUDE_KEY_WARNING }]);
  });

  it('пачка до подключения WhatsApp не обрабатывается; после connect ответ уходит через подключение', async () => {
    const entries: LogEntry[] = [];
    const config = configWith({ VENMART_ANTHROPIC_KEY: 'sk-test-not-a-real-key' });
    const logger = createLogger(entries);
    const storage = storageOf(config);
    const services = servicesOf(config, storage, logger);
    const responder = await assembleResponder({
      config,
      logger,
      clock: CLOCK,
      storage,
      services,
      company: companyOff(),
      createLlm: () => ANSWERING_LLM,
    });
    if (responder === null) throw new Error('ответы не собраны');
    const first = recorded(storage, 'WA-1');
    const chat = storage.chats.findByJid(JID);
    if (chat === null) throw new Error('чат не записан');

    responder.batcher.push(chat.id, first);
    await vi.waitFor(() =>
      expect(entries).toContainEqual(expect.objectContaining({ level: 'error' })),
    );
    const { link, sendText } = connection();
    services.connect(link);
    responder.connect(link);
    responder.batcher.push(chat.id, recorded(storage, 'WA-2'));
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
    await responder.batcher.drain();

    expect(sendText).toHaveBeenCalledWith(JID, REPLY, 'OUT-1');
    expect(entries).toContainEqual(
      expect.objectContaining({ level: 'info', context: { voice: false } }),
    );
  });

  it('возврат боту: resume отдаёт неотвеченное в очередь, бот отвечает один раз; повтор ничего не добавляет', async () => {
    const config = configWith({ VENMART_ANTHROPIC_KEY: 'sk-test-not-a-real-key' });
    const logger = createLogger([]);
    const storage = storageOf(config);
    const services = servicesOf(config, storage, logger);
    const responder = await assembleResponder({
      config,
      logger,
      clock: CLOCK,
      storage,
      services,
      company: companyOff(),
      createLlm: () => ANSWERING_LLM,
    });
    if (responder === null) throw new Error('ответы не собраны');
    const { link, sendText } = connection();
    services.connect(link);
    responder.connect(link);
    recorded(storage, 'WA-1');
    const chat = storage.chats.findByJid(JID);
    if (chat === null) throw new Error('чат не записан');

    expect(responder.resume(chat.id)).toBe(1);
    expect(responder.resume(chat.id)).toBe(1);
    await responder.batcher.drain();

    expect(sendText.mock.calls).toEqual([[JID, REPLY, 'OUT-1']]);
    // Ответ ушёл: после него отвечать не на что.
    expect(responder.resume(chat.id)).toBe(0);
  });

  it('рабочий режим: возврат боту не берёт сообщения чата не из TEST_ALLOWLIST, отправленные до перехода', async () => {
    const config = configWith({ VENMART_ANTHROPIC_KEY: 'sk-test-not-a-real-key' });
    const logger = createLogger([]);
    const storage = storageOf(config);
    recorded(storage, 'WA-1');
    const chat = storage.chats.findByJid(JID);
    if (chat === null) throw new Error('чат не записан');
    const responder = await assembleResponder({
      config,
      logger,
      clock: CLOCK,
      storage,
      services: servicesOf(config, storage, logger),
      company: companyOff(),
      createLlm: () => ANSWERING_LLM,
      workingMode: { sinceMs: Date.now() + 60_000, allowlist: new Set() },
    });
    if (responder === null) throw new Error('ответы не собраны');

    expect(responder.resume(chat.id)).toBe(0);
  });

  it('горячий клиент по решению вызова ответа: сообщение модели через подключение, передача и уведомление в базе (номера менеджера нет)', async () => {
    const config = configWith({ VENMART_ANTHROPIC_KEY: 'sk-test-not-a-real-key' });
    const logger = createLogger([]);
    const storage = storageOf(config);
    const services = servicesOf(config, storage, logger);
    const llm = scriptedLlm({ replies: [{ outcome: 'hot', text: HOT_REPLY }] });
    const responder = await assembleResponder({
      config,
      logger,
      clock: CLOCK,
      storage,
      services,
      company: companyOff(),
      createLlm: () => llm.llm,
    });
    if (responder === null) throw new Error('ответы не собраны');
    const { link, sendText } = connection();
    services.connect(link);
    responder.connect(link);
    const message = recorded(storage, 'WA-1');
    const chat = storage.chats.findByJid(JID);
    if (chat === null) throw new Error('чат не записан');

    responder.batcher.push(chat.id, message);
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
    await responder.batcher.drain();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(JID, HOT_REPLY, 'OUT-1');
    expect(llm.purposes()).toEqual(['reply', 'interest', 'review']);
    expect(storage.chats.getById(chat.id)?.control).toEqual({ status: 'manager', by: 'bot' });
    expect(storage.chats.getById(chat.id)?.level).toBe('hot');
    expect(storage.handoffs.findOpen(chat.id)).toMatchObject({ reason: 'hot', level: 'hot' });
    expect(storage.notifications.latestForChat(chat.id)).toMatchObject({
      kind: 'handoff',
      status: 'no_manager',
    });
  });

  it('горячий клиент и номер менеджера задан: уведомление уходит менеджеру до сообщения клиенту', async () => {
    const config = configWith({
      VENMART_ANTHROPIC_KEY: 'sk-test-not-a-real-key',
      MANAGER_WHATSAPP: MANAGER_PHONE,
    });
    const logger = createLogger([]);
    const storage = storageOf(config);
    const services = servicesOf(config, storage, logger);
    const responder = await assembleResponder({
      config,
      logger,
      clock: CLOCK,
      storage,
      services,
      company: companyOff(),
      createLlm: () => scriptedLlm({ replies: [{ outcome: 'hot', text: HOT_REPLY }] }).llm,
    });
    if (responder === null) throw new Error('ответы не собраны');
    const { link, sendText } = connection();
    services.connect(link);
    responder.connect(link);
    const message = recorded(storage, 'WA-1');
    const chat = storage.chats.findByJid(JID);
    if (chat === null) throw new Error('чат не записан');

    responder.batcher.push(chat.id, message);
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(2));
    await responder.batcher.drain();

    expect(sendText.mock.calls.map(([jid, text, waId]) => [jid, text === HOT_REPLY, waId])).toEqual(
      [
        [MANAGER_JID, false, 'OUT-1'],
        [JID, true, 'OUT-2'],
      ],
    );
    expect(storage.notifications.latestForChat(chat.id)).toMatchObject({
      status: 'sent',
      attempts: 1,
    });
  });

  it('ключ OpenRouter задан: расшифровка голосовых включена', async () => {
    const entries: LogEntry[] = [];
    const config = configWith({
      VENMART_ANTHROPIC_KEY: 'sk-test-not-a-real-key',
      OPENROUTER_API_KEY: 'or-test-not-a-real-key',
      MANAGER_WHATSAPP: MANAGER_PHONE,
    });
    const logger = createLogger(entries);
    const storage = storageOf(config);

    const responder = await assembleResponder({
      config,
      logger,
      clock: CLOCK,
      storage,
      services: servicesOf(config, storage, logger),
      company: companyOff(),
      createLlm: () => ANSWERING_LLM,
    });
    responder?.connect(connection().link);

    expect(entries).toContainEqual(
      expect.objectContaining({ level: 'info', context: { voice: true } }),
    );
  });

  it('конвейер ходит в сервис компании из context.company: блок перед ответом, поиск после него', async () => {
    const config = configWith({ VENMART_ANTHROPIC_KEY: 'sk-test-not-a-real-key' });
    const logger = createLogger([]);
    const storage = storageOf(config);
    const company = companyOff();
    const services = servicesOf(config, storage, logger, company);
    const responder = await assembleResponder({
      config,
      logger,
      clock: CLOCK,
      storage,
      services,
      company,
      createLlm: () => ANSWERING_LLM,
    });
    if (responder === null) throw new Error('ответы не собраны');
    const { link, sendText } = connection();
    services.connect(link);
    responder.connect(link);
    const message = recorded(storage, 'WA-1');
    const chat = storage.chats.findByJid(JID);
    if (chat === null) throw new Error('чат не записан');

    responder.batcher.push(chat.id, message);
    await vi.waitFor(() => expect(company.identifyAfterReply).toHaveBeenCalledTimes(1));
    await responder.batcher.drain();

    expect(sendText).toHaveBeenCalledWith(JID, REPLY, 'OUT-1');
    expect(company.prepare).toHaveBeenCalledWith(expect.objectContaining({ id: chat.id }), [
      message,
    ]);
    expect(company.markAsked).toHaveBeenCalledWith(chat.id, 'none', REPLY);
  });

  it('агент наружу как logo: название с логотипа читает модель logo', async () => {
    const config = configWith({ VENMART_ANTHROPIC_KEY: 'sk-test-not-a-real-key' });
    const logger = createLogger([]);
    const storage = storageOf(config);
    const llm = scriptedLlm({ replies: [REPLY] });
    const responder = await assembleResponder({
      config,
      logger,
      clock: CLOCK,
      storage,
      services: servicesOf(config, storage, logger),
      company: companyOff(),
      createLlm: () => llm.llm,
    });
    const photo: ImageInput = { data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' };

    const read = await responder?.logo.readLogo(3 as ChatId, photo);

    expect(read).toEqual({ ok: true, value: null });
    expect(llm.purposes()).toEqual(['logo']);
    expect(llm.requests[0]?.chatId).toBe(3);
  });
});
