import type { ConnectionState } from 'baileys';
import type { Clock, Logger } from '../domain/ports.js';
import type { WhatsAppStopReason } from './connection-types.js';
import type { DisconnectContext, ReconnectDecision } from './reconnect.js';

/** Счётчик разрывов подряд сбрасывается только после стольких минут связи без разрыва. */
export const STABLE_CONNECTION_MS = 5 * 60_000;
/** Не больше стольких переподключений за скользящий час: цикл open и close грозит баном. */
export const MAX_RECONNECTS_PER_HOUR = 12;

/** Код отказа WhatsApp в версии клиента. */
const VERSION_REJECTED_CODE = 405;
const HOUR_MS = 3_600_000;

/** Что делать после закрытия сокета: переподключиться после паузы или остановиться с причиной. */
export type CloseOutcome =
  | { readonly action: 'reconnect'; readonly delayMs: number }
  | { readonly action: 'stop'; readonly reason: WhatsAppStopReason };

/** Политика переподключений одного запуска: счётчик разрывов подряд и лимит в час. */
export interface ReconnectPolicy {
  /** Решение после закрытия сокета; pairing: идёт сеанс привязки по QR. */
  afterClose(update: Partial<ConnectionState>, pairing: boolean): CloseOutcome;
  /** Сокет открыт: если связь продержится STABLE_CONNECTION_MS (signal не прерван), счётчик разрывов сбросится. */
  opened(signal: AbortSignal): void;
}

/** Зависимости политики. */
export interface ReconnectPolicyDeps {
  /** whatsapp/reconnect.decideOnDisconnect или подмена в тестах. */
  readonly decide: (context: DisconnectContext) => ReconnectDecision;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * Решения после разрыва поверх whatsapp/reconnect.ts. Код 405 (WhatsApp отклонил версию) => version_rejected
 * без решения: переподключение с той же версией не поможет, сравнить с fetchLatestWaWebVersion. Сбой решения =>
 * reconnect_failed. Переподключений больше MAX_RECONNECTS_PER_HOUR за скользящий час => gave_up. Счётчик разрывов
 * подряд (DisconnectContext.attempt) не сбрасывается от одного open: только после STABLE_CONNECTION_MS связи.
 */
export function createReconnectPolicy(deps: ReconnectPolicyDeps): ReconnectPolicy {
  const { clock, logger } = deps;
  let attempt = 0;
  let reconnectsMs: readonly number[] = [];
  /** Записывает переподключение в скользящий час; false, если лимит исчерпан. */
  const reserve = (): boolean => {
    const nowMs = clock.now();
    const recent = reconnectsMs.filter((atMs) => nowMs - atMs < HOUR_MS);
    const allowed = recent.length < MAX_RECONNECTS_PER_HOUR;
    reconnectsMs = allowed ? [...recent, nowMs] : recent;
    return allowed;
  };
  return {
    afterClose(update: Partial<ConnectionState>, pairing: boolean): CloseOutcome {
      attempt += 1;
      const context: DisconnectContext = { code: disconnectCode(update), attempt, pairing };
      if (context.code === VERSION_REJECTED_CODE) {
        logger.error(
          { ...context },
          'WhatsApp отклонил версию клиента: сравнить с fetchLatestWaWebVersion',
        );
        return { action: 'stop', reason: 'version_rejected' };
      }
      const decision = decideSafely(deps, context);
      if (decision.action === 'reconnect' && !reserve()) {
        logger.error({ limit: MAX_RECONNECTS_PER_HOUR }, 'Слишком много переподключений за час');
        return { action: 'stop', reason: 'gave_up' };
      }
      return decision;
    },
    opened(signal: AbortSignal): void {
      clock.sleep(STABLE_CONNECTION_MS, signal).then(
        () => {
          attempt = 0;
        },
        // Сокет закрылся раньше: связь нестабильна, счётчик разрывов не сбрасывается.
        () => undefined,
      );
    },
  };
}

function decideSafely(deps: ReconnectPolicyDeps, context: DisconnectContext): CloseOutcome {
  try {
    const decision = deps.decide(context);
    deps.logger.warn({ ...context, action: decision.action }, 'Соединение с WhatsApp закрыто');
    return decision;
  } catch (error: unknown) {
    deps.logger.error(
      { err: error, ...context },
      'Не удалось решить, переподключаться ли к WhatsApp',
    );
    return { action: 'stop', reason: 'reconnect_failed' };
  }
}

/** Код DisconnectReason: (lastDisconnect.error as Boom).output.statusCode. */
function disconnectCode(update: Partial<ConnectionState>): number | undefined {
  const error = update.lastDisconnect?.error as { output?: { statusCode?: unknown } } | undefined;
  const statusCode = error?.output?.statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}
