import { DisconnectReason } from 'baileys';

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
  /**
   * Номер попытки переподключения подряд, с 1: первый разрыв после connection 'open' (или первый
   * разрыв вообще) => 1, следующий разрыв без успешного подключения => 2. Целое не меньше 1,
   * иначе stop 'gave_up'.
   */
  readonly attempt: number;
  /** Идёт сеанс привязки по QR: номер ещё не привязан, событие pair-success не пришло. */
  readonly pairing: boolean;
}

/** Пауза перед первой попыткой переподключения; дальше она удваивается с каждой попыткой. */
export const RECONNECT_BASE_DELAY_MS = 1_000;

/** Потолок паузы между переподключениями. */
export const RECONNECT_MAX_DELAY_MS = 30_000;

/** Последняя допустимая попытка подряд (около трёх минут ожидания всего); следующая => stop 'gave_up'. */
export const RECONNECT_MAX_ATTEMPTS = 10;

type StopReason = Extract<ReconnectDecision, { readonly action: 'stop' }>['reason'];

/**
 * Коды, после которых не переподключаемся: цикл переподключений повышает риск бана.
 * Сессию не удалять: новая привязка только по команде владельца.
 */
const FINAL_CODES = new Map<number, StopReason>([
  [DisconnectReason.loggedOut, 'logged_out'],
  [DisconnectReason.forbidden, 'forbidden'],
  [DisconnectReason.connectionReplaced, 'replaced'],
]);

const RESTART_REQUIRED: number = DisconnectReason.restartRequired;

/**
 * Решает, переподключаться ли после разрыва. Чистая функция.
 * 401 loggedOut, 403 forbidden, 440 connectionReplaced => stop: 'logged_out', 'forbidden', 'replaced'.
 * Во время привязки любой код, кроме 515, => stop 'pairing_timeout': 408 значит, что QR истёк и никто
 * не отсканировал, а при обрыве связи новый сокет сам покажет QR без команды владельца и истратит вторую
 * попытку привязки (не больше двух за 24 часа). Новый сеанс привязки только по команде владельца.
 * 515 restartRequired => reconnect без паузы, новым сокетом (по опыту сообщества, код ожидаем сразу после
 * pair-success; на 25.10.2026): это продолжение того же сеанса привязки, новой попыткой не считается.
 * 408 вне привязки, 428, 500, 503 и прочие => reconnect с паузой 1, 2, 4, 8, 16, затем 30 с.
 * Предел попыток действует и на 515; после него stop 'gave_up'.
 * Разрыв с кодом 500 каждые 50 минут у части аккаунтов: известная проблема Baileys (issue #2858,
 * на 25.10.2026); после успешного подключения счётчик попыток обнуляется, и предел не копится.
 */
export function decideOnDisconnect(context: DisconnectContext): ReconnectDecision {
  const { code, attempt, pairing } = context;
  const finalReason = code === undefined ? undefined : FINAL_CODES.get(code);
  if (finalReason !== undefined) return { action: 'stop', reason: finalReason };
  const restartRequired = code === RESTART_REQUIRED;
  if (pairing && !restartRequired) return { action: 'stop', reason: 'pairing_timeout' };
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > RECONNECT_MAX_ATTEMPTS) {
    return { action: 'stop', reason: 'gave_up' };
  }
  return { action: 'reconnect', delayMs: restartRequired ? 0 : backoffDelayMs(attempt) };
}

/** 1 с на первой попытке, дальше вдвое больше, но не больше потолка. */
function backoffDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
}
