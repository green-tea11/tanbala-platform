import type { ChatsRepo, Clock, HandoffsRepo, Logger, UnitOfWork } from '../domain/ports.js';
import type { BudgetScope, ChatId, HandoffNotice, WaMessageId } from '../domain/types.js';
import type { Outbox } from '../messaging/outbox.js';
import { notImplemented } from '../shared/todo.js';

/**
 * Запрос передачи. Перехват человеком и исчерпанный дневной лимит идут без фразы клиенту;
 * остальные поводы всегда с фразой на входящее replyToWaId.
 */
export type HandOffRequest =
  | { readonly reason: 'human_took_over'; readonly by: 'phone' | 'panel' }
  | { readonly reason: 'limit'; readonly scope: BudgetScope }
  | (HandoffNotice & { readonly replyToWaId: WaMessageId });

/** Передача чата менеджеру и возврат боту (раздел плана «Передача менеджеру»). */
export interface HandoffService {
  handOff(chatId: ChatId, request: HandOffRequest): Promise<void>;
  /** Вернуть чат боту вручную из панели. */
  returnToBot(chatId: ChatId): Promise<void>;
}

/** Зависимости передачи. */
export interface HandoffDeps {
  chats: ChatsRepo;
  handoffs: HandoffsRepo;
  /** Транзакция для handoffs.open и chats.setStatus. */
  unitOfWork: UnitOfWork;
  outbox: Outbox;
  clock: Clock;
  logger: Logger;
}

/**
 * Создаёт сервис передачи.
 * TODO(этап 5): порядок: внутри unitOfWork.run handoffs.open (с уровнем интереса и снимком выжимки) и chats.setStatus manager; open вернул false (открытая передача уже есть) => выход, повтор ничего не дублирует.
 * TODO(этап 5): затем фраза клиенту через outbox.sendHandoffNotice (кроме human_took_over и limit), затем outbox.notifyManager с текстом из handoff/notification.ts, затем handoffs.setManagerNotified(chatId, waId или null).
 * TODO(этап 5): human_took_over: без фразы клиенту и без уведомления, только запись передачи и статус manager (by 'phone' или 'panel').
 * TODO(этап 5): limit (решение владельца): бот замолкает в этом чате, статус manager (by 'bot'), фразы клиенту нет, уведомление менеджеру с указанием лимита (scope: чат или весь бот) через notifyManager(text, 'limit'): своя квота, не вытесняет уведомления о горячих клиентах (остальные поводы шлются с kind 'handoff').
 * TODO(этап 5): сбой уведомления виден в панели и отправка повторяется; пустой MANAGER_WHATSAPP => только отметка в панели и предупреждение в лог.
 * TODO(этап 6): returnToBot закрывает передачу (handoffs.resolve) и ставит статус bot (by 'panel').
 */
export function createHandoffService(deps: HandoffDeps): HandoffService {
  return notImplemented('этап 5', 'handoff/handoff.createHandoffService');
}
