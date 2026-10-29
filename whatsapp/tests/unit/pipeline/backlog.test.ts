import { describe, expect, it } from 'vitest';
import type { BacklogRepo, ChatsRepo, MessagesRepo } from '../../../src/domain/ports.js';
import type {
  BacklogChat,
  ChatId,
  ChatIdentity,
  InboundMessage,
  ManagerNotificationKind,
  ManagerNotificationStatus,
  MediaRef,
  NewMessage,
  StoredMessage,
  WaMessageId,
} from '../../../src/domain/types.js';
import { formatBacklogNotification } from '../../../src/handoff/notification.js';
import type { ManagerNotifier } from '../../../src/handoff/notifier.js';
import { createBacklogCollector, type BacklogCollector } from '../../../src/pipeline/backlog.js';
import {
  chatIdOf,
  CLIENT_JID,
  CLIENT_PHONE,
  createFakeLogger,
  createFakeUnitOfWork,
  createManualClock,
  loggedText,
  makeChat,
  T0,
  type LogEntry,
} from '../handoff/fakes.js';

const HOUR_MS = 60 * 60 * 1000;
const THRESHOLD_MS = 12 * HOUR_MS;
const IDENTITY: ChatIdentity = { replyJid: CLIENT_JID, lidJid: null, pnJid: CLIENT_JID };
const SECRET_NAME = 'Секретный Клиент';
const SECRET_TEXT = 'Нужен учёт склада, пишите срочно';

interface MarkCall {
  readonly chatId: ChatId;
  readonly lastMessageAtMs: number;
}

interface NotifyCall {
  readonly kind: ManagerNotificationKind;
  readonly chatId: ChatId | null;
  readonly text: string;
}

type NotifyStep = ManagerNotificationStatus | Error;

interface SetupOptions {
  /** Что отвечает уведомление менеджеру. */
  readonly notify?: NotifyStep;
  /** Ответы по порядку вызовов; когда они кончились, действует notify. */
  readonly notifyScript?: readonly NotifyStep[];
  /** Запись сообщения падает этой ошибкой. */
  readonly insertError?: Error;
  /** Сообщения, которые уже есть в базе (повторная доставка). */
  readonly knownWaIds?: readonly string[];
}

interface Harness {
  readonly collector: BacklogCollector;
  readonly events: string[];
  readonly logs: LogEntry[];
  readonly marks: MarkCall[];
  readonly inserted: NewMessage[];
  readonly upserts: {
    readonly identity: ChatIdentity;
    readonly pushName: string | null;
    readonly nowMs: number;
  }[];
  readonly notifications: NotifyCall[];
  readonly closed: { readonly chatIds: readonly ChatId[]; readonly nowMs: number }[];
  /** Чат в списке ожидающих уведомления, как его отдаёт репозиторий отметок простоя. */
  seedPending(chat: BacklogChat): void;
  /** Сообщение чата в истории (для проверки, что после отметки простоя в чате что-то случилось). */
  seedHistory(message: StoredMessage): void;
  pending(): readonly BacklogChat[];
}

function setup(options: SetupOptions = {}): Harness {
  const events: string[] = [];
  const logs: LogEntry[] = [];
  const marks: MarkCall[] = [];
  const inserted: NewMessage[] = [];
  const upserts: Harness['upserts'] = [];
  const notifications: NotifyCall[] = [];
  const closed: { chatIds: readonly ChatId[]; nowMs: number }[] = [];
  const known = new Set(options.knownWaIds ?? []);
  let pending: readonly BacklogChat[] = [];
  let history: readonly StoredMessage[] = [];
  const clock = createManualClock();
  const unexpected = (): never => {
    throw new Error('Неожиданный вызов');
  };
  const chats: ChatsRepo = {
    upsertByIdentity: (identity, pushName, nowMs) => {
      events.push('chats.upsertByIdentity');
      upserts.push({ identity, pushName, nowMs });
      return makeChat({ id: chatIdOf(7), identity, pushName });
    },
    findByJid: unexpected,
    getById: unexpected,
    setStatus: unexpected,
    saveAssessment: unexpected,
    listForPanel: unexpected,
    countForPanel: unexpected,
    getProgress: unexpected,
    recordTurn: unexpected,
    resetProgress: unexpected,
    getNote: unexpected,
    setNote: unexpected,
  };
  const messages: MessagesRepo = {
    insertIfNew: (message) => {
      events.push('messages.insertIfNew');
      if (options.insertError !== undefined) throw options.insertError;
      inserted.push(message);
      if (known.has(message.waId)) return false;
      known.add(message.waId);
      return true;
    },
    recent: (chatId, limit) => history.filter((message) => message.chatId === chatId).slice(-limit),
    isUnansweredInbound: unexpected,
    markAnswered: unexpected,
    setTranscript: unexpected,
    unansweredAfterLastOutbound: unexpected,
    history: unexpected,
  };
  const backlog: BacklogRepo = {
    markStale: (chatId, lastMessageAtMs) => {
      events.push('backlog.markStale');
      marks.push({ chatId, lastMessageAtMs });
    },
    listPending: () => pending,
    markNotified: (chatIds, nowMs) => {
      events.push('backlog.markNotified');
      closed.push({ chatIds, nowMs });
      pending = pending.filter((chat) => !chatIds.includes(chat.chatId));
    },
  };
  const notifier: Pick<ManagerNotifier, 'notify'> = {
    notify: (kind, chatId, text) => {
      events.push('notifier.notify');
      const result = options.notifyScript?.[notifications.length] ?? options.notify ?? 'sent';
      notifications.push({ kind, chatId, text });
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
  const collector = createBacklogCollector({
    chats,
    messages,
    backlog,
    unitOfWork: createFakeUnitOfWork(events),
    notifier,
    clock,
    logger: createFakeLogger(logs),
    backlogMaxAgeMs: THRESHOLD_MS,
  });
  return {
    collector,
    events,
    logs,
    marks,
    inserted,
    upserts,
    notifications,
    closed,
    seedPending: (chat) => {
      pending = [...pending, chat];
    },
    seedHistory: (message) => {
      history = [...history, message];
    },
    pending: () => pending,
  };
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    waId: 'OLD-1' as WaMessageId,
    identity: IDENTITY,
    pushName: SECRET_NAME,
    content: { kind: 'text', text: SECRET_TEXT },
    tsMs: T0 - 20 * HOUR_MS,
    ...overrides,
  };
}

function backlogChat(id: number, overrides: Partial<BacklogChat> = {}): BacklogChat {
  return {
    chatId: chatIdOf(id),
    name: `Клиент ${id}`,
    phone: CLIENT_PHONE,
    lastMessageAtMs: T0 - 20 * HOUR_MS,
    ...overrides,
  };
}

function stored(chat: ChatId, overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 1,
    chatId: chat,
    author: 'client',
    kind: 'text',
    text: 'сообщение',
    tsMs: T0 - 20 * HOUR_MS,
    ...overrides,
  };
}

describe('createBacklogCollector: add', () => {
  it('старое сообщение: чат без смены статуса, сообщение клиента в историю, отметка простоя, всё в одной транзакции', () => {
    const h = setup();

    h.collector.add(inbound());

    expect(h.events).toEqual([
      'tx:begin',
      'chats.upsertByIdentity',
      'messages.insertIfNew',
      'backlog.markStale',
      'tx:commit',
    ]);
    expect(h.upserts).toEqual([{ identity: IDENTITY, pushName: SECRET_NAME, nowMs: T0 }]);
    expect(h.inserted).toEqual([
      {
        chatId: 7,
        waId: 'OLD-1',
        author: 'client',
        kind: 'text',
        text: SECRET_TEXT,
        tsMs: T0 - 20 * HOUR_MS,
      },
    ]);
    expect(h.marks).toEqual([{ chatId: 7, lastMessageAtMs: T0 - 20 * HOUR_MS }]);
    expect(h.notifications).toEqual([]);
  });

  it.each([
    [{ kind: 'voice', media: 'M-1' as MediaRef, mimeType: 'audio/ogg', seconds: 3 }, 'voice'],
    [{ kind: 'other' }, 'other'],
  ] as const)('сообщение вида %j хранится без текста', (content, kind) => {
    const h = setup();

    h.collector.add(inbound({ content }));

    expect(h.inserted).toEqual([expect.objectContaining({ kind, text: null })]);
    expect(h.marks).toHaveLength(1);
  });

  it('повторная доставка того же сообщения: чат не отмечается второй раз', () => {
    const h = setup({ knownWaIds: ['OLD-1'] });

    h.collector.add(inbound());

    expect(h.inserted).toHaveLength(1);
    expect(h.marks).toEqual([]);
  });

  it('сбой записи: всё откатывается, ошибка приходит наружу', () => {
    const failure = new Error('база недоступна');
    const h = setup({ insertError: failure });

    expect(() => {
      h.collector.add(inbound());
    }).toThrow(failure);

    expect(h.events).toEqual([
      'tx:begin',
      'chats.upsertByIdentity',
      'messages.insertIfNew',
      'tx:rollback',
    ]);
    expect(h.marks).toEqual([]);
  });

  it('в лог не попадают текст, имя и номер клиента', () => {
    const h = setup();

    h.collector.add(inbound());

    expect(h.logs.length).toBeGreaterThan(0);
    const logged = loggedText(h.logs);
    for (const secret of [SECRET_TEXT, SECRET_NAME, '77000000001']) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe('createBacklogCollector: flush', () => {
  it('нет чатов простоя: ничего не отправляется и не отмечается', async () => {
    const h = setup();

    await h.collector.flush();

    expect(h.events).toEqual([]);
  });

  it('одно уведомление со списком: сначала запись и отправка, потом отметка «менеджеру сообщили»', async () => {
    const h = setup();
    const first = backlogChat(1);
    const second = backlogChat(2, { name: null, phone: null });
    h.seedPending(first);
    h.seedPending(second);

    await h.collector.flush();

    expect(h.events).toEqual(['notifier.notify', 'backlog.markNotified']);
    expect(h.notifications).toEqual([
      { kind: 'backlog', chatId: null, text: formatBacklogNotification([first, second], 12) },
    ]);
    expect(h.closed).toEqual([{ chatIds: [first.chatId, second.chatId], nowMs: T0 }]);
    expect(h.pending()).toEqual([]);
  });

  it.each(['sent', 'no_manager', 'skipped_limit', 'failed'] as const)(
    'итог уведомления %s: отметка ставится, повтор отправки ведёт notifier, дублей в панели нет',
    async (status) => {
      const h = setup({ notify: status });
      h.seedPending(backlogChat(1));

      await h.collector.flush();

      expect(h.closed).toHaveLength(1);
      expect(h.pending()).toEqual([]);
    },
  );

  it('уведомление не записалось: отказ, отметка не ставится, чаты ждут следующего flush', async () => {
    const failure = new Error('база недоступна');
    const h = setup({ notify: failure });
    h.seedPending(backlogChat(1));

    await expect(h.collector.flush()).rejects.toBe(failure);

    expect(h.closed).toEqual([]);
    expect(h.pending()).toHaveLength(1);
  });

  it('второй flush после успешного: список пуст, второго уведомления нет', async () => {
    const h = setup();
    h.seedPending(backlogChat(1));

    await h.collector.flush();
    await h.collector.flush();

    expect(h.notifications).toHaveLength(1);
  });

  it('два flush подряд без ожидания (событие приходит дважды): одно уведомление', async () => {
    const h = setup();
    h.seedPending(backlogChat(1));

    await Promise.all([h.collector.flush(), h.collector.flush()]);

    expect(h.notifications).toHaveLength(1);
    expect(h.closed).toHaveLength(1);
  });

  it('после неудачного flush следующий работает: очередь не застревает', async () => {
    const h = setup({ notifyScript: [new Error('база недоступна'), 'sent'] });
    h.seedPending(backlogChat(1));

    await expect(h.collector.flush()).rejects.toThrow('база недоступна');
    await expect(h.collector.flush()).resolves.toBeUndefined();

    expect(h.notifications).toHaveLength(2);
    expect(h.pending()).toEqual([]);
  });

  it('порог простоя в заголовке берётся из настройки', async () => {
    const h = setup();
    h.seedPending(backlogChat(1));

    await h.collector.flush();

    expect(h.notifications[0]?.text).toContain('сообщения старше 12 часов остались без ответа');
  });

  describe('чаты, где после отметки простоя что-то произошло', () => {
    it('свежее сообщение клиента: бот ответит как обычно, в список чат не входит, отметка закрывается', async () => {
      const h = setup();
      const quiet = backlogChat(1);
      const alive = backlogChat(2);
      h.seedPending(quiet);
      h.seedPending(alive);
      h.seedHistory(stored(quiet.chatId, { tsMs: quiet.lastMessageAtMs }));
      h.seedHistory(stored(alive.chatId, { tsMs: alive.lastMessageAtMs }));
      h.seedHistory(stored(alive.chatId, { id: 2, tsMs: T0 - HOUR_MS }));

      await h.collector.flush();

      expect(h.notifications).toEqual([
        { kind: 'backlog', chatId: null, text: formatBacklogNotification([quiet], 12) },
      ]);
      const closedIds = h.closed.flatMap((call) => call.chatIds).toSorted((a, b) => a - b);
      expect(closedIds).toEqual([quiet.chatId, alive.chatId]);
      expect(h.pending()).toEqual([]);
    });

    it.each(['bot', 'human_phone', 'human_panel'] as const)(
      'на сообщение уже ответил (%s): менеджеру о нём не сообщается',
      async (author) => {
        const h = setup();
        const chat = backlogChat(1);
        h.seedPending(chat);
        h.seedHistory(stored(chat.chatId, { tsMs: chat.lastMessageAtMs }));
        h.seedHistory(stored(chat.chatId, { id: 2, author, tsMs: chat.lastMessageAtMs + HOUR_MS }));

        await h.collector.flush();

        expect(h.notifications).toEqual([]);
        expect(h.closed).toEqual([{ chatIds: [chat.chatId], nowMs: T0 }]);
      },
    );

    it('последнее сообщение и есть то самое старое: чат в списке', async () => {
      const h = setup();
      const chat = backlogChat(1);
      h.seedPending(chat);
      h.seedHistory(stored(chat.chatId, { tsMs: chat.lastMessageAtMs }));

      await h.collector.flush();

      expect(h.notifications).toHaveLength(1);
    });

    it('все чаты уже в работе: уведомления нет, отметки закрыты', async () => {
      const h = setup();
      const chat = backlogChat(1);
      h.seedPending(chat);
      h.seedHistory(stored(chat.chatId, { tsMs: T0 - HOUR_MS }));

      await h.collector.flush();

      expect(h.notifications).toEqual([]);
      expect(h.pending()).toEqual([]);
    });
  });

  it('в лог не попадают имена, номера и тексты, только число чатов и итог', async () => {
    const h = setup();
    h.seedPending(backlogChat(1, { name: SECRET_NAME }));

    await h.collector.flush();

    const logged = loggedText(h.logs);
    expect(h.logs.length).toBeGreaterThan(0);
    expect(logged).not.toContain(SECRET_NAME);
    expect(logged).not.toContain('77000000001');
    expect(h.logs.some((entry) => entry.context['count'] === 1)).toBe(true);
  });
});
