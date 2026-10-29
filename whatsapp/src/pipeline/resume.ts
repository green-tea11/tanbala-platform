import type { ChatsRepo, Clock, Logger, MessagesRepo } from '../domain/ports.js';
import type {
  Chat,
  ChatId,
  InboundMessage,
  MessageContent,
  UnansweredInbound,
} from '../domain/types.js';
import type { ChatBatcher } from './batcher.js';

/** Что нужно ответу на неотвеченное после возврата чата боту. */
export interface ResumeDeps {
  readonly chats: Pick<ChatsRepo, 'getById'>;
  readonly messages: Pick<MessagesRepo, 'unansweredAfterLastOutbound'>;
  /** Очередь ответов: пачка идёт обычным путём (проверки, лимиты, очередь чата). */
  readonly batcher: Pick<ChatBatcher, 'push'>;
  readonly clock: Pick<Clock, 'now'>;
  readonly logger: Logger;
  /** BACKLOG_MAX_AGE_HOURS в мс: на сообщения старше бот после возврата не отвечает. */
  readonly maxAgeMs: number;
}

/**
 * Сообщение из базы как входящее для очереди: текст (и расшифровка голосового) текстом, остальное без текста. Голосовое
 * без расшифровки уже не скачать (его держал адаптер WhatsApp только в памяти), поэтому оно идёт как вложение.
 */
function contentOf(message: UnansweredInbound): MessageContent {
  return message.text === null ? { kind: 'other' } : { kind: 'text', text: message.text };
}

function toInbound(chat: Chat, message: UnansweredInbound): InboundMessage {
  return {
    waId: message.waId,
    identity: chat.identity,
    pushName: chat.pushName,
    content: contentOf(message),
    tsMs: message.tsMs,
  };
}

/**
 * Возврат чата боту из панели (решение владельца 29.10.2026): сообщения клиента, пришедшие после последнего исходящего
 * (бота, менеджера из панели или с телефона) и не старше maxAgeMs, уходят в очередь ответа, и бот отвечает на них одной
 * пачкой обычным путём (проверки кодом и вторым вызовом, лимиты, перегенерация). Если после них уже ответил человек
 * или они старше порога, отвечать не на что. Чата нет или он снова у менеджера: ничего. Повторный вызов безопасен:
 * очередь не берёт тот же waId дважды, а конвейер не отвечает на уже отвеченное. Возвращает, сколько сообщений ушло.
 * В лог только ID чата и число.
 */
export function resumeAfterReturn(deps: ResumeDeps, chatId: ChatId): number {
  const chat = deps.chats.getById(chatId);
  if (chat?.control.status !== 'bot') return 0;
  const sinceMs = Math.max(0, deps.clock.now() - deps.maxAgeMs);
  const pending = deps.messages.unansweredAfterLastOutbound(chat.id, sinceMs);
  if (pending.length === 0) return 0;
  for (const message of pending) deps.batcher.push(chat.id, toInbound(chat, message));
  deps.logger.info(
    { chatId: chat.id, count: pending.length },
    `Чат возвращён боту: бот ответит на сообщения клиента без ответа: чат #${chat.id}`,
  );
  return pending.length;
}
