import {
  Browsers,
  proto,
  type AuthenticationState,
  type UserFacingSocketConfig,
  type WAMessageKey,
  type WAVersion,
} from 'baileys';
import type { WaMessageId } from '../domain/types.js';
import type { FetchedVersion, WhatsAppDeps } from './connection-types.js';
import { jidOf } from './lid-resolver.js';

/** Сколько ждать версию WhatsApp Web с GitHub: дальше встроенная версия Baileys, чтобы запуск не завис. */
export const VERSION_FETCH_TIMEOUT_MS = 10_000;

/** Что нужно для настроек сокета. */
export interface SocketConfigOptions {
  readonly state: AuthenticationState;
  /** null: версию выберет сам Baileys (встроенная). */
  readonly version: WAVersion | null;
  readonly deps: Pick<WhatsAppDeps, 'logger' | 'getSentText'>;
}

/**
 * Настройки сокета Baileys. Browsers.ubuntu('Chrome') по опыту сообщества на 25.10.2026 ('Desktop' меняет тип
 * клиента-компаньона); markOnlineOnConnect: false, иначе телефон не получает уведомлений; syncFullHistory: false,
 * но синхронизация истории не отключается целиком (иначе Baileys не получит начальные сопоставления @lid),
 * отклоняется только FULL. shouldIgnoreJid не задаётся: на сообщение отсеянного JID Baileys rc14 отвечает NACK,
 * а группы и статусы отсекает whatsapp/inbound.ts после обычного приёма. Логгер Baileys warn: на debug и trace
 * он пишет протокол и содержимое сообщений. getMessage отдаёт текст отправленного сообщения для повторной отправки.
 */
export function buildSocketConfig(options: SocketConfigOptions): UserFacingSocketConfig {
  const { state, version, deps } = options;
  return {
    auth: state,
    ...(version === null ? {} : { version }),
    browser: Browsers.ubuntu('Chrome'),
    logger: deps.logger.child({ module: 'baileys' }, { level: 'warn' }),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: ({ syncType }) => syncType !== proto.Message.HistorySyncType.FULL,
    getMessage: (key) => sentMessage(deps, key),
  };
}

/** Текст отправленного сообщения по ID и чату (outbound_ids); нет, чужой чат или сбой => undefined. */
async function sentMessage(
  deps: Pick<WhatsAppDeps, 'logger' | 'getSentText'>,
  key: WAMessageKey,
): Promise<proto.IMessage | undefined> {
  const jid = jidOf(key.remoteJid);
  if (jid === null || !key.id) return undefined;
  try {
    const text = await deps.getSentText(key.id as WaMessageId, jid);
    return text === null ? undefined : { conversation: text };
  } catch (error: unknown) {
    deps.logger.warn({ err: error }, 'Отправленное сообщение для повторной отправки не найдено');
    return undefined;
  }
}

/**
 * Версия WhatsApp Web: fetchLatestBaileysVersion берёт её из ветки master Baileys на GitHub и при сбое молча отдаёт
 * встроенную (isLatest: false => warn). Сбой или нет ответа за VERSION_FETCH_TIMEOUT_MS => null и warn: версию
 * выберет Baileys. Если WhatsApp отклонит версию (код 405), сравнить с fetchLatestWaWebVersion.
 */
export async function fetchVersionWithTimeout(
  fetchVersion: () => Promise<FetchedVersion>,
  deps: Pick<WhatsAppDeps, 'clock' | 'logger'>,
): Promise<WAVersion | null> {
  const timer = new AbortController();
  const timeout = deps.clock.sleep(VERSION_FETCH_TIMEOUT_MS, timer.signal).then(
    () => null,
    // Пауза снята: версия пришла раньше, таймаут больше не нужен.
    () => null,
  );
  try {
    const fetched = await Promise.race([fetchVersion(), timeout]);
    if (fetched === null) {
      deps.logger.warn(
        { timeoutMs: VERSION_FETCH_TIMEOUT_MS },
        'Версия WhatsApp Web не пришла вовремя',
      );
      return null;
    }
    if (!fetched.isLatest) {
      deps.logger.warn(
        { version: fetched.version.join('.') },
        'Используется встроенная версия Baileys',
      );
    }
    return fetched.version;
  } catch (error: unknown) {
    deps.logger.warn({ err: error }, 'Версия WhatsApp Web не получена: её выберет Baileys');
    return null;
  } finally {
    timer.abort();
  }
}
