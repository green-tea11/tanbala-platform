import type { ChatsRepo, MessagesRepo, OutboundIdsRepo, UnitOfWork } from '../domain/ports.js';
import type { Chat, MessageContent, NewMessage, OwnMessage } from '../domain/types.js';

/** Зависимости обработки своих сообщений. */
export interface TakeoverDeps {
  outboundIds: OutboundIdsRepo;
  chats: ChatsRepo;
  messages: MessagesRepo;
  /** Транзакция для записи сообщения человека и смены статуса чата. */
  unitOfWork: UnitOfWork;
}

/** Чьё это сообщение с номера бота. */
export type TakeoverResult = 'bot_echo' | 'human_took_over' | 'not_client_chat';

/**
 * Разбирает сообщение, отправленное с номера бота (раздел плана «Технические правила», «Свои сообщения»).
 * Работает с этапа 3: с него бот начинает писать, и человек должен уметь его остановить.
 * ID есть в outbound_ids => эхо своей отправки (messaging/outbox.ts пишет ID до отправки), ничего не делать.
 * ID неизвестен => пишет человек с телефона: внутри unitOfWork.run текст в историю (author human_phone, повторная
 * доставка без дубля) и статус manager (by 'phone') со временем сообщения; бот в чате молчит. Чат, который уже ведёт
 * человек с телефона, статус не меняет: время перехвата остаётся первым. Чат ищется через chats.findByJid (replyJid,
 * lidJid, pnJid), новый не создаётся: не нашёлся => 'not_client_chat'. Чаты с менеджером и с самим собой сюда
 * не доходят: их отсекает whatsapp/inbound.ts (пропуски manager и self). Сбой записи откатывает всё и приходит
 * отказом промиса.
 * TODO(этап 5): вместо прямой смены статуса handoff.handOff({ reason: 'human_took_over', by: 'phone' }): запись передачи, без фразы клиенту и без уведомления.
 */
export function handleOwnMessage(deps: TakeoverDeps, message: OwnMessage): Promise<TakeoverResult> {
  // Исполнитель промиса превращает исключение записи в отказ, а не в бросок.
  return new Promise<TakeoverResult>((resolve) => {
    resolve(classifyOwn(deps, message));
  });
}

function classifyOwn(deps: TakeoverDeps, message: OwnMessage): TakeoverResult {
  if (deps.outboundIds.find(message.waId) !== null) return 'bot_echo';
  return deps.unitOfWork.run((): TakeoverResult => {
    const chat = deps.chats.findByJid(message.chatJid);
    if (chat === null) return 'not_client_chat';
    deps.messages.insertIfNew(toHumanMessage(chat, message));
    if (!isLedFromPhone(chat)) {
      deps.chats.setStatus(chat.id, { status: 'manager', by: 'phone' }, message.tsMs);
    }
    return 'human_took_over';
  });
}

function isLedFromPhone(chat: Chat): boolean {
  return chat.control.status === 'manager' && chat.control.by === 'phone';
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
