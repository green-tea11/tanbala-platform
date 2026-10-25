import type { Clock } from '../domain/ports.js';
import type { InboundMessage } from '../domain/types.js';
import { notImplemented } from '../shared/todo.js';

/** Очередь входящих: собирает сообщения подряд в пачки и отдаёт их по одной на чат. */
export interface ChatBatcher {
  push(message: InboundMessage): void;
  /** Ждёт, пока обработаются все принятые пачки: нужно при остановке. */
  drain(): Promise<void>;
}

/** Зависимости очереди. */
export interface ChatBatcherDeps {
  clock: Clock;
  /** Тишина после последнего сообщения, после которой пачка уходит в обработку, мс. */
  debounceMs: number;
  /** Предельное ожидание от первого сообщения пачки, мс. */
  maxWaitMs: number;
  onBatch(batch: readonly InboundMessage[]): Promise<void>;
}

/**
 * Создаёт очередь: клиент часто пишет несколькими сообщениями подряд, отвечать надо один раз.
 * TODO(этап 3): склейка по debounceMs, но не дольше maxWaitMs; сообщения в пачке по времени.
 * TODO(этап 3): по каждому чату строго по очереди, разные чаты параллельно.
 * TODO(этап 3): если во время генерации ответа пришло новое сообщение, перегенерировать один раз.
 */
export function createChatBatcher(deps: ChatBatcherDeps): ChatBatcher {
  return notImplemented('этап 3', 'pipeline/batcher.createChatBatcher');
}
