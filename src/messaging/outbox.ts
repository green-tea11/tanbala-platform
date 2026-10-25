import type {
  ChatsRepo,
  Clock,
  MessagesRepo,
  MessageSender,
  OutboundIdsRepo,
} from '../domain/ports.js';
import type { ChatId, HandoffNotice, Jid, ReviewedText, WaMessageId } from '../domain/types.js';
import { notImplemented } from '../shared/todo.js';

/** Отправка не состоялась из-за лимита исходящих или аварийного выключателя автоответов. */
export type SendBlocked = 'skipped_limit' | 'disabled';

/** Итог уведомления менеджеру: waId нужен для HandoffsRepo.setManagerNotified. */
export type ManagerNotifyResult =
  | { readonly status: 'sent'; readonly waId: WaMessageId }
  | { readonly status: 'no_manager' | 'skipped_limit' };

/** Единственный путь исходящих сообщений с номера бота. */
export interface Outbox {
  /** Ответ клиенту в чат, где есть неотвеченное входящее replyToWaId. ReviewedText: текст прошёл проверки. */
  sendBotReply(
    chatId: ChatId,
    text: ReviewedText,
    replyToWaId: WaMessageId,
  ): Promise<'sent' | 'skipped_manager' | 'skipped_no_inbound' | SendBlocked>;
  /**
   * Фраза клиенту при передаче. Статус чата не проверяет (чат уже у менеджера);
   * текст не параметр: фраза фиксированная по поводу, без LLM и без времени.
   */
  sendHandoffNotice(
    chatId: ChatId,
    notice: HandoffNotice,
    replyToWaId: WaMessageId,
  ): Promise<'sent' | 'skipped_no_inbound' | SendBlocked>;
  /** Уведомление менеджеру на MANAGER_WHATSAPP: единственное исходящее не в ответ. */
  notifyManager(text: string): Promise<ManagerNotifyResult>;
  /** Ответ менеджера из панели от имени номера: чат сразу переходит в статус manager. */
  sendFromPanel(chatId: ChatId, text: string): Promise<'sent'>;
}

/** Зависимости исходящих. managerJid: null, если MANAGER_WHATSAPP не задан. */
export interface OutboxDeps {
  sender: MessageSender;
  chats: ChatsRepo;
  messages: MessagesRepo;
  outboundIds: OutboundIdsRepo;
  clock: Clock;
  managerJid: Jid | null;
  random: () => number;
}

/**
 * Создаёт Outbox. Бот пишет только в ответ на входящие и менеджеру; адресат никогда не берётся из текста LLM.
 * TODO(этап 3): ID получать через sender.newMessageId и записывать в outbound_ids ДО отправки, иначе эхо от WhatsApp придёт раньше записи и бот примет себя за человека; после отправки setResult 'sent' или 'failed'.
 * TODO(этап 3): sendBotReply отправляет, только если в чате есть неотвеченное входящее, и перед отправкой перечитывает статус чата: человек мог подключиться, пока LLM писал ответ.
 * TODO(этап 3): перед ответом статус «печатает» с паузой из messaging/typing.ts.
 * TODO(этап 3): лимиты исходящих на чат и в час и аварийный выключатель автоответов (итоги 'skipped_limit' и 'disabled'); отправлять только текст.
 * TODO(этап 3): фразы sendHandoffNotice: hot и asked_human: «передал вопрос специалисту, он вам напишет»; no_answer: «уточню у специалиста»; check_failed и llm_error: «передам вопрос специалисту»; complaint: извинение и «передал вопрос специалисту» (как в knowledge/whatsapp.md); complaint со stopRequested: только извинение. Несколько вариантов каждой фразы.
 * TODO(этап 5): notifyManager шлёт только на managerJid; нет его => 'no_manager'; лимит уведомлений в час => 'skipped_limit'.
 * TODO(этап 6): sendFromPanel пишет с origin 'panel' и переводит чат в статус manager (by 'panel').
 */
export function createOutbox(deps: OutboxDeps): Outbox {
  return notImplemented('этап 3', 'messaging/outbox.createOutbox');
}
