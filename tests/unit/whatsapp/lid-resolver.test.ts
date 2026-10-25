import { describe, expect, it, vi, type Mock } from 'vitest';
import type { WAMessageKey } from 'baileys';
import type { Logger } from '../../../src/domain/ports.js';
import type { PhoneDigits } from '../../../src/domain/types.js';
import type { WaSocket } from '../../../src/whatsapp/connection-types.js';
import { createLidResolver, jidOf } from '../../../src/whatsapp/lid-resolver.js';

const BOT_ID = '77000000001:12@s.whatsapp.net';
const BOT_LID = '100000000000001:12@lid';
const BOT_PHONE = '77000000001';
const CLIENT_PHONE = '77000000002';
const CLIENT_PN = '77000000002@s.whatsapp.net';
const CLIENT_LID = '200000000000002@lid';
const GROUP = '120363000000000001@g.us';
const MANAGER_PHONE = '77000000003' as PhoneDigits;
const MANAGER_PN = '77000000003@s.whatsapp.net';

interface LogEntry {
  readonly level: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly message: string | undefined;
}

function createLogger(entries: LogEntry[]): Logger {
  const log =
    (level: string) =>
    (context: Readonly<Record<string, unknown>>, message?: string): void => {
      entries.push({ level, context, message });
    };
  const logger: Logger = {
    level: 'info',
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    fatal: log('fatal'),
    silent: log('silent'),
    child: () => logger,
  };
  return logger;
}

interface SocketOptions {
  readonly user?: WaSocket['user'];
  readonly pnForLid?: Readonly<Record<string, string>>;
  readonly lidForPn?: Readonly<Record<string, string>>;
  readonly broken?: boolean;
}

type LookupMock = Mock<(jid: string) => Promise<string | null>>;

interface TestSocket extends Pick<WaSocket, 'user' | 'signalRepository'> {
  readonly getPNForLID: LookupMock;
  readonly getLIDForPN: LookupMock;
}

function createSocket(options: SocketOptions = {}): TestSocket {
  const answer = (book: Readonly<Record<string, string>> | undefined, jid: string) =>
    options.broken === true
      ? Promise.reject(new Error(`нет ключей для ${jid}`))
      : Promise.resolve(book?.[jid] ?? null);
  const getPNForLID: LookupMock = vi.fn((lid: string) => answer(options.pnForLid, lid));
  const getLIDForPN: LookupMock = vi.fn((pn: string) => answer(options.lidForPn, pn));
  return {
    user: 'user' in options ? options.user : { id: BOT_ID, lid: BOT_LID },
    signalRepository: { lidMapping: { getPNForLID, getLIDForPN } },
    getPNForLID,
    getLIDForPN,
  };
}

function key(fields: Partial<WAMessageKey>): WAMessageKey {
  return { id: 'm1', fromMe: false, ...fields };
}

const CLIENT_MAPPING = { [CLIENT_LID]: '77000000002:7@s.whatsapp.net' };

describe('whatsapp/lid-resolver: jidOf', () => {
  it.each([
    ['снимает суффикс устройства', '77000000002:5@s.whatsapp.net', CLIENT_PN],
    ['@lid остаётся @lid', CLIENT_LID, CLIENT_LID],
    ['hosted сводится к адресу с номером', '77000000002:99@hosted', CLIENT_PN],
    ['группа не личный чат', GROUP, null],
    ['пустая строка', '', null],
    ['null', null, null],
    ['undefined', undefined, null],
  ])('%s', (_case, raw, expected) => {
    expect(jidOf(raw)).toBe(expected);
  });
});

describe('whatsapp/lid-resolver: свой номер', () => {
  it('номер и адреса бота берутся из sock.user без суффикса устройства', () => {
    const resolver = createLidResolver(createSocket(), createLogger([]));

    expect(resolver.botPhone()).toBe(BOT_PHONE);
    expect(resolver.selfJids()).toEqual(
      new Set(['77000000001@s.whatsapp.net', '100000000000001@lid']),
    );
  });

  it('номер ещё не привязан: своего номера и адресов нет', () => {
    const resolver = createLidResolver(createSocket({ user: undefined }), createLogger([]));

    expect(resolver.botPhone()).toBeNull();
    expect(resolver.selfJids()).toEqual(new Set());
  });

  it('sock.user читается при каждом вызове: после входа номер появляется', () => {
    const socket = { ...createSocket({ user: undefined }) };
    const resolver = createLidResolver(socket, createLogger([]));

    Object.assign(socket, { user: { id: BOT_ID } });

    expect(resolver.botPhone()).toBe(BOT_PHONE);
    expect(resolver.selfJids()).toEqual(new Set(['77000000001@s.whatsapp.net']));
  });
});

describe('whatsapp/lid-resolver: номер собеседника для разбора', () => {
  it.each([
    ['адрес с номером: из самого remoteJid', { remoteJid: CLIENT_PN, remoteJidAlt: CLIENT_LID }],
    ['@lid клиента: из remoteJidAlt', { remoteJid: CLIENT_LID, remoteJidAlt: CLIENT_PN }],
    [
      'суффикс устройства в remoteJidAlt снимается',
      { remoteJid: CLIENT_LID, remoteJidAlt: '77000000002:3@s.whatsapp.net' },
    ],
    ['@lid без remoteJidAlt: через getPNForLID без «:N»', { remoteJid: CLIENT_LID }],
    ['hosted @lid сводится к @lid', { remoteJid: '200000000000002@hosted.lid' }],
    [
      'своё сообщение: через getPNForLID, а не из remoteJidAlt',
      { remoteJid: CLIENT_LID, remoteJidAlt: BOT_ID, fromMe: true },
    ],
  ] as const)('%s', async (_case, fields) => {
    const resolver = createLidResolver(
      createSocket({ pnForLid: CLIENT_MAPPING }),
      createLogger([]),
    );

    await expect(resolver.chatPhone(key(fields))).resolves.toBe(CLIENT_PHONE);
  });

  it.each([
    ['@lid без сопоставления', { remoteJid: CLIENT_LID }],
    [
      'своё сообщение без сопоставления: номер бота из remoteJidAlt не берётся',
      { remoteJid: CLIENT_LID, remoteJidAlt: BOT_ID, fromMe: true },
    ],
    ['чат с самим собой: номер бота отбрасывается', { remoteJid: '77000000001@s.whatsapp.net' }],
    ['@lid, сопоставленный номеру бота', { remoteJid: '300000000000009@lid' }],
    ['группа', { remoteJid: GROUP }],
    ['адреса нет', { remoteJid: null }],
  ] as const)('номер не определён: %s', async (_case, fields) => {
    const socket = createSocket({ pnForLid: { '300000000000009@lid': BOT_ID } });
    const resolver = createLidResolver(socket, createLogger([]));

    await expect(resolver.chatPhone(key(fields))).resolves.toBeNull();
  });

  it('у адреса с номером сопоставление не запрашивается', async () => {
    const socket = createSocket({ pnForLid: CLIENT_MAPPING });
    const resolver = createLidResolver(socket, createLogger([]));

    await resolver.chatPhone(key({ remoteJid: CLIENT_LID, remoteJidAlt: CLIENT_PN }));

    expect(socket.getPNForLID).not.toHaveBeenCalled();
  });

  it('сбой сопоставления: номер null, в логе только тип ошибки без адреса', async () => {
    const entries: LogEntry[] = [];
    const resolver = createLidResolver(createSocket({ broken: true }), createLogger(entries));

    await expect(resolver.chatPhone(key({ remoteJid: CLIENT_LID }))).resolves.toBeNull();

    expect(entries).toContainEqual(
      expect.objectContaining({ level: 'warn', context: { err: 'Error' } }),
    );
    expect(JSON.stringify(entries)).not.toContain('200000000000002');
  });
});

describe('whatsapp/lid-resolver: отказ сопоставления не объектом Error', () => {
  it('в лог только тип значения, номер null', async () => {
    const entries: LogEntry[] = [];
    const socket = createSocket();
    socket.getPNForLID.mockRejectedValue('нет ключей');
    const resolver = createLidResolver(socket, createLogger(entries));

    await expect(resolver.phoneOf(CLIENT_LID)).resolves.toBeNull();

    expect(entries).toContainEqual(
      expect.objectContaining({ level: 'warn', context: { err: 'string' } }),
    );
  });
});

describe('whatsapp/lid-resolver: номер для адреса и адреса менеджера', () => {
  it('phoneOf: из адреса с номером, через getPNForLID для @lid; иначе null', async () => {
    const resolver = createLidResolver(
      createSocket({ pnForLid: CLIENT_MAPPING }),
      createLogger([]),
    );

    await expect(resolver.phoneOf(CLIENT_PN)).resolves.toBe(CLIENT_PHONE);
    await expect(resolver.phoneOf(CLIENT_LID)).resolves.toBe(CLIENT_PHONE);
    await expect(resolver.phoneOf('999@lid')).resolves.toBeNull();
    await expect(resolver.phoneOf(GROUP)).resolves.toBeNull();
  });

  it('managerJids: номер и @lid без суффикса устройства', async () => {
    const socket = createSocket({ lidForPn: { [MANAGER_PN]: '300000000000003:5@lid' } });
    const resolver = createLidResolver(socket, createLogger([]));

    await expect(resolver.managerJids(MANAGER_PHONE)).resolves.toEqual(
      new Set([MANAGER_PN, '300000000000003@lid']),
    );
  });

  it('managerJids: без @lid или при сбое сопоставления только адрес с номером', async () => {
    const plain = createLidResolver(createSocket(), createLogger([]));
    const broken = createLidResolver(createSocket({ broken: true }), createLogger([]));

    await expect(plain.managerJids(MANAGER_PHONE)).resolves.toEqual(new Set([MANAGER_PN]));
    await expect(broken.managerJids(MANAGER_PHONE)).resolves.toEqual(new Set([MANAGER_PN]));
  });

  it('managerJids: номер менеджера не задан => пустой набор, без запросов', async () => {
    const socket = createSocket();
    const resolver = createLidResolver(socket, createLogger([]));

    await expect(resolver.managerJids(null)).resolves.toEqual(new Set());

    expect(socket.getLIDForPN).not.toHaveBeenCalled();
  });
});
