import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createAgent, type Agent } from '../agent/agent.js';
import { loadKnowledge, type Knowledge, type KnowledgePaths } from '../agent/knowledge.js';
import type { AppConfig } from '../config/env.js';
import type { LogoReader } from '../domain/company.js';
import type {
  CallBudget,
  ChatsRepo,
  Clock,
  LlmClient,
  Logger,
  MessageSender,
  MessagesRepo,
  RejectedDraftsRepo,
  Transcriber,
  WhatsAppInbox,
} from '../domain/ports.js';
import type { ChatId, PhoneDigits, WorkingMode } from '../domain/types.js';
import { createAnthropicLlm, type AnthropicLlmDeps } from '../llm/anthropic.js';
import { createJsonlTokenLog } from '../llm/token-log.js';
import { typingDelayMs } from '../messaging/typing.js';
import { createDisabledTranscriber, createOpenRouterTranscriber } from '../voice/transcriber.js';
import { createChatBatcher, type ChatBatcher } from './batcher.js';
import { handleClientBatch, type PipelineDeps } from './handle-inbound.js';
import { resumeAfterReturn, type ResumeDeps } from './resume.js';
import type { Services } from './services.js';
import { resumeFloorMs } from './working-mode.js';

/** Склейка сообщений чата: тишина после последнего сообщения и предел от первого (pipeline/batcher.ts). */
export const BATCH_DEBOUNCE_MS = 4000;
export const BATCH_MAX_WAIT_MS = 15_000;

/** Без ключа Claude бот работает как на этапе 2: принимает и сохраняет, но не отвечает. */
export const NO_CLAUDE_KEY_WARNING =
  'Ключ Claude не задан (VENMART_ANTHROPIC_KEY): бот только принимает и сохраняет сообщения, ответов нет';

const HOUR_MS = 60 * 60 * 1000;

/** Файлы знаний в папке knowledge/: документ владельца, правила WhatsApp и как вести разговор. */
const KNOWLEDGE_FILES = {
  owner: 'tanbala-agent.md',
  whatsapp: 'whatsapp.md',
  consult: 'consult.md',
} as const;

/** Подключение WhatsApp для конвейера: «печатает», прочтение и голосовые (отправку ведёт общий outbox). */
export type ResponderConnection = MessageSender & Pick<WhatsAppInbox, 'markRead' | 'downloadAudio'>;

/** Что ответам нужно от базы. */
export interface ResponderStorage {
  readonly chats: ChatsRepo;
  readonly messages: MessagesRepo;
  /** Дневной предохранитель расходов API (API_DAILY_LIMIT и API_DAILY_LIMIT_PER_CHAT). */
  readonly budget: CallBudget;
  /** Отклонённые черновики и замечания проверок для панели (пункт 7 задания 29.10.2026). */
  readonly rejectedDrafts: Pick<RejectedDraftsRepo, 'add'>;
}

/** Из чего собираются ответы клиентам. */
export interface ResponderContext {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly storage: ResponderStorage;
  /** Общие службы этапа 5 (pipeline/services.ts): отправка и передача менеджеру одни на всё приложение. */
  readonly services: Pick<Services, 'outbox' | 'handoff'>;
  /** Сервис компании (pipeline/company-setup.ts), один на приложение: конвейер берёт из него блок о компании. */
  readonly company: PipelineDeps['company'];
  /** Шов для тестов, в рабочем режиме не передаётся: клиент LLM (по умолчанию createAnthropicLlm). */
  readonly createLlm?: ((deps: AnthropicLlmDeps) => LlmClient) | undefined;
  /**
   * Рабочий режим (этап 8) с границей перехода: возврат боту не отвечает на сообщения чата не из TEST_ALLOWLIST,
   * отправленные до неё (pipeline/working-mode.resumeFloorMs). null или нет: закрытый режим.
   */
  readonly workingMode?: WorkingMode | null;
}

/** Ответы клиентам: очередь склейки есть до WhatsApp, конвейер получает подключение после запуска. */
export interface Responder {
  readonly batcher: ChatBatcher;
  /** Агент как чтение названия с логотипа: его получает сервис компании (шаг д). */
  readonly logo: LogoReader;
  /**
   * Чат вернули боту из панели: сообщения клиента без ответа после последнего исходящего и не старше
   * BACKLOG_MAX_AGE_HOURS уходят в очередь (pipeline/resume.ts). Возвращает их число.
   */
  resume(chatId: ChatId): number;
  /** WhatsApp подключён: «печатает», прочтение и голосовые идут через это подключение. */
  connect(connection: ResponderConnection): void;
}

/** Части конвейера, которым не нужно подключение WhatsApp. */
interface ResponderParts {
  readonly agent: Agent;
  readonly transcriber: Transcriber;
}

/**
 * Собирает ответы клиентам (этап 3), только если задан ключ Claude; без ключа null и предупреждение: бот только
 * принимает и сохраняет, как на этапе 2. Знания (knowledge/, при сбое чтения понятная ошибка при старте), лог
 * расхода TOKEN_LOG_PATH, LLM с дневным предохранителем, агент, расшифровка голосовых по AppConfig.voice (нет ключа
 * OpenRouter => выключена) и очередь склейки. Отправка (outbox) и передача менеджеру (handoff/handoff.ts) общие
 * для приложения и приходят в context.services, сервис компании в context.company; агент отдаётся наружу как logo
 * (чтение логотипа для сервиса компании). Конвейер pipeline/handle-inbound.ts собирается на подключении WhatsApp
 * (connect); пачка до подключения не обрабатывается: ошибка в лог очереди. resume (возврат чата боту из панели)
 * отдаёт в ту же очередь неотвеченные сообщения клиента не старше BACKLOG_MAX_AGE_HOURS, а в рабочем режиме у чата не из
 * TEST_ALLOWLIST и не раньше границы перехода (context.workingMode).
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
  const parts = responderParts(context, config.anthropicKey, knowledge);
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
  const workingMode = context.workingMode ?? null;
  const resumeDeps: ResumeDeps = {
    chats: context.storage.chats,
    messages: context.storage.messages,
    batcher,
    clock,
    logger,
    maxAgeMs: config.backlogMaxAgeHours * HOUR_MS,
    notBeforeMs: (chat) => resumeFloorMs(workingMode, chat.identity),
  };
  return {
    batcher,
    logo: parts.agent,
    resume: (chatId) => resumeAfterReturn(resumeDeps, chatId),
    connect: (connection) => {
      pipeline = pipelineDeps(context, parts, connection);
    },
  };
}

/** Лог расхода, LLM (Claude), агент и расшифровка: всё, что не зависит от подключения WhatsApp. */
function responderParts(
  context: ResponderContext,
  apiKey: string,
  knowledge: Knowledge,
): ResponderParts {
  const { config, logger, clock, storage } = context;
  const tokenLog = createJsonlTokenLog(config.tokenLogPath, appendLine, clock);
  const api = { budget: storage.budget, clock, tokenLog, logger };
  const llm = (context.createLlm ?? createAnthropicLlm)({ apiKey, ...api });
  return {
    agent: createAgent({ llm, knowledge, models: config.models, logger }),
    transcriber: transcriberOf(config, api),
  };
}

/** Конвейер на подключении WhatsApp: оттуда «печатает», прочтение и голосовые; отправка и передача общие. */
function pipelineDeps(
  context: ResponderContext,
  parts: ResponderParts,
  connection: ResponderConnection,
): PipelineDeps {
  const { config, logger, clock, storage, services } = context;
  return {
    chats: storage.chats,
    messages: storage.messages,
    agent: parts.agent,
    outbox: services.outbox,
    handoff: services.handoff,
    company: context.company,
    transcriber: parts.transcriber,
    inbox: connection,
    typing: connection,
    typingDelayMs: (text) => typingDelayMs(text, Math.random),
    testAllowlist: allowlistOf(config),
    clock,
    logger,
    rejectedDrafts: storage.rejectedDrafts,
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

function knowledgePaths(dir: string): KnowledgePaths {
  return {
    owner: join(dir, KNOWLEDGE_FILES.owner),
    whatsapp: join(dir, KNOWLEDGE_FILES.whatsapp),
    consult: join(dir, KNOWLEDGE_FILES.consult),
  };
}

/** Строка лога расхода (уже с переводом строки) в конец файла; папка создаётся при первой записи. */
async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line, 'utf8');
}
