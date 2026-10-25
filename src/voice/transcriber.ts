import type { CallBudget, Clock, TokenLog, Transcriber } from '../domain/ports.js';
import { notImplemented } from '../shared/todo.js';

/** Зависимости расшифровки через OpenRouter. */
export interface OpenRouterTranscriberDeps {
  /** OPENROUTER_API_KEY: передаётся явно. */
  apiKey: string;
  /** Модель распознавания речи: открытый вопрос плана. */
  model: string;
  fetchFn: typeof fetch;
  /** Дневной предохранитель: вызов OpenRouter тоже считается вызовом API. */
  budget: CallBudget;
  clock: Clock;
  tokenLog: TokenLog;
}

/**
 * Расшифровка голосовых через внешний API на OpenRouter (этап 7).
 * TODO(этап 7, реальные вызовы только с разрешения владельца): адрес OpenRouter зафиксирован в коде, ключ передаётся явно.
 * TODO(этап 7): перед каждой попыткой budget.tryConsume(chatId, clock.now()); отказ => { ok: false, failure: 'budget_exceeded', scope } без обращения к API; сбой API => 'unavailable'.
 * TODO(этап 7): повторы только нашим кодом, каждая попытка через budget.tryConsume и с записью в TokenLog; тайм-аут запроса через AbortSignal с запасом на обработку аудио.
 * TODO(этап 7): на вход приходит уже ограниченный по размеру AudioClip (лимит байт ставит downloadAudio); аудио только в памяти; расшифровка такой же недоверенный текст, как обычное сообщение.
 * TODO(этап 7): голосовые WhatsApp в OGG/Opus: если модель их не примет, понадобится перекодирование.
 * TODO(этап 7): какая модель принимает аудио и сколько стоит: открытый вопрос плана; каждый вызов в TokenLog (provider 'openrouter', purpose 'transcribe').
 */
export function createOpenRouterTranscriber(deps: OpenRouterTranscriberDeps): Transcriber {
  return notImplemented('этап 7', 'voice/transcriber.createOpenRouterTranscriber');
}

/**
 * Выключенная расшифровка: до этапа 7 или пока нет ключа и модели OpenRouter.
 * TODO(этап 3): вернуть { enabled: false }; на голосовое конвейер отвечает ровно «Сейчас не могу прослушать голосовое, напишите, пожалуйста, текстом» через outbox.sendVoiceNotice (решение владельца), без вызова LLM.
 */
export function createDisabledTranscriber(): Transcriber {
  return notImplemented('этап 3', 'voice/transcriber.createDisabledTranscriber');
}
