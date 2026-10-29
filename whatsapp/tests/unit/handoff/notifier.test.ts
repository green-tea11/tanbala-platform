import { describe, expect, it } from 'vitest';
import type { MessageSender, OutboundRecord } from '../../../src/domain/ports.js';
import type {
  Jid,
  ManagerNotification,
  ManagerNotificationKind,
  WaMessageId,
} from '../../../src/domain/types.js';
import {
  createManagerNotifier,
  NOTIFY_MAX_ATTEMPTS,
  NOTIFY_RETRY_BATCH,
  NOTIFY_STALE_PENDING_MS,
  type ManagerNotifier,
} from '../../../src/handoff/notifier.js';
import {
  createOutbox,
  MANAGER_NOTIFY_PER_HOUR,
  type ManagerNotifyResult,
} from '../../../src/messaging/outbox.js';
import {
  chatIdOf,
  createFakeLogger,
  createFakeNotifications,
  createFakeOutbox,
  createManualClock,
  loggedText,
  MINUTE_MS,
  T0,
  type FakeNotifications,
  type FakeOutbox,
  type LogEntry,
  type ManualClock,
  type OutboxStep,
} from './fakes.js';

const CHAT = chatIdOf(12);
const SECRET_NAME = 'Секретный Клиент';
const SECRET_PHONE = '77000000001';
const TEXT = `Передача чата менеджеру: горячий клиент.\nИмя в WhatsApp: ${SECRET_NAME}\nНомер: +${SECRET_PHONE}`;
const DOWN = new Error('Connection Closed');

interface Harness {
  readonly notifier: ManagerNotifier;
  readonly notifications: FakeNotifications;
  readonly outbox: FakeOutbox;
  readonly clock: ManualClock;
  readonly events: string[];
  readonly logs: LogEntry[];
}

function setup(script: readonly OutboxStep[] = []): Harness {
  const events: string[] = [];
  const logs: LogEntry[] = [];
  const clock = createManualClock();
  const notifications = createFakeNotifications(events);
  const outbox = createFakeOutbox(events, script);
  const notifier = createManagerNotifier({
    notifications: notifications.repo,
    outbox: outbox.outbox,
    clock,
    logger: createFakeLogger(logs),
  });
  return { notifier, notifications, outbox, clock, events, logs };
}

/** Отправка, которая зависла: результат придёт, когда тест вызовет release. */
function hangingSend(): { readonly step: Promise<ManagerNotifyResult>; release(): void } {
  let release: () => void = () => undefined;
  const step = new Promise<ManagerNotifyResult>((resolve) => {
    release = () => {
      resolve({ status: 'sent', waId: 'OUT-HUNG' as WaMessageId });
    };
  });
  return { step, release: () => release() };
}

function staleRow(
  overrides: Partial<Omit<ManagerNotification, 'id'>> = {},
): Omit<ManagerNotification, 'id'> {
  return {
    kind: 'handoff',
    chatId: CHAT,
    text: TEXT,
    status: 'pending',
    attempts: 0,
    createdAtMs: T0 - 6 * MINUTE_MS,
    updatedAtMs: T0 - 6 * MINUTE_MS,
    ...overrides,
  };
}

describe('createManagerNotifier: notify', () => {
  it('сначала запись в базу с полным текстом, потом отправка, потом итог', async () => {
    const h = setup();

    await expect(h.notifier.notify('handoff', CHAT, TEXT)).resolves.toBe('sent');

    expect(h.events).toEqual([
      'notifications.add',
      'outbox.notifyManager',
      'notifications.setResult:sent',
    ]);
    expect(h.outbox.sent).toEqual([{ text: TEXT, kind: 'handoff' }]);
    expect(h.notifications.rows()).toEqual([
      {
        id: 1,
        kind: 'handoff',
        chatId: CHAT,
        text: TEXT,
        status: 'sent',
        attempts: 1,
        createdAtMs: T0,
        updatedAtMs: T0,
      },
    ]);
    expect(h.notifications.waIdOf(1)).toBe('OUT-1');
  });

  it.each<ManagerNotificationKind>(['handoff', 'limit', 'backlog'])(
    'вид %s уходит в outbox как есть: у видов свои квоты',
    async (kind) => {
      const h = setup();

      await h.notifier.notify(kind, kind === 'backlog' ? null : CHAT, TEXT);

      expect(h.outbox.sent).toEqual([{ text: TEXT, kind }]);
      expect(h.notifications.rows()[0]).toMatchObject({
        kind,
        chatId: kind === 'backlog' ? null : CHAT,
      });
    },
  );

  it('текст не режется: в базе то же, что ушло менеджеру', async () => {
    const h = setup();
    const long = `${TEXT}\n${'я'.repeat(3_000)}`;

    await h.notifier.notify('backlog', null, long);

    expect(h.notifications.rows()[0]?.text).toBe(long);
    expect(h.outbox.sent[0]?.text).toBe(long);
  });

  it('номера менеджера нет: no_manager, одна строка warn без имени, номера и текста', async () => {
    const h = setup([{ status: 'no_manager' }]);

    await expect(h.notifier.notify('handoff', CHAT, TEXT, { reason: 'hot' })).resolves.toBe(
      'no_manager',
    );

    expect(h.notifications.rows()[0]).toMatchObject({ status: 'no_manager', attempts: 1 });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({
      level: 'warn',
      context: { notificationId: 1, kind: 'handoff', chatId: CHAT, reason: 'hot' },
    });
    expect(h.logs[0]?.message).toContain('текст в панели');
    expect(loggedText(h.logs)).not.toContain(SECRET_NAME);
    expect(loggedText(h.logs)).not.toContain(SECRET_PHONE);
    expect(loggedText(h.logs)).not.toContain('горячий клиент');
  });

  it('квота уведомлений исчерпана: skipped_limit, строка warn без текста', async () => {
    const h = setup([{ status: 'skipped_limit' }]);

    await expect(h.notifier.notify('limit', CHAT, TEXT)).resolves.toBe('skipped_limit');

    expect(h.notifications.rows()[0]).toMatchObject({ status: 'skipped_limit', attempts: 1 });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({
      level: 'warn',
      context: { notificationId: 1, kind: 'limit', chatId: CHAT },
    });
    expect(loggedText(h.logs)).not.toContain(SECRET_NAME);
  });

  it('сбой отправки: failed, ошибка в лог без текста, наружу не бросается', async () => {
    const h = setup([DOWN]);

    await expect(h.notifier.notify('handoff', CHAT, TEXT)).resolves.toBe('failed');

    expect(h.notifications.rows()[0]).toMatchObject({ status: 'failed', attempts: 1, text: TEXT });
    expect(h.events).toEqual([
      'notifications.add',
      'outbox.notifyManager',
      'notifications.setResult:failed',
    ]);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({
      level: 'error',
      context: { err: DOWN, notificationId: 1, kind: 'handoff', chatId: CHAT, attempt: 1 },
    });
    expect(loggedText(h.logs)).not.toContain(SECRET_NAME);
    expect(loggedText(h.logs)).not.toContain(SECRET_PHONE);
  });

  it('уведомление не записалось в базу: отказ без отправки', async () => {
    const h = setup();
    const failure = new Error('база недоступна');
    h.notifications.failNext('add', failure);

    await expect(h.notifier.notify('handoff', CHAT, TEXT)).rejects.toBe(failure);

    expect(h.outbox.sent).toEqual([]);
    expect(h.notifications.rows()).toEqual([]);
  });

  it('итог не записался после успешной отправки: статус возвращается, сбой в логе', async () => {
    const h = setup();
    h.notifications.failNext('setResult', new Error('база недоступна'));

    await expect(h.notifier.notify('handoff', CHAT, TEXT)).resolves.toBe('sent');

    expect(h.notifications.rows()[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(h.logs.map((entry) => entry.level)).toEqual(['info', 'error']);
    expect(loggedText(h.logs)).not.toContain(SECRET_NAME);
  });
});

describe('createManagerNotifier: retryFailed', () => {
  it('повторяет failed: отправляет тот же текст ещё раз и считает попытку', async () => {
    const h = setup([DOWN]);
    await h.notifier.notify('limit', CHAT, TEXT);

    await expect(h.notifier.retryFailed()).resolves.toBe(1);

    expect(h.outbox.sent).toEqual([
      { text: TEXT, kind: 'limit' },
      { text: TEXT, kind: 'limit' },
    ]);
    expect(h.notifications.rows()).toHaveLength(1);
    expect(h.notifications.rows()[0]).toMatchObject({ status: 'sent', attempts: 2 });
    expect(h.notifications.waIdOf(1)).toBe('OUT-2');
  });

  it('просит у репозитория не больше 5 попыток и зависшие pending старше 5 минут', async () => {
    const h = setup();

    await h.notifier.retryFailed();

    expect(NOTIFY_MAX_ATTEMPTS).toBe(5);
    expect(NOTIFY_STALE_PENDING_MS).toBe(5 * MINUTE_MS);
    expect(h.notifications.retryQueries).toEqual([
      {
        maxAttempts: NOTIFY_MAX_ATTEMPTS,
        staleBeforeMs: T0 - NOTIFY_STALE_PENDING_MS,
        limit: NOTIFY_RETRY_BATCH,
      },
    ]);
  });

  it('зависший pending старше 5 минут уходит повтором, свежий нет', async () => {
    const h = setup();
    const stale = h.notifications.seed(staleRow({ text: 'зависшее' }));
    h.notifications.seed(
      staleRow({
        text: 'свежее',
        createdAtMs: T0 - 4 * MINUTE_MS,
        updatedAtMs: T0 - 4 * MINUTE_MS,
      }),
    );

    await expect(h.notifier.retryFailed()).resolves.toBe(1);

    expect(h.outbox.sent.map((sent) => sent.text)).toEqual(['зависшее']);
    expect(h.notifications.rows().find((row) => row.id === stale)).toMatchObject({
      status: 'sent',
      attempts: 1,
    });
  });

  it('no_manager, skipped_limit и sent не повторяются: они уже в панели или доставлены', async () => {
    const h = setup([{ status: 'no_manager' }, { status: 'skipped_limit' }]);
    await h.notifier.notify('handoff', CHAT, TEXT);
    await h.notifier.notify('limit', CHAT, TEXT);
    await h.notifier.notify('backlog', null, TEXT);
    const sentBefore = h.outbox.sent.length;

    await expect(h.notifier.retryFailed()).resolves.toBe(0);

    expect(h.outbox.sent).toHaveLength(sentBefore);
    expect(h.notifications.rows().map((row) => row.status)).toEqual([
      'no_manager',
      'skipped_limit',
      'sent',
    ]);
  });

  it('до 5 попыток всего (первая отправка и четыре повтора), потом запись остаётся failed', async () => {
    const h = setup(Array.from({ length: 10 }, () => DOWN));
    await h.notifier.notify('handoff', CHAT, TEXT);

    for (let round = 0; round < 6; round += 1) await h.notifier.retryFailed();

    expect(h.outbox.sent).toHaveLength(NOTIFY_MAX_ATTEMPTS);
    expect(h.notifications.rows()[0]).toMatchObject({
      status: 'failed',
      attempts: NOTIFY_MAX_ATTEMPTS,
    });
  });

  it('сбой одной записи не мешает остальным: идут по порядку, старые первыми', async () => {
    const h = setup([DOWN, DOWN]);
    await h.notifier.notify('handoff', chatIdOf(1), 'первое');
    await h.notifier.notify('handoff', chatIdOf(2), 'второе');
    h.clock.advance(MINUTE_MS);

    await expect(h.notifier.retryFailed()).resolves.toBe(2);

    expect(h.outbox.sent.map((sent) => sent.text)).toEqual([
      'первое',
      'второе',
      'первое',
      'второе',
    ]);
    expect(h.notifications.rows().map((row) => row.status)).toEqual(['sent', 'sent']);
  });

  it('за один проход не больше пачки; остальное в следующий раз', async () => {
    const h = setup();
    for (let index = 0; index < NOTIFY_RETRY_BATCH + 5; index += 1) {
      h.notifications.seed(staleRow({ status: 'failed', attempts: 1, text: `n${index}` }));
    }

    await expect(h.notifier.retryFailed()).resolves.toBe(NOTIFY_RETRY_BATCH);
    await expect(h.notifier.retryFailed()).resolves.toBe(5);
    await expect(h.notifier.retryFailed()).resolves.toBe(0);
  });

  it('второй проход, пока идёт первый, ничего не делает: остальные записи он не перехватывает', async () => {
    const hung = hangingSend();
    const h = setup([DOWN, DOWN, hung.step]);
    await h.notifier.notify('handoff', chatIdOf(1), 'первое');
    await h.notifier.notify('handoff', chatIdOf(2), 'второе');

    const first = h.notifier.retryFailed();
    const second = await h.notifier.retryFailed();

    expect(second).toBe(0);
    expect(h.outbox.sent.map((sent) => sent.text)).toEqual(['первое', 'второе', 'первое']);
    hung.release();
    await expect(first).resolves.toBe(2);
    expect(h.outbox.sent.map((sent) => sent.text)).toEqual([
      'первое',
      'второе',
      'первое',
      'второе',
    ]);
  });

  it('запись, которая ещё отправляется, повтором не берётся, даже если зависла дольше 5 минут', async () => {
    const hung = hangingSend();
    const h = setup([hung.step]);
    const sending = h.notifier.notify('handoff', CHAT, TEXT);
    h.clock.advance(NOTIFY_STALE_PENDING_MS + MINUTE_MS);

    await expect(h.notifier.retryFailed()).resolves.toBe(0);
    hung.release();

    await expect(sending).resolves.toBe('sent');
    expect(h.outbox.sent).toHaveLength(1);
  });

  it('сбой чтения очереди не бросается: ноль и строка error без данных клиента', async () => {
    const h = setup();
    h.notifications.seed(staleRow({ status: 'failed', attempts: 1 }));
    const failure = new Error('база недоступна');
    h.notifications.failNext('listRetryable', failure);

    await expect(h.notifier.retryFailed()).resolves.toBe(0);

    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ level: 'error', context: { err: failure } });
    expect(loggedText(h.logs)).not.toContain(SECRET_NAME);
    await expect(h.notifier.retryFailed()).resolves.toBe(1);
  });

  it('нечего повторять: тихо, без строк в логе', async () => {
    const h = setup();

    await expect(h.notifier.retryFailed()).resolves.toBe(0);

    expect(h.logs).toEqual([]);
  });

  it('итог прохода одной строкой info: сколько попыток и сколько доставлено, без текста', async () => {
    const h = setup([DOWN, DOWN, { status: 'sent', waId: 'OUT-A' as WaMessageId }, DOWN]);
    await h.notifier.notify('handoff', chatIdOf(1), TEXT);
    await h.notifier.notify('handoff', chatIdOf(2), TEXT);
    h.logs.length = 0;

    await h.notifier.retryFailed();

    const summary = h.logs.filter((entry) => entry.context['attempted'] !== undefined);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ level: 'info', context: { attempted: 2, sent: 1 } });
    expect(loggedText(h.logs)).not.toContain(SECRET_NAME);
  });
});

// Путь до номера менеджера целиком: настоящий Outbox, поддельный отправитель WhatsApp. Когда владелец впишет
// MANAGER_WHATSAPP, managerJid придёт из конфига в OutboxDeps, и отправка заработает без правки кода.

const MANAGER_JID = '77000000009@s.whatsapp.net' as Jid;

interface SenderCall {
  readonly jid: Jid;
  readonly text: string;
  readonly waId: WaMessageId;
}

interface RealOutboxHarness {
  readonly notifier: ManagerNotifier;
  readonly notifications: FakeNotifications;
  readonly sent: SenderCall[];
  readonly registered: OutboundRecord[];
  readonly logs: LogEntry[];
  readonly clock: ManualClock;
  /** Следующая отправка падает этой ошибкой (один раз). */
  failNextSend(error: Error): void;
}

function setupWithRealOutbox(managerJid: Jid | null): RealOutboxHarness {
  const logs: LogEntry[] = [];
  const sent: SenderCall[] = [];
  const registered: OutboundRecord[] = [];
  const clock = createManualClock();
  const notifications = createFakeNotifications();
  let issued = 0;
  let failure: Error | null = null;
  const sender: MessageSender = {
    newMessageId: () => {
      issued += 1;
      return `OUT-${issued}` as WaMessageId;
    },
    sendText: (jid, text, waId) => {
      if (failure !== null) {
        const error = failure;
        failure = null;
        return Promise.reject(error);
      }
      sent.push({ jid, text, waId });
      return Promise.resolve();
    },
    setTyping: () => Promise.resolve(),
  };
  const unexpected = (): never => {
    throw new Error('Неожиданный вызов');
  };
  const outbox = createOutbox({
    sender,
    chats: {
      upsertByIdentity: unexpected,
      findByJid: unexpected,
      getById: unexpected,
      setStatus: unexpected,
      saveAssessment: unexpected,
      listForPanel: unexpected,
      countForPanel: unexpected,
      getProgress: unexpected,
      recordTurn: unexpected,
      resetProgress: unexpected,
    },
    messages: {
      insertIfNew: unexpected,
      recent: unexpected,
      isUnansweredInbound: unexpected,
      markAnswered: unexpected,
      setTranscript: unexpected,
      unansweredAfterLastOutbound: unexpected,
      history: unexpected,
    },
    outboundIds: {
      register: (record) => {
        registered.push(record);
      },
      setResult: () => undefined,
      find: () => null,
    },
    clock,
    managerJid,
    testAllowlist: null,
    random: () => 0,
  });
  const notifier = createManagerNotifier({
    notifications: notifications.repo,
    outbox,
    clock,
    logger: createFakeLogger(logs),
  });
  return {
    notifier,
    notifications,
    sent,
    registered,
    logs,
    clock,
    failNextSend: (error) => {
      failure = error;
    },
  };
}

describe('createManagerNotifier с настоящим Outbox', () => {
  it('номер менеджера задан: уведомление уходит на него, в базе sent с ID отправки', async () => {
    const h = setupWithRealOutbox(MANAGER_JID);

    await expect(h.notifier.notify('handoff', CHAT, TEXT)).resolves.toBe('sent');

    expect(h.sent).toEqual([{ jid: MANAGER_JID, text: TEXT, waId: 'OUT-1' }]);
    expect(h.registered).toEqual([
      expect.objectContaining({ origin: 'manager_notify', chatId: null, jid: MANAGER_JID }),
    ]);
    expect(h.notifications.rows()[0]).toMatchObject({ status: 'sent', attempts: 1, text: TEXT });
    expect(h.notifications.waIdOf(1)).toBe('OUT-1');
  });

  it('номер менеджера пуст: no_manager, текст целиком в базе, WhatsApp не трогается, одна строка warn', async () => {
    const h = setupWithRealOutbox(null);

    await expect(h.notifier.notify('handoff', CHAT, TEXT, { reason: 'hot' })).resolves.toBe(
      'no_manager',
    );

    expect(h.sent).toEqual([]);
    expect(h.registered).toEqual([]);
    expect(h.notifications.rows()[0]).toMatchObject({ status: 'no_manager', text: TEXT });
    expect(h.logs.map((entry) => entry.level)).toEqual(['warn']);
    expect(loggedText(h.logs)).not.toContain(SECRET_NAME);
    await expect(h.notifier.retryFailed()).resolves.toBe(0);
  });

  it('отправитель упал: failed, повтор доставляет на тот же адрес', async () => {
    const h = setupWithRealOutbox(MANAGER_JID);
    h.failNextSend(DOWN);

    await expect(h.notifier.notify('limit', CHAT, TEXT)).resolves.toBe('failed');
    await expect(h.notifier.retryFailed()).resolves.toBe(1);

    expect(h.sent).toEqual([{ jid: MANAGER_JID, text: TEXT, waId: 'OUT-2' }]);
    expect(h.notifications.rows()[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('квота вида исчерпана: skipped_limit остаётся в панели и не повторяется; квоты других видов целы', async () => {
    const h = setupWithRealOutbox(MANAGER_JID);
    const quota = MANAGER_NOTIFY_PER_HOUR.backlog;
    for (let index = 0; index < quota; index += 1) {
      await h.notifier.notify('backlog', null, `список ${index}`);
    }

    await expect(h.notifier.notify('backlog', null, 'лишний список')).resolves.toBe(
      'skipped_limit',
    );
    await expect(h.notifier.notify('handoff', CHAT, TEXT)).resolves.toBe('sent');
    await expect(h.notifier.retryFailed()).resolves.toBe(0);

    expect(h.sent.map((call) => call.text)).toEqual([
      ...Array.from({ length: quota }, (_, index) => `список ${index}`),
      TEXT,
    ]);
    expect(h.notifications.rows().find((row) => row.text === 'лишний список')).toMatchObject({
      status: 'skipped_limit',
    });
    h.clock.advance(60 * MINUTE_MS + 1);
    await expect(h.notifier.notify('backlog', null, 'через час')).resolves.toBe('sent');
  });
});
