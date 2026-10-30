import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initAuthCreds } from 'baileys';
import type { AuthenticationState, BaileysEventMap } from 'baileys';
import { describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import type { WhatsAppLinkState } from '../../../src/domain/console.js';
import type { Clock } from '../../../src/domain/ports.js';
import {
  startWhatsApp,
  type WaSocket,
  type WhatsAppDeps,
  type WhatsAppStopReason,
} from '../../../src/whatsapp/connection.js';
import { createFakeLogger, type LogEntry } from '../../helpers/fake-logger.js';

// Наблюдатель состояния сокета для консоли (WhatsAppDeps.onConnectionUpdate): только сообщает, на подключение не влияет.

const NOW = Date.UTC(2026, 9, 30, 10, 0);
const SELF_ID = '77000000009:1@s.whatsapp.net';

type Handler = (events: Partial<BaileysEventMap>) => void | Promise<void>;

interface FakeSocket {
  readonly socket: WaSocket;
  emit(events: Partial<BaileysEventMap>): void;
}

/** Сокет как в Baileys rc14: end() выдаёт пачку close и снимает обработчик. */
function fakeSocket(): FakeSocket {
  let handler: Handler | undefined;
  let closed = false;
  const emit = (events: Partial<BaileysEventMap>): void => {
    void handler?.(events);
  };
  const socket: WaSocket = {
    ev: {
      process: (next) => {
        handler = next;
        return () => {
          if (handler === next) handler = undefined;
        };
      },
      flush: () => false,
    },
    user: { id: SELF_ID },
    signalRepository: {
      lidMapping: {
        getPNForLID: () => Promise.resolve(null),
        getLIDForPN: () => Promise.resolve(null),
      },
    },
    end: (error) => {
      if (!closed) {
        closed = true;
        emit({
          'connection.update': { connection: 'close', lastDisconnect: { error, date: new Date() } },
        });
        handler = undefined;
      }
      return Promise.resolve();
    },
    sendMessage: () => Promise.resolve(undefined),
    sendPresenceUpdate: () => Promise.resolve(),
    readMessages: () => Promise.resolve(),
    getBusinessProfile: () => Promise.resolve(undefined),
    profilePictureUrl: () => Promise.resolve(undefined),
  };
  return { socket, emit };
}

/** Паузы не кончаются сами, прерываются остановкой. */
const clock: Clock = {
  now: () => NOW,
  sleep: (_ms, signal) =>
    new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        reject(new Error('Пауза прервана'));
      });
    }),
};

interface Setup {
  readonly deps: WhatsAppDeps;
  readonly sockets: FakeSocket[];
  readonly states: WhatsAppLinkState[];
  readonly logs: LogEntry[];
  readonly onStopped: Mock<(reason: WhatsAppStopReason) => void>;
}

function setup(observer?: (state: WhatsAppLinkState) => void): Setup {
  const dir = mkdtempSync(join(tmpdir(), 'tanbala-wa-state-'));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const sockets: FakeSocket[] = [];
  const states: WhatsAppLinkState[] = [];
  const logs: LogEntry[] = [];
  const onStopped = vi.fn<(reason: WhatsAppStopReason) => void>();
  const state: AuthenticationState = {
    creds: { ...initAuthCreds(), me: { id: SELF_ID } },
    keys: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
  };
  const deps: WhatsAppDeps = {
    sessionDir: join(dir, 'session'),
    logger: createFakeLogger(logs),
    clock,
    appState: {
      getLinkedAtMs: () => NOW - 60_000,
      setLinkedAtMs: () => undefined,
      markHistoryIncomplete: () => undefined,
    },
    pairingGuard: { tryBeginAttempt: () => ({ ok: true, attemptsLeft: 1 }) },
    managerPhone: null,
    testAllowlist: null,
    workingMode: null,
    backlogMaxAgeMs: 12 * 60 * 60_000,
    onEvent: () => Promise.resolve(),
    onOfflineQueueDone: () => Promise.resolve(),
    onHistoryChats: () => Promise.resolve(),
    onStopped,
    getSentText: () => Promise.resolve(null),
    onConnectionUpdate:
      observer ??
      ((next) => {
        states.push(next);
      }),
    createSocket: () => {
      const fake = fakeSocket();
      sockets.push(fake);
      return fake.socket;
    },
    loadAuthState: () => Promise.resolve({ state, saveCreds: () => Promise.resolve() }),
    fetchVersion: () => Promise.resolve({ version: [2, 3000, 1], isLatest: true }),
    presenter: { show: () => Promise.resolve(), clear: () => Promise.resolve() },
    decide: () => ({ action: 'stop', reason: 'logged_out' }),
  };
  return { deps, sockets, states, logs, onStopped };
}

function socketOf(s: Setup): FakeSocket {
  const socket = s.sockets[0];
  if (socket === undefined) throw new Error('Сокет не создан');
  return socket;
}

/** Без повторов подряд: остановка сообщает closed и сама, и через пачку close от end(). */
function changes(states: readonly WhatsAppLinkState[]): WhatsAppLinkState[] {
  return states.filter((state, index) => state !== states[index - 1]);
}

describe('WhatsApp: состояние сокета для консоли', () => {
  it('connecting и open по событиям сокета сразу при получении, closed при остановке по команде', async () => {
    const s = setup();
    const connection = await startWhatsApp(s.deps);

    socketOf(s).emit({ 'connection.update': { connection: 'connecting' } });
    socketOf(s).emit({ 'connection.update': { connection: 'open' } });
    socketOf(s).emit({ 'connection.update': { receivedPendingNotifications: true } });
    const beforeStop = [...s.states];
    await connection.stop();

    expect(beforeStop).toEqual(['connecting', 'open']);
    expect(changes(s.states)).toEqual(['connecting', 'open', 'closed']);
  });

  it('разрыв со стороны сервера: closed сразу, затем остановка адаптера', async () => {
    const s = setup();
    await startWhatsApp(s.deps);
    socketOf(s).emit({ 'connection.update': { connection: 'open' } });

    void socketOf(s).socket.end(new Error('Connection Failure'));

    expect(s.states.at(-1)).toBe('closed');
    await vi.waitFor(() => expect(s.onStopped).toHaveBeenCalledWith('logged_out'));
    expect(changes(s.states)).toEqual(['open', 'closed']);
  });

  it('наблюдатель упал: подключение работает дальше, в лог имя ошибки', async () => {
    const s = setup(() => {
      throw new TypeError('сломался');
    });
    const connection = await startWhatsApp(s.deps);

    socketOf(s).emit({ 'connection.update': { connection: 'open' } });
    await vi.waitFor(() =>
      expect(s.logs).toContainEqual(
        expect.objectContaining({ message: 'Подключение к WhatsApp открыто' }),
      ),
    );
    await connection.stop();

    expect(s.logs).toContainEqual(
      expect.objectContaining({ level: 'warn', context: { errorName: 'TypeError' } }),
    );
    expect(JSON.stringify(s.logs)).not.toContain('сломался');
  });

  it('без наблюдателя всё как раньше', async () => {
    const s = setup();
    const deps: WhatsAppDeps = { ...s.deps, onConnectionUpdate: undefined };
    const connection = await startWhatsApp(deps);

    socketOf(s).emit({ 'connection.update': { connection: 'open' } });
    await connection.stop();

    expect(s.states).toEqual([]);
  });
});
