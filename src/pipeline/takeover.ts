import type { ChatsRepo, MessagesRepo, OutboundIdsRepo } from '../domain/ports.js';
import type { Chat, MessageContent, NewMessage, OwnMessage } from '../domain/types.js';
import type { HandoffService } from '../handoff/handoff.js';

/** Зависимости обработки своих сообщений. */
export interface TakeoverDeps {
  outboundIds: Pick<OutboundIdsRepo, 'find'>;
  chats: Pick<ChatsRepo, 'findByJid'>;
  messages: Pick<MessagesRepo, 'insertIfNew'>;
  /** Сервис передачи: человек подключился, бот в чате выключается (handOff human_took_over, by 'phone'). */
  handoff: Pick<HandoffService, 'handOff'>;
}

/** Чьё это сообщение с номера бота. */
export type TakeoverResult = 'bot_echo' | 'human_took_over' | 'not_client_chat';

/**
 * Разбирает сообщение, отправленное с номера бота (раздел плана «Технические правила», «Свои сообщения»).
 * Работает с этапа 3: с него бот начинает писать, и человек должен уметь его остановить.
 * ID есть в outbound_ids => эхо своей отправки (messaging/outbox.ts пишет ID до отправки), ничего не делать.
 * ID неизвестен => пишет человек с телефона: текст в историю (author human_phone, повторная доставка без дубля), затем
 * handoff.handOff({ reason: 'human_took_over', by: 'phone' }): запись передачи и статус manager, без фразы клиенту и
 * без уведомления менеджеру; бот в чате молчит. Статус, время и автора перехвата определяет сервис передачи:
 * чат, который уже ведёт человек, он не трогает, повтор ничего не дублирует, поэтому handOff зовётся на каждое
 * сообщение человека, в том числе при повторной доставке (прошлая попытка могла упасть на передаче). Чат ищется
 * через chats.findByJid (replyJid, lidJid, pnJid), новый не создаётся: не нашёлся => 'not_client_chat'. Чаты
 * с менеджером и с самим собой сюда не доходят: их отсекает whatsapp/inbound.ts (пропуски manager и self). Сбой
 * записи сообщения или передачи приходит отказом промиса; сообщение человека при сбое передачи остаётся в истории.
 */
export async function handleOwnMessage(
  deps: TakeoverDeps,
  message: OwnMessage,
): Promise<TakeoverResult> {
  if (deps.outboundIds.find(message.waId) !== null) return 'bot_echo';
  const chat = deps.chats.findByJid(message.chatJid);
  if (chat === null) return 'not_client_chat';
  deps.messages.insertIfNew(toHumanMessage(chat, message));
  await deps.handoff.handOff(chat.id, { reason: 'human_took_over', by: 'phone' });
  return 'human_took_over';
}

function toHumanMessage(chat: Chat, message: OwnMessage): NewMessage {
  return {
    chatId: chat.id,
    waId: message.waId,
    author: 'human_phone',
    ...columnsOf(message.content),
    tsMs: message.tsMs,
  };
}

/** Текст есть только у текстового сообщения; голосовое хранится без текста до расшифровки. */
function columnsOf(content: MessageContent): Pick<NewMessage, 'kind' | 'text'> {
  return content.kind === 'text'
    ? { kind: 'text', text: content.text }
    : { kind: content.kind, text: null };
}
