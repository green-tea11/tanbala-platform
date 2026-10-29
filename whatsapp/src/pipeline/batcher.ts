import type { Clock, Logger } from '../domain/ports.js';
import type { ChatId, InboundMessage } from '../domain/types.js';

/** Пачка сообщений одного чата для pipeline/handle-inbound.ts. */
export interface ClientBatch {
  readonly chatId: ChatId;
  /** Сообщения пачки по времени. */
  readonly messages: readonly InboundMessage[];
  /**
   * Забирает сообщения этого чата, пришедшие во время обработки пачки (по времени): отдельной пачкой они уже
   * не придут. Нужен, чтобы перегенерировать ответ один раз, а не отвечать дважды.
   */
  takeNewer(): readonly InboundMessage[];
}

/** Очередь входящих: собирает сообщения подряд в пачки и отдаёт их по одной на чат. */
export interface ChatBatcher {
  /** Новое сообщение клиента, уже записанное в базу (pipeline/recorder.ts), в чате chatId. */
  push(chatId: ChatId, message: InboundMessage): void;
  /**
   * Остановка: накопленные сообщения уходят в обработку сразу, промис ждёт конца всех пачек.
   * После вызова новые сообщения не принимаются (они уже в базе, ответа на них не будет).
   */
  drain(): Promise<void>;
}

/** Зависимости очереди. */
export interface ChatBatcherDeps {
  clock: Clock;
  /** Тишина после последнего сообщения, после которой пачка уходит в обработку, мс. */
  debounceMs: number;
  /** Предельное ожидание от первого сообщения пачки, мс. */
  maxWaitMs: number;
  logger: Logger;
  /** Обработка пачки; отказ промиса пишется в лог, очередь чата идёт дальше. */
  onBatch(batch: ClientBatch): Promise<void>;
}

/** Состояние очереди одного чата: меняется только внутри createChatBatcher. */
interface ChatQueue {
  readonly chatId: ChatId;
  /** Сообщения следующей пачки в порядке прихода. */
  pending: readonly InboundMessage[];
  /** Когда пришло первое сообщение следующей пачки, мс. */
  firstAtMs: number | null;
  /** Пауза склейки; abort отменяет её. */
  timer: AbortController | null;
  /** Срок пачки наступил, пока шла предыдущая: отдать сразу после неё. */
  due: boolean;
  /** Обработка текущей пачки. */
  running: Promise<void> | null;
}

/**
 * Создаёт очередь: клиент часто пишет несколькими сообщениями подряд, отвечать надо один раз.
 * Пачка уходит после тишины debounceMs, но не позже maxWaitMs от её первого сообщения; сообщения в пачке
 * по времени. Каждый чат строго по очереди (пачка ждёт конца предыдущей), разные чаты параллельно.
 * Офлайн-очередь после переподключения приходит залпом за доли секунды, поэтому накопленные сообщения чата
 * склеиваются в одну пачку, а пока чат занят предыдущей пачкой, новые копятся в следующую целиком
 * (ответ один на чат, решение владельца). Сообщения, пришедшие во время обработки, конвейер может забрать
 * через ClientBatch.takeNewer и перегенерировать ответ один раз (pipeline/handle-inbound.ts).
 * Сломанный таймер (пауза упала не по отмене) не теряет пачку: она уходит сразу. Сообщение с waId, который уже ждёт
 * в следующей пачке чата, второй раз не добавляется.
 */
export function createChatBatcher(deps: ChatBatcherDeps): ChatBatcher {
  const queues = new Map<ChatId, ChatQueue>();
  let closed = false;

  const start = (queue: ChatQueue): void => {
    const messages = takePending(queue);
    queue.running = run(queue, messages);
  };
  const fire = (queue: ChatQueue): void => {
    if (queue.running === null) start(queue);
    else queue.due = true;
  };
  const run = async (queue: ChatQueue, messages: readonly InboundMessage[]): Promise<void> => {
    try {
      await deps.onBatch({ chatId: queue.chatId, messages, takeNewer: () => takePending(queue) });
    } catch (error: unknown) {
      deps.logger.error(
        { err: error, chatId: queue.chatId },
        `Сбой обработки пачки сообщений: чат #${queue.chatId}`,
      );
    }
    queue.running = null;
    if (queue.pending.length === 0) queues.delete(queue.chatId);
    else if (queue.due || closed) start(queue);
  };
  const schedule = (queue: ChatQueue): void => {
    queue.timer?.abort();
    const timer = new AbortController();
    queue.timer = timer;
    const nowMs = deps.clock.now();
    const deadlineMs = (queue.firstAtMs ?? nowMs) + deps.maxWaitMs;
    const waitMs = Math.max(0, Math.min(deps.debounceMs, deadlineMs - nowMs));
    const onTime = (): void => {
      if (timer.signal.aborted) return;
      queue.timer = null;
      fire(queue);
    };
    deps.clock.sleep(waitMs, timer.signal).then(onTime, onTime);
  };

  return {
    push(chatId, message) {
      if (closed) {
        deps.logger.warn(
          { chatId },
          `Бот останавливается: сообщение сохранено, но без ответа: чат #${chatId}`,
        );
        return;
      }
      const queue = queues.get(chatId) ?? newQueue(chatId);
      queues.set(chatId, queue);
      // Тот же waId уже ждёт (возврат чата боту отдаёт неотвеченное ещё раз): отвечать на него дважды не нужно.
      if (queue.pending.some((waiting) => waiting.waId === message.waId)) return;
      queue.pending = [...queue.pending, message];
      queue.firstAtMs ??= deps.clock.now();
      schedule(queue);
    },
    async drain() {
      closed = true;
      while (queues.size > 0) {
        for (const queue of queues.values()) {
          if (queue.running === null) start(queue);
        }
        await Promise.all(
          Array.from(queues.values(), (queue) => queue.running ?? Promise.resolve()),
        );
      }
    },
  };
}

function newQueue(chatId: ChatId): ChatQueue {
  return { chatId, pending: [], firstAtMs: null, timer: null, due: false, running: null };
}

/** Забирает накопленные сообщения по времени и снимает паузу склейки. */
function takePending(queue: ChatQueue): readonly InboundMessage[] {
  const messages = queue.pending.toSorted((left, right) => left.tsMs - right.tsMs);
  queue.pending = [];
  queue.firstAtMs = null;
  queue.due = false;
  queue.timer?.abort();
  queue.timer = null;
  return messages;
}
