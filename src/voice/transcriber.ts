import type { TokenLog, Transcriber } from '../domain/ports.js';
import { notImplemented } from '../shared/todo.js';

/** Зависимости расшифровки через OpenRouter. */
export interface OpenRouterTranscriberDeps {
  /** OPENROUTER_API_KEY: передаётся явно. */
  apiKey: string;
  /** Модель распознавания речи: открытый вопрос плана. */
  model: string;
  fetchFn: typeof fetch;
  tokenLog: TokenLog;
}

/**
 * Расшифровка голосовых через внешний API на OpenRouter (этап 7).
 * TODO(этап 7, реальные вызовы только с разрешения владельца): адрес OpenRouter зафиксирован в коде, ключ передаётся явно.
 * TODO(этап 7): на вход приходит уже ограниченный по размеру AudioClip (лимит байт ставит downloadAudio); аудио только в памяти; расшифровка такой же недоверенный текст, как обычное сообщение.
 * TODO(этап 7): голосовые WhatsApp в OGG/Opus: если модель их не примет, понадобится перекодирование.
 * TODO(этап 7): какая модель принимает аудио и сколько стоит: открытый вопрос плана; каждый вызов в TokenLog (provider 'openrouter', purpose 'transcribe').
 */
export function createOpenRouterTranscriber(deps: OpenRouterTranscriberDeps): Transcriber {
  return notImplemented('этап 7', 'voice/transcriber.createOpenRouterTranscriber');
}

/**
 * Выключенная расшифровка: пока нет ключа или модели OpenRouter.
 * TODO(этап 3): вернуть { enabled: false }; что ответить клиенту на голосовое, решает конвейер (pipeline/handle-inbound.ts).
 */
export function createDisabledTranscriber(): Transcriber {
  return notImplemented('этап 3', 'voice/transcriber.createDisabledTranscriber');
}
