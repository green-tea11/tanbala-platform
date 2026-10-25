import type { Anthropic, ClientOptions } from '@anthropic-ai/sdk';
import type { CallBudget, Clock, LlmClient, Logger, TokenLog } from '../domain/ports.js';
import { notImplemented } from '../shared/todo.js';

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

/**
 * LlmClient поверх официального SDK Anthropic. Поведение проверено на @anthropic-ai/sdk 0.135.0, при обновлении SDK перепроверить.
 * TODO(этап 3, реальные вызовы только с разрешения владельца): фабрика deps.createSdk ?? ((options) => new Anthropic(options)) (Anthropic тогда импортировать как значение); опции { apiKey, authToken: null, baseURL: 'https://api.anthropic.com', logLevel: 'warn', logger: адаптер к Logger, openTelemetry: false, maxRetries: 0, timeout с запасом на размышления модели }.
 * TODO(этап 3): в SDK 0.135.0 undefined в apiKey или authToken значит «прочитать из окружения» (стандартная переменная ключа SDK, ANTHROPIC_AUTH_TOKEN), а null нет; при обоих ключах уходят оба заголовка. Поэтому authToken: null обязателен.
 * TODO(этап 3): логгер SDK через адаптер: SDK вызывает warn(message, ...rest), а порт Logger ждёт контекст объектом.
 * TODO(этап 3): перед каждой попыткой budget.tryConsume(request.chatId, clock.now()); отказ => { ok: false, failure: 'budget_exceeded', scope } без обращения к API (дневной предохранитель владельца: API_DAILY_LIMIT на бот, API_DAILY_LIMIT_PER_CHAT на чат).
 * TODO(этап 3): повторы только нашим кодом (maxRetries: 0 в SDK), каждая попытка через budget.tryConsume и с записью в TokenLog: повторы SDK, в том числе по тайм-ауту, оплачивались бы мимо лимита и лога токенов.
 * TODO(этап 3): НЕ messages.parse: при ошибке разбора он бросает исключение и usage теряется. Вызов: messages.create с output_config.format = zodOutputFormat(schema) из '@anthropic-ai/sdk/helpers/zod'.
 * TODO(этап 3): после КАЖДОГО вызова, включая неудачный, сначала записать в TokenLog usage (input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens), потом проверить ответ через safeParse схемой.
 * TODO(этап 3): stop_reason 'refusal' => failure 'refusal'; 'max_tokens' и 'model_context_window_exceeded' => 'truncated'; провал safeParse => 'invalid_output'; лимит запросов => 'rate_limited'; сеть и 5xx => 'unavailable'.
 * TODO(этап 3): без prefill и без temperature, top_p, top_k: Haiku 5.5 отвечает на них ошибкой 400; cache_control { type: 'ephemeral' } на последнем блоке знаний, TTL 1 час решать по логу токенов.
 * TODO(этап 3): размышления Haiku 5.5 входят в output_tokens и в max_tokens: держать запас; effort выбрать по логу токенов.
 * TODO(этап 3): переход на SDK 1.x решить после карантина 7 дней для новых версий.
 */
export function createAnthropicLlm(deps: AnthropicLlmDeps): LlmClient {
  return notImplemented('этап 3', 'llm/anthropic.createAnthropicLlm');
}
