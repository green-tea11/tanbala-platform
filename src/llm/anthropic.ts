import { Anthropic, APIError, RateLimitError, type ClientOptions } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type {
  ContentBlock,
  ContentBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  OutputConfig,
  TextBlock,
  TextBlockParam,
  Usage,
} from '@anthropic-ai/sdk/resources/messages';
import type {
  CallBudget,
  Clock,
  ImageInput,
  LlmClient,
  Logger,
  StructuredRequest,
  SystemBlock,
  TokenLog,
} from '../domain/ports.js';
import type { LlmFailure, LlmPurpose, LlmResult, TokenUsageEntry } from '../domain/types.js';
import { SafeError } from '../shared/safe-error.js';

/** Зависимости клиента Claude. */
export interface AnthropicLlmDeps {
  /** Ключ из VENMART_ANTHROPIC_KEY: непустой, иначе клиент не создаётся вовсе. */
  apiKey: string;
  /**
   * Фабрика SDK для тестов: мок проверяет аргументы конструктора без сети. В рабочем режиме не передаётся:
   * main не может импортировать SDK (границы модулей), клиента создаёт сам адаптер.
   */
  createSdk?: (options: ClientOptions) => Anthropic;
  /** Дневной предохранитель: проверяется перед каждым вызовом API. */
  budget: CallBudget;
  clock: Clock;
  tokenLog: TokenLog;
  logger: Logger;
}

type Effort = NonNullable<OutputConfig['effort']>;
type SdkLogger = NonNullable<ClientOptions['logger']>;
type TokenCounts = Pick<TokenUsageEntry, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>;

/** Адрес API явно: иначе SDK взял бы ANTHROPIC_BASE_URL из окружения. */
const API_BASE_URL = 'https://api.anthropic.com';
/** Ответ одна или две фразы, но с размышлениями модели: запас на медленный ответ без повторов SDK. */
const REQUEST_TIMEOUT_MS = 60_000;
const SDK_LOG_CONTEXT = { module: 'anthropic-sdk' } as const;
/** Вызов без ответа API (сеть, 5xx, лимит запросов): токены неизвестны, в лог расхода идут нули. */
const NO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * effort по типу вызова: размышления Haiku 5.5 и Sonnet 5.5 входят в output_tokens и в max_tokens. Ответ, проверка
 * черновика и оценка интереса идут с low: ответы короткие, а модель размышляет сама (adaptive thinking).
 * TODO(этап 8): уровень effort проверки и оценки интереса подобрать по логу токенов и качеству на живых чатах.
 */
const EFFORT: Readonly<Record<LlmPurpose, Effort>> = {
  reply: 'low',
  review: 'low',
  interest: 'low',
  logo: 'low',
};

/** Логгер SDK вызывает warn(message, ...rest), а порт ждёт контекст объектом. rest (тела запросов и ответов) не пишется. */
function toSdkLogger(logger: Logger): SdkLogger {
  const forward =
    (level: 'error' | 'warn' | 'info' | 'debug') =>
    (message: string): void => {
      logger[level](SDK_LOG_CONTEXT, message);
    };
  return {
    error: forward('error'),
    warn: forward('warn'),
    info: forward('info'),
    debug: forward('debug'),
  };
}

/**
 * undefined в apiKey или authToken значит для SDK 0.135.0 «прочитать из окружения» (стандартная переменная ключа,
 * ANTHROPIC_AUTH_TOKEN), а null нет; при обоих ключах ушли бы оба заголовка. Поэтому authToken: null обязателен.
 * maxRetries: 0: повтор SDK, в том числе по тайм-ауту, оплачивался бы мимо дневного лимита и лога токенов.
 */
function clientOptions(apiKey: string, logger: Logger): ClientOptions {
  return {
    apiKey,
    authToken: null,
    baseURL: API_BASE_URL,
    logLevel: 'warn',
    logger: toSdkLogger(logger),
    openTelemetry: false,
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
  };
}

function toSystemParam(block: SystemBlock): TextBlockParam {
  return block.cache
    ? { type: 'text', text: block.text, cache_control: { type: 'ephemeral' } }
    : { type: 'text', text: block.text };
}

/**
 * Реплика с картинкой: блоки [картинка base64 с media_type, затем текст]. Байты берутся по byteOffset и byteLength:
 * массив может быть частью общего буфера.
 */
function withImage(image: ImageInput, text: string): ContentBlockParam[] {
  const { data } = image;
  return [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mimeType,
        data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64'),
      },
    },
    { type: 'text', text },
  ];
}

/** Реплики запроса; картинка (вызов logo) только у последней реплики user, остальные реплики строками. */
function toMessages<T>(request: StructuredRequest<T>): MessageParam[] {
  const lastIndex = request.turns.length - 1;
  return request.turns.map(({ role, text }, index) => ({
    role,
    content:
      index === lastIndex && request.image !== undefined ? withImage(request.image, text) : text,
  }));
}

/**
 * Без temperature, top_p, top_k, prefill и thinking: Haiku 5.5 и Sonnet 5.5 отвечают на них ошибкой 400 (для thinking
 * это значение disabled). Модель берётся из запроса, привязки к одной модели здесь нет.
 */
function toParams<T>(request: StructuredRequest<T>): MessageCreateParamsNonStreaming {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system.map(toSystemParam),
    messages: toMessages(request),
    output_config: { format: zodOutputFormat(request.schema), effort: EFFORT[request.purpose] },
  };
}

function tokensOf(usage: Usage): TokenCounts {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}

function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text';
}

function parseJson(
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Разбор ответа после записи расхода: отказ, обрезка, затем JSON и схема (safeParse, без исключений). */
function interpret<T>(message: Message, schema: StructuredRequest<T>['schema']): LlmResult<T> {
  if (message.stop_reason === 'refusal') {
    return { ok: false, failure: 'refusal' };
  }
  if (
    message.stop_reason === 'max_tokens' ||
    message.stop_reason === 'model_context_window_exceeded'
  ) {
    return { ok: false, failure: 'truncated' };
  }
  const json = parseJson(
    message.content
      .filter(isTextBlock)
      .map(({ text }) => text)
      .join(''),
  );
  if (!json.ok) {
    return { ok: false, failure: 'invalid_output' };
  }
  const parsed = schema.safeParse(json.value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, failure: 'invalid_output' };
}

function failureOf(error: unknown): Extract<LlmFailure, 'rate_limited' | 'unavailable'> {
  return error instanceof RateLimitError ? 'rate_limited' : 'unavailable';
}

/** Для лога: класс, статус, тип ошибки API и ID запроса. Текст ошибки не пишется: в нём бывает текст запроса. */
function errorDetails(error: unknown): Readonly<Record<string, unknown>> {
  const errorName = error instanceof Error ? error.constructor.name : typeof error;
  if (!(error instanceof APIError)) {
    return { errorName };
  }
  return { errorName, status: error.status, errorType: error.type, requestId: error.requestID };
}

interface CallContext<T> {
  readonly deps: AnthropicLlmDeps;
  readonly request: StructuredRequest<T>;
}

/** Каждый вызов API, включая неудачный, пишется в лог расхода; сбой записи не теряет ответ модели. */
async function recordUsage<T>(
  { deps, request }: CallContext<T>,
  tokens: TokenCounts,
  ok: boolean,
): Promise<void> {
  try {
    await deps.tokenLog.record({
      provider: 'anthropic',
      purpose: request.purpose,
      model: request.model,
      ...tokens,
      chatId: request.chatId,
      ok,
    });
  } catch (error: unknown) {
    deps.logger.error(
      { purpose: request.purpose, chatId: request.chatId, ...errorDetails(error) },
      'запись в лог расхода API не удалась',
    );
  }
}

async function callStructured<T>(sdk: Anthropic, call: CallContext<T>): Promise<LlmResult<T>> {
  const { deps, request } = call;
  const decision = deps.budget.tryConsume(request.chatId, deps.clock.now());
  if (!decision.ok) {
    return { ok: false, failure: 'budget_exceeded', scope: decision.scope };
  }
  const logContext = { purpose: request.purpose, chatId: request.chatId };
  let message: Message;
  try {
    message = await sdk.messages.create(toParams(request));
  } catch (error: unknown) {
    await recordUsage(call, NO_TOKENS, false);
    const failure = failureOf(error);
    deps.logger.warn({ ...logContext, failure, ...errorDetails(error) }, 'вызов Claude не удался');
    return { ok: false, failure };
  }
  await recordUsage(call, tokensOf(message.usage), true);
  const result = interpret(message, request.schema);
  if (!result.ok) {
    deps.logger.warn(
      { ...logContext, failure: result.failure, stopReason: message.stop_reason },
      'ответ Claude не годится',
    );
  }
  return result;
}

/**
 * LlmClient поверх официального SDK Anthropic. Поведение проверено на @anthropic-ai/sdk 0.135.0, при обновлении SDK перепроверить.
 * SDK создаётся один раз: deps.createSdk или new Anthropic с явными опциями (clientOptions).
 * Порядок вызова: budget.tryConsume(chatId, clock.now()) (отказ => budget_exceeded со scope, без обращения к API);
 * messages.create с output_config.format = zodOutputFormat(schema) и effort; запись usage в TokenLog после
 * КАЖДОГО вызова, включая неудачный; только потом safeParse схемой. НЕ messages.parse: при ошибке разбора он
 * бросает исключение и usage теряется. ok в логе расхода значит «API ответил».
 * Итог: stop_reason 'refusal' => refusal; 'max_tokens' и 'model_context_window_exceeded' => truncated; провал
 * разбора => invalid_output; RateLimitError => rate_limited; сеть, тайм-аут, 5xx и прочие ошибки => unavailable.
 * Повторов здесь нет: повтор делает вызывающий новым вызовом structured, и он тоже проходит лимит и лог расхода.
 * cache_control { type: 'ephemeral' } ставится на блоки system с cache: true (последний блок знаний).
 * Картинка (StructuredRequest.image, вызов logo): последняя реплика user уходит блоками [картинка base64 с media_type,
 * затем текст]; расход пишется с видом вызова из запроса (logo), как у остальных.
 * TODO(этап 3): TTL кэша 1 час решать по логу токенов.
 * TODO(этап 3): переход на SDK 1.x решить после карантина 7 дней для новых версий.
 */
export function createAnthropicLlm(deps: AnthropicLlmDeps): LlmClient {
  if (deps.apiKey.trim() === '') {
    throw new SafeError('Ключ Claude пуст: клиент Anthropic не создан');
  }
  const createSdk = deps.createSdk ?? ((options: ClientOptions) => new Anthropic(options));
  const sdk = createSdk(clientOptions(deps.apiKey, deps.logger));
  return {
    structured: <T>(request: StructuredRequest<T>): Promise<LlmResult<T>> =>
      callStructured(sdk, { deps, request }),
  };
}
