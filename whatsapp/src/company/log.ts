import type { Logger } from '../domain/ports.js';
import type { ChatId } from '../domain/types.js';

/**
 * Сбой запроса о компании в лог: только ID чата, шаг и код сбоя. Имена, названия компаний, домены, номера и
 * тексты клиента сюда не передаются.
 */
export function logFailure(logger: Logger, chatId: ChatId, step: string, failure: string): void {
  logger.warn(
    { chatId, step, failure },
    'Запрос о компании не удался: бот работает без этих данных',
  );
}
