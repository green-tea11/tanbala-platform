import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createAgent, type Agent } from '../agent/agent.js';
import { loadKnowledge, type Knowledge } from '../agent/knowledge.js';
import type { AppConfig } from '../config/env.js';
import type {
  CallBudget,
  ChatsRepo,
  Clock,
  LlmClient,
  Logger,
  MessageSender,
  MessagesRepo,
  OutboundIdsRepo,
  Transcriber,
  WhatsAppInbox,
} from '../domain/ports.js';
import type { PhoneDigits } from '../domain/types.js';
import { createAnthropicLlm, type AnthropicLlmDeps } from '../llm/anthropic.js';
import { createJsonlTokenLog } from '../llm/token-log.js';
import { createOutbox } from '../messaging/outbox.js';
import { typingDelayMs } from '../messaging/typing.js';
import { createDisabledTranscriber, createOpenRouterTranscriber } from '../voice/transcriber.js';
import { phoneToJid } from '../whatsapp/jid.js';
import { createChatBatcher, type ChatBatcher } from './batcher.js';
import { handleClientBatch, type PipelineDeps } from './handle-inbound.js';

/** Склейка сообщений чата: тишина после последнего сообщения и предел от первого (pipeline/batcher.ts). */
export const BATCH_DEBOUNCE_MS = 4000;
export const BATCH_MAX_WAIT_MS = 15_000;

/** Без ключа Claude бот работает как на этапе 2: принимает и сохраняет, но не отвечает. */
export const NO_CLAUDE_KEY_WARNING =
  'Ключ Claude не задан (VENMART_ANTHROPIC_KEY): бот только принимает и сохраняет сообщения, ответов нет';

/** Файлы знаний в папке knowledge/: документ владельца и правила WhatsApp. */
const KNOWLEDGE_FILES = { owner: 'tanbala-agent.md', whatsapp: 'whatsapp.md' } as const;

/** Подключение WhatsApp для конвейера: отправка (через outbox), «печатает», прочтение и голосовые. */
export type ResponderConnection = MessageSender & Pick<WhatsAppInbox, 'markRead' | 'downloadAudio'>;

/** Что ответам нужно от базы. */
export interface ResponderStorage {
  readonly chats: ChatsRepo;
  readonly messages: MessagesRepo;
  readonly outboundIds: OutboundIdsRepo;
  /** Дневной предохранитель расходов API (API_DAILY_LIMIT и API_DAILY_LIMIT_PER_CHAT). */
  readonly budget: CallBudget;
}

/** Из чего собираются ответы клиентам. */
export interface ResponderContext {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly storage: ResponderStorage;
  /** Шов для тестов, в рабочем режиме не передаётся: клиент LLM (по умолчанию createAnthropicLlm). */
  readonly createLlm?: ((deps: AnthropicLlmDeps) => LlmClient) | undefined;
}

/** Ответы клиентам: очередь склейки есть до WhatsApp, конвейер получает подключение после запуска. */
export interface Responder {
  readonly batcher: ChatBatcher;
  /** WhatsApp подключён: outbox, «печатает», прочтение и голосовые идут через это подключение. */
  connect(connection: ResponderConnection): void;
}

/** Части конвейера, которым не нужно подключение WhatsApp. */
interface ResponderServices {
  readonly agent: Agent;
  readonly transcriber: Transcriber;
}

/**
 * Собирает ответы клиентам (этап 3), только если задан ключ Claude; без ключа null и предупреждение: бот только
 * принимает и сохраняет, как на этапе 2. Знания (knowledge/, при сбое чтения понятная ошибка при старте), лог
 * расхода TOKEN_LOG_PATH, LLM с дневным предохранителем, агент, расшифровка голосовых по AppConfig.voice (нет ключа
 * OpenRouter => выключена) и очередь склейки. Outbox (список закрытого режима, номер менеджера) и конвейер
 * pipeline/handle-inbound.ts собираются на подключении WhatsApp (connect); пачка до подключения не обрабатывается:
 * ошибка в лог очереди.
 */
export async function assembleResponder(context: ResponderContext): Promise<Responder | null> {
  const { config, logger, clock } = context;
  if (config.anthropicKey === null) {
    logger.warn({}, NO_CLAUDE_KEY_WARNING);
    return null;
  }
  const knowledge = await loadKnowledge(knowledgePaths(config.knowledgeDir), (path) =>
    readFile(path, 'utf8'),
  );
  const services = responderServices(context, config.anthropicKey, knowledge);
  const voice = config.voice !== null;
  logger.info(
    { voice },
    `Ответы клиентам включены: Claude, расшифровка голосовых ${voice ? 'включена' : 'выключена'}`,
  );
  let pipeline: PipelineDeps | null = null;
  const batcher = createChatBatcher({
    clock,
    debounceMs: BATCH_DEBOUNCE_MS,
    maxWaitMs: BATCH_MAX_WAIT_MS,
    logger,
    onBatch: async (batch) => {
      const current = pipeline;
      if (current === null) throw new Error('WhatsApp не подключён: пачка без ответа');
      await handleClientBatch(current, batch);
    },
  });
  return {
    batcher,
    connect: (connection) => {
      pipeline = pipelineDeps(context, services, connection);
    },
  };
}

/** Лог расхода, LLM (Claude), агент и расшифровка: всё, что не зависит от подключения WhatsApp. */
function responderServices(
  context: ResponderContext,
  apiKey: string,
  knowledge: Knowledge,
): ResponderServices {
  const { config, logger, clock, storage } = context;
  const tokenLog = createJsonlTokenLog(config.tokenLogPath, appendLine, clock);
  const api = { budget: storage.budget, clock, tokenLog, logger };
  const llm = (context.createLlm ?? createAnthropicLlm)({ apiKey, ...api });
  return {
    agent: createAgent({ llm, knowledge, models: config.models }),
    transcriber: transcriberOf(config, api),
  };
}

/** Конвейер на подключении WhatsApp: outbox пишет через него, оттуда же «печатает», прочтение и голосовые. */
function pipelineDeps(
  context: ResponderContext,
  services: ResponderServices,
  connection: ResponderConnection,
): PipelineDeps {
  const { config, logger, clock, storage } = context;
  const testAllowlist = allowlistOf(config);
  const outbox = createOutbox({
    sender: connection,
    chats: storage.chats,
    messages: storage.messages,
    outboundIds: storage.outboundIds,
    clock,
    managerJid: config.managerPhone === null ? null : phoneToJid(config.managerPhone),
    testAllowlist,
    random: Math.random,
  });
  return {
    chats: storage.chats,
    messages: storage.messages,
    agent: services.agent,
    outbox,
    transcriber: services.transcriber,
    inbox: connection,
    typing: connection,
    typingDelayMs: (text) => typingDelayMs(text, Math.random),
    testAllowlist,
    clock,
    logger,
  };
}

/** Расшифровка голосовых: только при ключе OpenRouter (AppConfig.voice), иначе на голосовое отвечает фраза. */
function transcriberOf(
  config: AppConfig,
  api: Pick<AnthropicLlmDeps, 'budget' | 'clock' | 'tokenLog' | 'logger'>,
): Transcriber {
  if (config.voice === null) return createDisabledTranscriber();
  const { apiKey, model } = config.voice;
  return createOpenRouterTranscriber({ apiKey, model, fetchFn: fetch, ...api });
}

function allowlistOf(config: AppConfig): ReadonlySet<PhoneDigits> | null {
  return config.testMode.enabled ? config.testMode.allowlist : null;
}

function knowledgePaths(dir: string): { readonly owner: string; readonly whatsapp: string } {
  return { owner: join(dir, KNOWLEDGE_FILES.owner), whatsapp: join(dir, KNOWLEDGE_FILES.whatsapp) };
}

/** Строка лога расхода (уже с переводом строки) в конец файла; папка создаётся при первой записи. */
async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line, 'utf8');
}
