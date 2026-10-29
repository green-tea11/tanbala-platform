import { describe, expect, it, vi, type Mock } from 'vitest';
import type { Chat, WAMessage } from 'baileys';
import type { Logger } from '../../../src/domain/ports.js';
import type { Jid, PhoneDigits, WaMessageId, WorkingMode } from '../../../src/domain/types.js';
import type { HistoryChat } from '../../../src/whatsapp/connection-types.js';
import type { ClassifyContext, WaEvent } from '../../../src/whatsapp/inbound.js';
import type { LidResolver } from '../../../src/whatsapp/lid-resolver.js';
import {
  createMessageIntake,
  MAX_EVENT_FAILURES_IN_ROW,
  type MessageIntake,
} from '../../../src/whatsapp/message-intake.js';

const NOW = Date.UTC(2026, 9, 25, 9, 0, 0);
const HOUR_MS = 3_600_000;
const BOT_PHONE = '77000000001' as PhoneDigits;
const CLIENT_PHONE = '77000000002' as PhoneDigits;
const CLIENT_PN = '77000000002@s.whatsapp.net';
const CLIENT_LID = '200000000000002@lid';
const OTHER_PN = '77000000004@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const MANAGER_PHONE = '77000000003' as PhoneDigits;
const SELF_JIDS: ReadonlySet<Jid> = new Set(['77000000001@s.whatsapp.net' as Jid]);
const MANAGER_JIDS: ReadonlySet<Jid> = new Set(['77000000003@s.whatsapp.net' as Jid]);

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

function message(id: string): WAMessage {
  return {
    key: { id, remoteJid: CLIENT_PN, fromMe: false },
    messageTimestamp: NOW / 1000,
    message: { conversation: 'Здравствуйте' },
  };
}

function ownEvent(source: WAMessage): WaEvent {
  return {
    type: 'own',
    message: {
      waId: (source.key.id ?? '') as WaMessageId,
      chatJid: CLIENT_PN as Jid,
      content: { kind: 'other' },
      tsMs: NOW,
    },
  };
}

const resolver: LidResolver = {
  botPhone: () => BOT_PHONE,
  selfJids: () => SELF_JIDS,
  chatPhone: () => Promise.resolve(CLIENT_PHONE),
  phoneOf: () => Promise.resolve(null),
  managerJids: (phone) => Promise.resolve(phone === null ? new Set() : MANAGER_JIDS),
};

interface Setup {
  readonly intake: MessageIntake;
  readonly logs: LogEntry[];
  readonly calls: string[];
  readonly classify: Mock<(source: WAMessage, context: ClassifyContext) => WaEvent>;
  readonly onEvent: Mock<(event: WaEvent) => Promise<void>>;
  readonly onHistoryChats: Mock<(chats: readonly HistoryChat[]) => Promise<void>>;
  readonly markHistoryIncomplete: Mock<(nowMs: number) => void>;
  readonly onTooManyFailures: Mock<() => Promise<void>>;
}

function setup(
  testAllowlist: ReadonlySet<PhoneDigits> | null = null,
  workingMode: WorkingMode | null = null,
): Setup {
  const logs: LogEntry[] = [];
  const calls: string[] = [];
  const classify = vi.fn((source: WAMessage, _context: ClassifyContext): WaEvent =>
    ownEvent(source),
  );
  const onEvent = vi.fn((event: WaEvent): Promise<void> => {
    calls.push(event.type === 'ignore' ? `ignore:${event.reason}` : String(event.message.waId));
    return Promise.resolve();
  });
  const onHistoryChats = vi.fn<(chats: readonly HistoryChat[]) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const markHistoryIncomplete = vi.fn<(nowMs: number) => void>();
  const onTooManyFailures = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const intake = createMessageIntake({
    deps: {
      logger: createLogger(logs),
      clock: { now: () => NOW, sleep: () => Promise.resolve() },
      appState: {
        getLinkedAtMs: () => null,
        setLinkedAtMs: () => undefined,
        markHistoryIncomplete,
      },
      onEvent,
      onHistoryChats,
      managerPhone: MANAGER_PHONE,
      testAllowlist,
      workingMode,
      backlogMaxAgeMs: 12 * HOUR_MS,
    },
    classify,
    onTooManyFailures,
  });
  return {
    intake,
    logs,
    calls,
    classify,
    onEvent,
    onHistoryChats,
    markHistoryIncomplete,
    onTooManyFailures,
  };
}

const LINKED_AT = NOW - HOUR_MS;

describe('whatsapp/message-intake: чаты первой синхронизации', () => {
  it('в onHistoryChats только личные чаты: адрес без суффикса и позднее из двух времён', async () => {
    const { intake, onHistoryChats } = setup();
    const chats: Chat[] = [
      { id: CLIENT_PN, conversationTimestamp: 1_760_000_000 },
      {
        id: CLIENT_LID,
        conversationTimestamp: 1_760_000_100,
        lastMessageRecvTimestamp: 1_760_000_200,
      },
      { id: '77000000002:3@s.whatsapp.net', conversationTimestamp: 1_760_000_050 },
      { id: GROUP, conversationTimestamp: 1_760_000_300 },
      { id: OTHER_PN },
    ];

    await intake.history(chats);

    // Повтор чата не схлопывается: самое позднее время выберет KnownChatsRepo.touch.
    expect(onHistoryChats).toHaveBeenCalledWith([
      { jid: CLIENT_PN, lastMessageAtMs: 1_760_000_000_000 },
      { jid: CLIENT_LID, lastMessageAtMs: 1_760_000_200_000 },
      { jid: CLIENT_PN, lastMessageAtMs: 1_760_000_050_000 },
      { jid: OTHER_PN, lastMessageAtMs: null },
    ]);
  });

  it('номер и @lid чата из синхронизации (pnJid, lidJid) идут в altJids: без суффикса, без повтора адреса чата', async () => {
    const { intake, onHistoryChats } = setup();
    const chats: Chat[] = [
      { id: CLIENT_LID, pnJid: '77000000002:2@s.whatsapp.net', lidJid: CLIENT_LID },
      { id: CLIENT_PN, lidJid: CLIENT_LID, pnJid: null },
      { id: OTHER_PN, lidJid: GROUP },
    ];

    await intake.history(chats);

    expect(onHistoryChats).toHaveBeenCalledWith([
      { jid: CLIENT_LID, altJids: [CLIENT_PN], lastMessageAtMs: null },
      { jid: CLIENT_PN, altJids: [CLIENT_LID], lastMessageAtMs: null },
      { jid: OTHER_PN, lastMessageAtMs: null },
    ]);
  });

  it('без личных чатов onHistoryChats не вызывается', async () => {
    const { intake, onHistoryChats } = setup();

    await intake.history([{ id: GROUP }]);

    expect(onHistoryChats).not.toHaveBeenCalled();
  });

  it('сбой записи: отметка неполной синхронизации с текущим временем, ошибка в лог', async () => {
    const { intake, onHistoryChats, markHistoryIncomplete, logs } = setup();
    onHistoryChats.mockRejectedValue(new Error('база заблокирована'));

    await expect(intake.history([{ id: CLIENT_PN }])).resolves.toBeUndefined();

    expect(markHistoryIncomplete).toHaveBeenCalledWith(NOW);
    expect(logs).toContainEqual(expect.objectContaining({ level: 'error' }));
  });

  it('испорченные данные и сбой отметки: обе ошибки в лог, исключение наружу не уходит', async () => {
    const { intake, markHistoryIncomplete, logs } = setup();
    markHistoryIncomplete.mockImplementation(() => {
      throw new Error('база закрыта');
    });

    await expect(intake.history(null as unknown as Chat[])).resolves.toBeUndefined();

    expect(logs.filter((entry) => entry.level === 'error')).toHaveLength(2);
  });
});

describe('whatsapp/message-intake: сообщения', () => {
  it('контекст разбора: адреса, граница, время, порог, список, номер собеседника и тип пачки', async () => {
    const allowlist: ReadonlySet<PhoneDigits> = new Set([CLIENT_PHONE]);
    const { intake, classify, calls } = setup(allowlist);
    const first = message('m1');

    await intake.messages({ messages: [first], type: 'append' }, resolver, LINKED_AT);

    expect(classify).toHaveBeenCalledWith(first, {
      managerJids: MANAGER_JIDS,
      selfJids: SELF_JIDS,
      linkedAtMs: LINKED_AT,
      nowMs: NOW,
      backlogMaxAgeMs: 12 * HOUR_MS,
      testAllowlist: allowlist,
      workingMode: null,
      chatPhone: CLIENT_PHONE,
      upsertType: 'append',
    });
    expect(calls).toEqual(['m1']);
  });

  it('рабочий режим: граница перехода и TEST_ALLOWLIST уходят в разбор как есть, закрытого списка нет', async () => {
    const workingMode: WorkingMode = { sinceMs: LINKED_AT + 1, allowlist: new Set([BOT_PHONE]) };
    const { intake, classify, logs } = setup(null, workingMode);

    await intake.messages({ messages: [message('m1')], type: 'notify' }, resolver, LINKED_AT);

    expect(classify.mock.calls[0]?.[1]).toMatchObject({ testAllowlist: null });
    expect(classify.mock.calls[0]?.[1].workingMode).toBe(workingMode);
    expect(logs.filter((entry) => entry.level === 'warn')).toEqual([]);
  });

  it('момент привязки неизвестен: сообщения не разбираются, в лог только их число', async () => {
    const { intake, classify, logs } = setup();

    await intake.messages({ messages: [message('m1')], type: 'notify' }, resolver, null);

    expect(classify).not.toHaveBeenCalled();
    expect(logs).toContainEqual(expect.objectContaining({ level: 'warn', context: { count: 1 } }));
  });

  it('номер бота в TEST_ALLOWLIST: одно предупреждение без номера, номер не считается разрешённым', async () => {
    const allowlist: ReadonlySet<PhoneDigits> = new Set([CLIENT_PHONE, BOT_PHONE]);
    const { intake, classify, logs } = setup(allowlist);

    await intake.messages({ messages: [message('m1')], type: 'notify' }, resolver, LINKED_AT);
    await intake.messages({ messages: [message('m2')], type: 'notify' }, resolver, LINKED_AT);

    expect(classify.mock.calls.map(([, context]) => context.testAllowlist)).toEqual([
      new Set([CLIENT_PHONE]),
      new Set([CLIENT_PHONE]),
    ]);
    expect(allowlist.has(BOT_PHONE)).toBe(true);
    expect(logs.filter((entry) => entry.message?.includes('TEST_ALLOWLIST'))).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(BOT_PHONE);
  });

  it('номер бота ещё неизвестен: TEST_ALLOWLIST передаётся как есть, без предупреждений', async () => {
    const allowlist: ReadonlySet<PhoneDigits> = new Set([CLIENT_PHONE, BOT_PHONE]);
    const { intake, classify, logs } = setup(allowlist);
    const unlinked: LidResolver = { ...resolver, botPhone: () => null };

    await intake.messages({ messages: [message('m1')], type: 'notify' }, unlinked, LINKED_AT);

    expect(classify.mock.calls[0]?.[1].testAllowlist).toBe(allowlist);
    expect(logs.filter((entry) => entry.level === 'warn')).toEqual([]);
  });

  it('сбой разбора и onEvent: в лог ID и тип без текста и номера; успех сбрасывает счётчик', async () => {
    const { intake, classify, onEvent, calls, logs, onTooManyFailures } = setup();
    classify
      .mockImplementationOnce(() => {
        throw new Error('неизвестный формат');
      })
      .mockImplementationOnce(ownEvent)
      .mockImplementationOnce(ownEvent)
      .mockImplementationOnce(() => {
        throw new Error('снова');
      });
    onEvent.mockRejectedValueOnce(new Error('база заблокирована'));
    const batch = ['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => message(id));

    await intake.messages({ messages: batch, type: 'notify' }, resolver, LINKED_AT);

    expect(calls).toEqual(['m3', 'm5']);
    expect(logs).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({ waId: 'm1', upsertType: 'notify' }) as unknown,
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({ waId: 'm2', event: 'own' }) as unknown,
      }),
    );
    expect(JSON.stringify(logs)).not.toMatch(/Здравствуйте|77000000002/);
    expect(onTooManyFailures).not.toHaveBeenCalled();
  });

  it('три сбоя подряд: onTooManyFailures, остаток пачки и следующие пачки не разбираются', async () => {
    const { intake, onEvent, onTooManyFailures, classify } = setup();
    onEvent.mockRejectedValue(new Error('база недоступна'));
    const batch = ['m1', 'm2', 'm3', 'm4'].map((id) => message(id));

    await intake.messages({ messages: batch, type: 'notify' }, resolver, LINKED_AT);
    await intake.messages({ messages: [message('m5')], type: 'notify' }, resolver, LINKED_AT);

    expect(onEvent).toHaveBeenCalledTimes(MAX_EVENT_FAILURES_IN_ROW);
    expect(onTooManyFailures).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledTimes(MAX_EVENT_FAILURES_IN_ROW);
  });

  it('пропуски вне списка пишутся в лог только счётчиком, без адресов и номеров', async () => {
    const { intake, classify, calls, logs } = setup(new Set([MANAGER_PHONE]));
    classify.mockImplementation(() => ({
      type: 'ignore',
      reason: 'not_allowlisted',
      chatJid: CLIENT_PN as Jid,
      tsMs: NOW,
    }));

    await intake.messages(
      { messages: [message('m1'), message('m2')], type: 'notify' },
      resolver,
      LINKED_AT,
    );

    expect(calls).toEqual(['ignore:not_allowlisted', 'ignore:not_allowlisted']);
    expect(logs).toContainEqual(expect.objectContaining({ level: 'info', context: { count: 2 } }));
    expect(JSON.stringify(logs)).not.toMatch(/77000000002|200000000000002/);
  });
});
