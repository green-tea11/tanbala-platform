import { notImplemented } from '../shared/todo.js';

/** Что делать после разрыва соединения WhatsApp. */
export type ReconnectDecision =
  | { readonly action: 'reconnect'; readonly delayMs: number }
  | {
      readonly action: 'stop';
      readonly reason: 'logged_out' | 'replaced' | 'forbidden' | 'gave_up';
    };

/**
 * Решает, переподключаться ли после разрыва. Чистая функция.
 * code: statusCode из lastDisconnect (значения DisconnectReason в Baileys 7); attempt: номер попытки подряд.
 * TODO(этап 2): 401 loggedOut => stop 'logged_out'; сессию не удалять, новая привязка только по команде владельца.
 * TODO(этап 2): 440 connectionReplaced => stop 'replaced'; 403 forbidden => stop 'forbidden'. Цикл переподключений повышает риск бана.
 * TODO(этап 2): 515 restartRequired => reconnect без паузы, новым сокетом (по опыту сообщества, код ожидаем сразу после привязки; на 25.10.2026).
 * TODO(этап 2): 408, 428, 500, 503 и прочие => reconnect с растущей паузой до 30 с; после потолка попыток stop 'gave_up'.
 * TODO(этап 2): разрыв с кодом 500 каждые 50 минут у части аккаунтов: известная проблема Baileys (issue #2858, на 25.10.2026).
 */
export function decideOnDisconnect(code: number | undefined, attempt: number): ReconnectDecision {
  return notImplemented('этап 2', 'whatsapp/reconnect.decideOnDisconnect');
}
