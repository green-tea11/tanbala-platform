import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { loadConfig, type AppConfig } from '../../../src/config/env.js';
import { createCallBudget } from '../../../src/db/repos/call-budget.js';
import { createChatsRepo } from '../../../src/db/repos/chats.js';
import { createMessagesRepo } from '../../../src/db/repos/messages.js';
import { createOutboundIdsRepo } from '../../../src/db/repos/outbound-ids.js';
import type { Clock, LlmClient, Logger } from '../../../src/domain/ports.js';
import type { InboundMessage, Jid, WaMessageId } from '../../../src/domain/types.js';
import {
  assembleResponder,
  NO_CLAUDE_KEY_WARNING,
  type ResponderConnection,
  type ResponderStorage,
} from '../../../src/pipeline/responder-setup.js';
import { ROOT as PROJECT_ROOT } from '../../helpers/source-files.js';
import { useMigratedDb, useTempDir } from '../db/fixture.js';

// Настоящие репозитории на SQLite в памяти, LLM поддельный, подключение WhatsApp поддельное: сети нет.

const PHONE = '77000000002';
const JID = `${PHONE}@s.whatsapp.net` as Jid;
const REPLY = 'Расскажите, пожалуйста, что вы храните?';
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
  const base = { TEST_MODE: 'true', TEST_ALLOWLIST: PHONE };
  return loadConfig({ ...base, ...env }, MODELS, root).config;
}

/** LLM отвечает answer в форме схемы агента. */
const ANSWERING_LLM: LlmClient = {
  structured: (request) =>
    Promise.resolve({
      ok: true,
      value: request.schema.parse({ outcome: 'answer', text: REPLY, stopRequested: false }),
    }),
};

function storageOf(config: AppConfig): ResponderStorage {
  const db = useMigratedDb();
  return {
    chats: createChatsRepo(db),
    messages: createMessagesRepo(db),
    outboundIds: createOutboundIdsRepo(db),
    budget: createCallBudget(db, config.limits),
  };
}

/** Входящее клиента, уже записанное в базу, как это делает pipeline/recorder.ts. */
function recorded(storage: ResponderStorage, waId: string): InboundMessage {
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
  const link: ResponderConnection = {
    newMessageId: () => 'OUT-1' as WaMessageId,
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

    const responder = await assembleResponder({
      config,
      logger: createLogger(entries),
      clock: CLOCK,
      storage: storageOf(config),
    });

    expect(responder).toBeNull();
    expect(entries).toEqual([{ level: 'warn', context: {}, message: NO_CLAUDE_KEY_WARNING }]);
  });

  it('пачка до подключения WhatsApp не обрабатывается; после connect ответ уходит через подключение', async () => {
    const entries: LogEntry[] = [];
    const config = configWith({ VENMART_ANTHROPIC_KEY: 'sk-test-not-a-real-key' });
    const storage = storageOf(config);
    const responder = await assembleResponder({
      config,
      logger: createLogger(entries),
      clock: CLOCK,
      storage,
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
    responder.connect(link);
    responder.batcher.push(chat.id, recorded(storage, 'WA-2'));
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
    await responder.batcher.drain();

    expect(sendText).toHaveBeenCalledWith(JID, REPLY, 'OUT-1');
    expect(entries).toContainEqual(
      expect.objectContaining({ level: 'info', context: { voice: false } }),
    );
  });

  it('ключ OpenRouter задан: расшифровка голосовых включена', async () => {
    const entries: LogEntry[] = [];
    const config = configWith({
      VENMART_ANTHROPIC_KEY: 'sk-test-not-a-real-key',
      OPENROUTER_API_KEY: 'or-test-not-a-real-key',
      MANAGER_WHATSAPP: '77000000009',
    });
    const storage = storageOf(config);

    const responder = await assembleResponder({
      config,
      logger: createLogger(entries),
      clock: CLOCK,
      storage,
      createLlm: () => ANSWERING_LLM,
    });
    responder?.connect(connection().link);

    expect(entries).toContainEqual(
      expect.objectContaining({ level: 'info', context: { voice: true } }),
    );
  });
});
