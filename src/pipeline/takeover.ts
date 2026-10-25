import type { ChatsRepo, MessagesRepo, OutboundIdsRepo, UnitOfWork } from '../domain/ports.js';
import type { OwnMessage } from '../domain/types.js';
import type { HandoffService } from '../handoff/handoff.js';
import { notImplemented } from '../shared/todo.js';

/** Зависимости обработки своих сообщений. */
export interface TakeoverDeps {
  outboundIds: OutboundIdsRepo;
  chats: ChatsRepo;
  messages: MessagesRepo;
  /** Транзакция для записи сообщения человека и смены статуса чата. */
  unitOfWork: UnitOfWork;
  handoff: HandoffService;
}

/** Чьё это сообщение с номера бота. */
export type TakeoverResult = 'bot_echo' | 'human_took_over' | 'not_client_chat';

/**
 * Разбирает сообщение, отправленное с номера бота (раздел плана «Технические правила», «Свои сообщения»).
 * Работает с этапа 3: с него бот начинает писать, и человек должен уметь его остановить.
 * TODO(этап 3): ID есть в outbound_ids => эхо своей отправки, ничего не делать.
 * TODO(этап 3): ID неизвестен => пишет человек с телефона: внутри unitOfWork.run сохранить текст в истории (author human_phone) и поставить статус manager (by 'phone'); бот в чате молчит.
 * TODO(этап 3): чат искать через chats.findByJid (replyJid, lidJid, pnJid), новый не создавать; не нашёлся, чат с менеджером или с самим собой => 'not_client_chat'.
 * TODO(этап 5): вместо прямой смены статуса handoff.handOff({ reason: 'human_took_over', by: 'phone' }): запись передачи, без фразы клиенту и без уведомления.
 */
export function handleOwnMessage(deps: TakeoverDeps, message: OwnMessage): Promise<TakeoverResult> {
  return notImplemented('этап 3', 'pipeline/takeover.handleOwnMessage');
}
