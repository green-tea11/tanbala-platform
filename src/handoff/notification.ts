import type {
  ChatId,
  ClientProfile,
  HandoffReason,
  InterestLevel,
  PhoneDigits,
} from '../domain/types.js';
import { notImplemented } from '../shared/todo.js';

/** Данные для уведомления менеджеру. */
export interface ManagerNotificationInput {
  /** Имя из профиля WhatsApp: недоверенный текст. */
  readonly name: string | null;
  /** Номер клиента; null, если чат пришёл только с адресом @lid. */
  readonly phone: PhoneDigits | null;
  readonly level: InterestLevel;
  readonly profile: ClientProfile;
  readonly reason: HandoffReason;
  /** ID чата в панели. */
  readonly chatId: ChatId;
}

/**
 * Текст уведомления на номер менеджера: имя и номер клиента, уровень интереса, выжимка и причина передачи.
 * Чистая функция, без LLM.
 * TODO(этап 5): фиксированный шаблон; в выжимке все поля ClientProfile: бизнес, площадь, что учитывать, число вещей, есть ли 1С, задача, особенности.
 * TODO(этап 5): нет номера => «номер скрыт» и ID чата в панели.
 * TODO(этап 5): имя и каждое поле выжимки одной строкой (переводы строк убрать), без ссылок, с лимитом длины и пометкой «со слов клиента», чтобы инъекция не подделала строки шаблона и не доставила фишинг менеджеру.
 */
export function formatManagerNotification(input: ManagerNotificationInput): string {
  return notImplemented('этап 5', 'handoff/notification.formatManagerNotification');
}
