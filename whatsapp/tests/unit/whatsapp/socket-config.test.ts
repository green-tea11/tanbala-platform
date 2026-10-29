import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  initAuthCreds,
  proto,
  type AuthenticationState,
  type UserFacingSocketConfig,
} from 'baileys';
import type { Clock, Logger } from '../../../src/domain/ports.js';
import type { Jid, WaMessageId } from '../../../src/domain/types.js';
import type { FetchedVersion } from '../../../src/whatsapp/connection-types.js';
import {
  buildSocketConfig,
  fetchVersionWithTimeout,
  VERSION_FETCH_TIMEOUT_MS,
} from '../../../src/whatsapp/socket-config.js';

const CLIENT_PN = '77000000002@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const VERSION: FetchedVersion = { version: [2, 3000, 1_000_000_001], isLatest: true };

interface LogEntry {
  readonly level: string;
  readonly context: Readonly<Record<string, unknown>>;
}

interface ChildCall {
  readonly bindings: Readonly<Record<string, unknown>>;
  readonly options: { level?: string } | undefined;
  readonly logger: Logger;
}

function createLogger(entries: LogEntry[], children: ChildCall[] = []): Logger {
  const log =
    (level: string) =>
    (context: Readonly<Record<string, unknown>>): void => {
      entries.push({ level, context });
    };
  return {
    level: 'info',
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    fatal: log('fatal'),
    silent: log('silent'),
    child: (bindings, options) => {
      const logger = createLogger(entries, children);
      children.push({ bindings, options, logger });
      return logger;
    },
  };
}

function createState(): AuthenticationState {
  return { creds: initAuthCreds(), keys: { get: () => ({}), set: () => undefined } };
}

interface ConfigSetup {
  readonly entries: LogEntry[];
  readonly children: ChildCall[];
  readonly getSentText: Mock<(waId: WaMessageId, jid: Jid) => Promise<string | null>>;
  readonly state: AuthenticationState;
  readonly config: UserFacingSocketConfig;
}

function setupConfig(version: FetchedVersion['version'] | null = VERSION.version): ConfigSetup {
  const entries: LogEntry[] = [];
  const children: ChildCall[] = [];
  const getSentText = vi.fn<(waId: WaMessageId, jid: Jid) => Promise<string | null>>(() =>
    Promise.resolve(null),
  );
  const state = createState();
  const config = buildSocketConfig({
    state,
    version,
    deps: { logger: createLogger(entries, children), getSentText },
  });
  return { entries, children, getSentText, state, config };
}

/** Часы, у которых пауза завершается только по команде теста. */
function createManualClock(): { clock: Clock; finish(): void; signal(): AbortSignal | undefined } {
  let finish: () => void = () => undefined;
  let lastSignal: AbortSignal | undefined;
  return {
    clock: {
      now: () => 0,
      sleep: (_ms, signal) => {
        lastSignal = signal;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    },
    finish: () => finish(),
    signal: () => lastSignal,
  };
}

describe('whatsapp/socket-config: настройки сокета', () => {
  it('сессия, версия, Ubuntu Chrome, логгер Baileys warn, без статуса «в сети» и полной истории', () => {
    const { config, state, children } = setupConfig();

    const baileysLogger = children.find((child) => child.bindings['module'] === 'baileys');
    expect(config.auth).toBe(state);
    expect(config.version).toEqual(VERSION.version);
    expect(config.browser).toEqual(['Ubuntu', 'Chrome', '22.04.4']);
    expect(baileysLogger?.options).toEqual({ level: 'warn' });
    expect(config.logger).toBe(baileysLogger?.logger);
    expect(config.markOnlineOnConnect).toBe(false);
    expect(config.syncFullHistory).toBe(false);
  });

  it('shouldIgnoreJid не задан: отсеянный JID Baileys rc14 отвечал бы NACK на каждое сообщение', () => {
    expect('shouldIgnoreJid' in setupConfig().config).toBe(false);
  });

  it('версии нет: поле version не передаётся, её выберет Baileys', () => {
    expect('version' in setupConfig(null).config).toBe(false);
  });

  it('история не отключается целиком: Baileys получает сопоставления @lid, кроме полной истории', () => {
    const shouldSync = setupConfig().config.shouldSyncHistoryMessage;
    const types = proto.Message.HistorySyncType;

    expect(shouldSync?.({ syncType: types.INITIAL_BOOTSTRAP })).toBe(true);
    expect(shouldSync?.({ syncType: types.RECENT })).toBe(true);
    expect(shouldSync?.({ syncType: types.PUSH_NAME })).toBe(true);
    expect(shouldSync?.({ syncType: types.FULL })).toBe(false);
  });

  it('getMessage отдаёт текст отправленного сообщения по ID и чату без суффикса устройства', async () => {
    const { config, getSentText } = setupConfig();
    getSentText.mockResolvedValue('Добрый день');

    const message = config.getMessage?.({ id: 'OUT1', remoteJid: '77000000002:4@s.whatsapp.net' });

    await expect(message).resolves.toEqual({ conversation: 'Добрый день' });
    expect(getSentText).toHaveBeenCalledWith('OUT1', CLIENT_PN);
  });

  it.each([
    ['текста нет в outbound_ids', { id: 'OUT1', remoteJid: CLIENT_PN }, 'null'],
    ['чтение упало', { id: 'OUT1', remoteJid: CLIENT_PN }, 'throw'],
    ['адрес не личный', { id: 'OUT1', remoteJid: GROUP }, 'skip'],
    ['нет ID', { remoteJid: CLIENT_PN }, 'skip'],
  ] as const)('getMessage ничего не отдаёт: %s', async (_case, key, mode) => {
    const { config, getSentText, entries } = setupConfig();
    if (mode === 'throw') getSentText.mockRejectedValue(new Error('база закрыта'));

    await expect(config.getMessage?.(key)).resolves.toBeUndefined();

    expect(getSentText).toHaveBeenCalledTimes(mode === 'skip' ? 0 : 1);
    expect(entries.some((entry) => entry.level === 'warn')).toBe(mode === 'throw');
  });
});

describe('whatsapp/socket-config: версия WhatsApp Web', () => {
  it('свежая версия: без предупреждений, пауза таймаута снимается', async () => {
    const entries: LogEntry[] = [];
    const manual = createManualClock();

    const version = await fetchVersionWithTimeout(() => Promise.resolve(VERSION), {
      clock: manual.clock,
      logger: createLogger(entries),
    });

    expect(version).toEqual(VERSION.version);
    expect(entries).toEqual([]);
    expect(manual.signal()?.aborted).toBe(true);
  });

  it('встроенная версия Baileys (isLatest: false): warn с версией, версия передаётся', async () => {
    const entries: LogEntry[] = [];

    const version = await fetchVersionWithTimeout(
      () => Promise.resolve({ version: [2, 3000, 7], isLatest: false }),
      { clock: createManualClock().clock, logger: createLogger(entries) },
    );

    expect(version).toEqual([2, 3000, 7]);
    expect(entries).toEqual([{ level: 'warn', context: { version: '2.3000.7' } }]);
  });

  it('сбой получения версии: warn и null, версию выберет Baileys', async () => {
    const entries: LogEntry[] = [];

    const version = await fetchVersionWithTimeout(() => Promise.reject(new Error('нет сети')), {
      clock: createManualClock().clock,
      logger: createLogger(entries),
    });

    expect(version).toBeNull();
    expect(entries).toContainEqual(expect.objectContaining({ level: 'warn' }));
  });

  it('версия не пришла за отведённое время: warn с таймаутом и null', async () => {
    const entries: LogEntry[] = [];
    const manual = createManualClock();

    const pending = fetchVersionWithTimeout(() => new Promise<FetchedVersion>(() => undefined), {
      clock: manual.clock,
      logger: createLogger(entries),
    });
    manual.finish();

    await expect(pending).resolves.toBeNull();
    expect(entries).toEqual([{ level: 'warn', context: { timeoutMs: VERSION_FETCH_TIMEOUT_MS } }]);
  });
});
