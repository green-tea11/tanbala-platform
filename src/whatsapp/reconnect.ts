import { notImplemented } from '../shared/todo.js';

/** Что делать после разрыва соединения WhatsApp. */
export type ReconnectDecision =
  | { readonly action: 'reconnect'; readonly delayMs: number }
  | {
      readonly action: 'stop';
      readonly reason: 'logged_out' | 'replaced' | 'forbidden' | 'gave_up' | 'pairing_timeout';
    };

/** Обстоятельства разрыва. */
export interface DisconnectContext {
  /** statusCode из lastDisconnect (значения DisconnectReason в Baileys 7). */
  readonly code: number | undefined;
  /** Номер попытки переподключения подряд. */
  readonly attempt: number;
  /** Идёт сеанс привязки по QR: номер ещё не привязан, событие pair-success не пришло. */
  readonly pairing: boolean;
}

/**
 * Решает, переподключаться ли после разрыва. Чистая функция.
 * TODO(этап 2): pairing и код 408 (QR истёк, никто не отсканировал) => stop 'pairing_timeout' без переподключения: иначе новый сокет сам покажет QR без команды владельца и истратит вторую попытку привязки (не больше двух за 24 часа). Новый сеанс привязки только по команде владельца.
 * TODO(этап 2): 401 loggedOut => stop 'logged_out'; сессию не удалять, новая привязка только по команде владельца.
 * TODO(этап 2): 440 connectionReplaced => stop 'replaced'; 403 forbidden => stop 'forbidden'. Цикл переподключений повышает риск бана.
 * TODO(этап 2): 515 restartRequired => reconnect без паузы, новым сокетом (по опыту сообщества, код ожидаем сразу после pair-success; на 25.10.2026); это продолжение того же сеанса привязки, новой попыткой не считается.
 * TODO(этап 2): 408 вне привязки, 428, 500, 503 и прочие => reconnect с растущей паузой до 30 с; после потолка попыток stop 'gave_up'.
 * TODO(этап 2): разрыв с кодом 500 каждые 50 минут у части аккаунтов: известная проблема Baileys (issue #2858, на 25.10.2026).
 */
export function decideOnDisconnect(context: DisconnectContext): ReconnectDecision {
  return notImplemented('этап 2', 'whatsapp/reconnect.decideOnDisconnect');
}
