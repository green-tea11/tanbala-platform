import type { ChatsRepo, Clock, Logger, MessagesRepo } from '../domain/ports.js';
import type {
  Chat,
  ChatId,
  InboundMessage,
  MediaRef,
  MessageContent,
  UnansweredInbound,
  WaMessageId,
} from '../domain/types.js';
import type { ChatBatcher } from './batcher.js';

/** Что нужно ответу на неотвеченное после возврата чата боту. */
export interface ResumeDeps {
  readonly chats: Pick<ChatsRepo, 'getById' | 'getNote'>;
  readonly messages: Pick<MessagesRepo, 'unansweredAfterLastOutbound' | 'reopenAnsweredByHandoff'>;
  /** Очередь ответов: пачка идёт обычным путём (проверки, лимиты, очередь чата). */
  readonly batcher: Pick<ChatBatcher, 'push'>;
  readonly clock: Pick<Clock, 'now'>;
  readonly logger: Logger;
  /** BACKLOG_MAX_AGE_HOURS в мс: на сообщения старше бот после возврата не отвечает. */
  readonly maxAgeMs: number;
}

/**
 * Тип голосового, если он неизвестен: в базе его нет. Скачивание берёт тип из памяти адаптера, поэтому здесь он только
 * для формы MessageContent (как DEFAULT_VOICE_MIME_TYPE в whatsapp/inbound.ts).
 */
const STORED_VOICE_MIME_TYPE = 'audio/ogg; codecs=opus';

/**
 * Ссылка на голосовое в памяти адаптера WhatsApp: его waId (whatsapp/inbound.mediaRefOf). Голосовое держится в памяти
 * недолго (whatsapp/voice-media.VOICE_TTL_MS); после этого скачивание бросает ошибку, и конвейер отвечает фиксированной
 * фразой про голосовое без вызова расшифровки.
 */
function storedVoiceRef(waId: WaMessageId): MediaRef {
  const ref: string = waId;
  return ref as MediaRef;
}

/**
 * Сообщение из базы как входящее для очереди: текст (и расшифровка голосового) текстом, голосовое без расшифровки
 * голосовым (ревью 29.10.2026: конвейер попробует расшифровать его или ответит фразой про голосовое), остальное без
 * текста.
 */
function contentOf(message: UnansweredInbound): MessageContent {
  if (message.text !== null) return { kind: 'text', text: message.text };
  if (message.kind !== 'voice') return { kind: 'other' };
  return {
    kind: 'voice',
    media: storedVoiceRef(message.waId),
    mimeType: STORED_VOICE_MIME_TYPE,
    seconds: null,
  };
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
 * Возврат с заметкой, а неотвеченного нет (ревью 29.10.2026, ждёт подтверждения владельца): если последнее исходящее
 * это фраза передачи бота и после неё никто не писал, сообщения клиента, на которые она ответила, снова ждут ответа.
 * Без заметки ничего: бот по-прежнему не пишет первым.
 */
function reopenForNote(
  deps: ResumeDeps,
  chatId: ChatId,
  sinceMs: number,
): readonly UnansweredInbound[] {
  if (deps.chats.getNote(chatId) === null) return [];
  return deps.messages.reopenAnsweredByHandoff(chatId, sinceMs);
}

/**
 * Возврат чата боту из панели (решение владельца 29.10.2026): сообщения клиента, пришедшие после последнего исходящего
 * (бота, менеджера из панели или с телефона) и не старше maxAgeMs, уходят в очередь ответа, и бот отвечает на них одной
 * пачкой обычным путём (проверки кодом и вторым вызовом, лимиты, перегенерация). Если после них уже ответил человек
 * или они старше порога, отвечать не на что. Возврат с заметкой, когда отвечать не на что, а последнее исходящее это
 * фраза передачи бота без ответа человека после неё: в очередь идут сообщения клиента, на которые ответила фраза
 * (не старше maxAgeMs), и бот возвращается к ним с указанием коллеги (reopenForNote). Чата нет или он снова у
 * менеджера: ничего. Повторный вызов безопасен: очередь не берёт тот же waId дважды, а конвейер не отвечает на уже
 * отвеченное. Возвращает, сколько сообщений ушло. В лог только ID чата, число и путь, без текста.
 */
export function resumeAfterReturn(deps: ResumeDeps, chatId: ChatId): number {
  const chat = deps.chats.getById(chatId);
  if (chat?.control.status !== 'bot') return 0;
  const sinceMs = Math.max(0, deps.clock.now() - deps.maxAgeMs);
  const unanswered = deps.messages.unansweredAfterLastOutbound(chat.id, sinceMs);
  const afterHandoffNotice = unanswered.length === 0;
  const pending = afterHandoffNotice ? reopenForNote(deps, chat.id, sinceMs) : unanswered;
  if (pending.length === 0) return 0;
  for (const message of pending) deps.batcher.push(chat.id, toInbound(chat, message));
  if (afterHandoffNotice) {
    deps.logger.info(
      { chatId: chat.id, count: pending.length, afterHandoffNotice },
      `Чат возвращён боту с заметкой: бот вернётся к сообщениям, на которые ответил фразой передачи: чат #${chat.id}`,
    );
  } else {
    deps.logger.info(
      { chatId: chat.id, count: pending.length },
      `Чат возвращён боту: бот ответит на сообщения клиента без ответа: чат #${chat.id}`,
    );
  }
  return pending.length;
}
