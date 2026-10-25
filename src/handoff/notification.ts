import type {
  BacklogChat,
  BudgetScope,
  ChatId,
  ClientProfile,
  HandoffReason,
  InterestLevel,
  PhoneDigits,
} from '../domain/types.js';
import { notImplemented } from '../shared/todo.js';

/** Причина в уведомлении: для лимита обязательно указать, какой лимит исчерпан. */
export type NotificationReason =
  | { readonly reason: Exclude<HandoffReason, 'limit'> }
  | { readonly reason: 'limit'; readonly scope: BudgetScope };

/** Данные для уведомления менеджеру. */
export type ManagerNotificationInput = NotificationReason & {
  /** Имя из профиля WhatsApp: недоверенный текст. */
  readonly name: string | null;
  /** Номер клиента; null, если чат пришёл только с адресом @lid. */
  readonly phone: PhoneDigits | null;
  readonly level: InterestLevel;
  readonly profile: ClientProfile;
  /** ID чата в панели. */
  readonly chatId: ChatId;
};

/**
 * Текст уведомления на номер менеджера: имя и номер клиента, уровень интереса, выжимка и причина передачи.
 * Чистая функция, без LLM.
 * TODO(этап 5): фиксированный шаблон; в выжимке все поля ClientProfile: бизнес, площадь, что учитывать, число вещей, есть ли 1С, задача, особенности.
 * TODO(этап 5): нет номера => «номер скрыт» и ID чата в панели.
 * TODO(этап 5): имя и каждое поле выжимки одной строкой (переводы строк убрать), без ссылок, с лимитом длины и пометкой «со слов клиента», чтобы инъекция не подделала строки шаблона и не доставила фишинг менеджеру.
 * TODO(этап 3): reason 'limit' нужен уже на этапе 3 (предохранитель с первых реальных вызовов): «бот замолчал в этом чате: исчерпан лимит чата (API_DAILY_LIMIT_PER_CHAT)» или «исчерпан общий лимит бота на сутки (API_DAILY_LIMIT)», плюс ID чата и номер.
 */
export function formatManagerNotification(input: ManagerNotificationInput): string {
  return notImplemented('этап 3', 'handoff/notification.formatManagerNotification');
}

/**
 * Одно уведомление менеджеру со списком чатов, на которые бот не ответил после простоя (решение владельца).
 * Чистая функция, без LLM.
 * TODO(этап 2): фиксированный шаблон: заголовок с порогом в часах и числом чатов, затем по строке на чат: имя, номер или «номер скрыт», ID чата, время последнего сообщения по Алматы.
 * TODO(этап 2): имена одной строкой (переводы строк, Cc и Cf убрать), без ссылок, с лимитом длины; общий лимит длины сообщения: лишние чаты свернуть в «и ещё N чатов, список в панели».
 * TODO(этап 2): в закрытом режиме сюда попадают только чаты из TEST_ALLOWLIST: остальные отсекает whatsapp/inbound.ts.
 */
export function formatBacklogNotification(chats: readonly BacklogChat[]): string {
  return notImplemented('этап 2', 'handoff/notification.formatBacklogNotification');
}
