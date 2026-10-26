import type { Clock, Logger, MessageSender } from '../domain/ports.js';
import type { Chat, ChatId } from '../domain/types.js';

// Отправка из конвейера: повтор после сбоя исключением и статус «печатает» на время паузы.

/** Пауза перед повтором отправки, упавшей исключением: за это время сокет успевает переподключиться. */
export const SEND_RETRY_DELAY_MS = 5_000;

/** Отправка не удалась и после повтора. */
export const SEND_FAILED = Symbol('send-failed');

/** Что нужно повтору отправки: пауза и лог. */
export interface RetryDeps {
  readonly clock: Pick<Clock, 'sleep'>;
  readonly logger: Logger;
}

/** Что нужно паузе «печатает»: статус, длина паузы по тексту, пауза и лог. */
export interface TypingDeps extends RetryDeps {
  readonly typing: Pick<MessageSender, 'setTyping'>;
  typingDelayMs(text: string): number;
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Отправка через outbox. Сбой исключением (например, старый закрытый сокет при переподключении) повторяется один раз
 * после паузы SEND_RETRY_DELAY_MS; второй сбой => ошибка в лог «клиент остался без ответа» (без номера и текста).
 */
export async function sendWithRetry<T>(
  deps: RetryDeps,
  chatId: ChatId,
  what: string,
  send: () => Promise<T>,
): Promise<T | typeof SEND_FAILED> {
  try {
    return await send();
  } catch (error: unknown) {
    deps.logger.warn(
      { chatId, errorName: errorName(error) },
      `Сбой отправки, повтор: чат #${chatId}`,
    );
  }
  await deps.clock.sleep(SEND_RETRY_DELAY_MS);
  try {
    return await send();
  } catch (error: unknown) {
    deps.logger.error(
      { chatId, errorName: errorName(error) },
      `Клиент остался без ответа: ${what}, чат #${chatId}`,
    );
    return SEND_FAILED;
  }
}

/** «Печатает» на время паузы; статус снимается и при прерванной паузе (остановка), сбой статуса только в лог. */
export async function typingPause(
  deps: TypingDeps,
  chat: Pick<Chat, 'id' | 'identity'>,
  text: string,
): Promise<void> {
  const jid = chat.identity.replyJid;
  await presence(deps, chat.id, () => deps.typing.setTyping(jid, true));
  try {
    await deps.clock.sleep(deps.typingDelayMs(text));
  } finally {
    await presence(deps, chat.id, () => deps.typing.setTyping(jid, false));
  }
}

async function presence(deps: RetryDeps, chatId: ChatId, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error: unknown) {
    deps.logger.warn({ chatId, err: error }, 'Статус «печатает» не отправлен');
  }
}
