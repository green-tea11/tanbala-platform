import type { Clock, Logger, ManagerNotificationsRepo } from '../domain/ports.js';
import type {
  ChatId,
  HandoffReason,
  ManagerNotification,
  ManagerNotificationKind,
  ManagerNotificationStatus,
  WaMessageId,
} from '../domain/types.js';
import type { Outbox } from '../messaging/outbox.js';

/** Сколько раз пробуют отправить одно уведомление: первая отправка и повторы вместе (решение владельца). */
export const NOTIFY_MAX_ATTEMPTS = 5;

/** Запись pending старше этого срока считается зависшей: процесс упал между записью и итогом отправки. */
export const NOTIFY_STALE_PENDING_MS = 5 * 60 * 1000;

/** Записей за один проход повтора; остальные уйдут в следующий проход. */
export const NOTIFY_RETRY_BATCH = 20;

/** Зависимости отправки уведомлений менеджеру. */
export interface ManagerNotifierDeps {
  notifications: ManagerNotificationsRepo;
  /** Единственный путь на номер менеджера; managerJid и квоты по видам внутри него. */
  outbox: Pick<Outbox, 'notifyManager'>;
  clock: Clock;
  logger: Logger;
}

/** Чем вызвано уведомление: попадает только в строки лога. Данных клиента здесь нет. */
export interface NotifyContext {
  readonly reason?: HandoffReason;
}

/** Отправка уведомлений менеджеру с записью каждого в базу и повтором при сбое. */
export interface ManagerNotifier {
  /**
   * Записывает уведомление в manager_notifications (статус pending, текст целиком), затем отправляет его через
   * outbox.notifyManager и пишет итог: sent, no_manager (MANAGER_WHATSAPP не задан), skipped_limit (квота вида
   * исчерпана) или failed (исключение отправки). Итог возвращается; сбой отправки наружу не бросается, его повторит
   * retryFailed. Бросает только когда уведомление не записалось в базу: тогда ничего не отправлялось.
   * Без номера менеджера в лог уходит одна строка warn без имени, номера и текста: ID чата, вид, причина, «текст в панели».
   */
  notify(
    kind: ManagerNotificationKind,
    chatId: ChatId | null,
    text: string,
    context?: NotifyContext,
  ): Promise<ManagerNotificationStatus>;
  /**
   * Повторяет отправку: записи failed и зависшие pending (старше NOTIFY_STALE_PENDING_MS), у которых меньше
   * NOTIFY_MAX_ATTEMPTS попыток. no_manager и skipped_limit не повторяются: они остаются в панели. Вызывается раз
   * в 5 минут и после подключения к WhatsApp. Возвращает число сделанных попыток. Не бросает: сбой чтения очереди
   * пишется в лог, а проход, который уже идёт, второй проход не запускает.
   */
  retryFailed(): Promise<number>;
}

type Settled = Exclude<ManagerNotificationStatus, 'pending'>;

/** Итог одной попытки: то, что записывается в manager_notifications. */
interface Outcome {
  readonly status: Settled;
  readonly waId: WaMessageId | null;
}

/** Запись, которую отправляют; attempts: сколько попыток уже записано. */
type Delivery = Pick<ManagerNotification, 'id' | 'kind' | 'chatId' | 'text' | 'attempts'> & {
  readonly reason?: HandoffReason;
};

type Deliver = (entry: Delivery) => Promise<Settled>;

/**
 * Создаёт отправку уведомлений менеджеру. Каждое уведомление сначала пишется в базу, потому что панель показывает
 * его и при пустом MANAGER_WHATSAPP, а сбой отправки не должен его терять. Запись, которая отправляется прямо сейчас
 * в этом процессе, повтором не берётся, даже если зависла дольше срока: дубль менеджеру хуже задержки.
 */
export function createManagerNotifier(deps: ManagerNotifierDeps): ManagerNotifier {
  const inFlight = new Set<number>();
  let retrying = false;
  const deliver: Deliver = async (entry) => {
    inFlight.add(entry.id);
    try {
      const outcome = await send(deps, entry);
      record(deps, entry, outcome);
      return outcome.status;
    } finally {
      inFlight.delete(entry.id);
    }
  };
  return {
    notify: async (kind, chatId, text, context) => {
      const id = deps.notifications.add({ kind, chatId, text, nowMs: deps.clock.now() });
      return await deliver({ id, kind, chatId, text, attempts: 0, reason: context?.reason });
    },
    retryFailed: async () => {
      if (retrying) return 0;
      retrying = true;
      try {
        return await retryBatch(deps, inFlight, deliver);
      } catch (error: unknown) {
        deps.logger.error({ err: error }, 'Повтор отправки уведомлений менеджеру не выполнен');
        return 0;
      } finally {
        retrying = false;
      }
    },
  };
}

async function retryBatch(
  deps: ManagerNotifierDeps,
  inFlight: ReadonlySet<number>,
  deliver: Deliver,
): Promise<number> {
  const waiting = deps.notifications.listRetryable({
    maxAttempts: NOTIFY_MAX_ATTEMPTS,
    staleBeforeMs: deps.clock.now() - NOTIFY_STALE_PENDING_MS,
    limit: NOTIFY_RETRY_BATCH,
  });
  let attempted = 0;
  let sent = 0;
  for (const entry of waiting) {
    if (inFlight.has(entry.id)) continue;
    attempted += 1;
    if ((await deliver(entry)) === 'sent') sent += 1;
  }
  if (attempted > 0) {
    deps.logger.info({ attempted, sent }, 'Повтор отправки уведомлений менеджеру');
  }
  return attempted;
}

/** Одна попытка отправки. Сбой отправки становится итогом failed, а не исключением. */
async function send(deps: ManagerNotifierDeps, entry: Delivery): Promise<Outcome> {
  try {
    const result = await deps.outbox.notifyManager(entry.text, entry.kind);
    logResult(deps.logger, entry, result.status);
    return { status: result.status, waId: result.status === 'sent' ? result.waId : null };
  } catch (error: unknown) {
    const attempt = entry.attempts + 1;
    deps.logger.error(
      { err: error, ...logContext(entry), attempt, willRetry: attempt < NOTIFY_MAX_ATTEMPTS },
      'Уведомление менеджеру не отправлено: сбой отправки',
    );
    return { status: 'failed', waId: null };
  }
}

/** Итог попытки в базу. Сбой записи в лог: уведомление при этом уже ушло или останется pending и уйдёт повтором. */
function record(deps: ManagerNotifierDeps, entry: Delivery, outcome: Outcome): void {
  try {
    deps.notifications.setResult(entry.id, outcome, deps.clock.now());
  } catch (error: unknown) {
    deps.logger.error(
      { err: error, ...logContext(entry) },
      'Итог отправки уведомления менеджеру не записан в базу',
    );
  }
}

function logResult(
  logger: Logger,
  entry: Delivery,
  status: 'sent' | 'no_manager' | 'skipped_limit',
): void {
  const context = logContext(entry);
  if (status === 'sent') {
    logger.info(context, 'Уведомление менеджеру отправлено');
  } else if (status === 'no_manager') {
    logger.warn(
      context,
      'Уведомление менеджеру не отправлено: MANAGER_WHATSAPP не задан, текст в панели',
    );
  } else {
    logger.warn(
      context,
      'Уведомление менеджеру не отправлено: исчерпана часовая квота, текст в панели',
    );
  }
}

/** Контекст строки лога: только ID, вид и причина. Имя, номер и текст сюда не попадают. */
function logContext(entry: Delivery): Readonly<Record<string, unknown>> {
  const base = { notificationId: entry.id, kind: entry.kind, chatId: entry.chatId };
  return entry.reason === undefined ? base : { ...base, reason: entry.reason };
}
