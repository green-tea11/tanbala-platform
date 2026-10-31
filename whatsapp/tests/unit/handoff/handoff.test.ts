import { describe, expect, it } from 'vitest';
import type { CompanySummary } from '../../../src/domain/company.js';
import type { ChatsRepo, Clock, HandoffsRepo } from '../../../src/domain/ports.js';
import type {
  BotNote,
  Chat,
  ChatControl,
  ChatId,
  ChatProgress,
  HandoffNotice,
  Jid,
  ManagerNotificationKind,
  ManagerNotificationStatus,
  ReviewedText,
  StatusChange,
  WaMessageId,
} from '../../../src/domain/types.js';
import {
  createHandoffService,
  PHRASE_RETRY_DELAY_MS,
  type HandOffRequest,
  type HandoffService,
} from '../../../src/handoff/handoff.js';
import {
  formatManagerNotification,
  type NotificationReason,
} from '../../../src/handoff/notification.js';
import type { ManagerNotifier, NotifyContext } from '../../../src/handoff/notifier.js';
import type { Outbox } from '../../../src/messaging/outbox.js';
import {
  chatIdOf,
  CLIENT_PHONE,
  CONFIRMED_SUMMARY,
  createFakeLogger,
  createFakeUnitOfWork,
  createManualClock,
  FULL_PROFILE,
  loggedText,
  makeChat,
  OFF_SUMMARY,
  T0,
  type LogEntry,
} from './fakes.js';

const CHAT_ID = chatIdOf(12);
const IN_1 = 'IN-1' as WaMessageId;

type Phrase = Awaited<ReturnType<Outbox['sendHandoffNotice']>>;

/** Сообщение модели, прошедшее проверки: уходит вместо фиксированной фразы. */
const MODEL_TEXT =
  'Да, мы проводим интеграцию с вашей 1С, детали решаем по вашей конфигурации. Стоимость зависит от вашей задачи, уточню у коллеги и вернусь к вам.' as ReviewedText;

interface OpenedHandoff {
  readonly chatId: ChatId;
  readonly reason: string;
  readonly level: string;
  readonly snapshot: string;
  readonly nowMs: number;
}

interface StatusChangeCall {
  readonly id: ChatId;
  readonly change: StatusChange;
  readonly nowMs: number;
}

interface NoticeCall {
  readonly chatId: ChatId;
  readonly notice: HandoffNotice;
  readonly replyToWaId: WaMessageId;
}

interface TextCall {
  readonly chatId: ChatId;
  readonly text: ReviewedText;
  readonly replyToWaId: WaMessageId;
}

interface NotifyCall {
  readonly kind: ManagerNotificationKind;
  readonly chatId: ChatId | null;
  readonly text: string;
  readonly context: NotifyContext | undefined;
}

interface SetupOptions {
  /** Чат в базе; null: чата нет. */
  readonly chat?: Chat | null;
  /** Открытая передача уже есть. */
  readonly alreadyOpen?: boolean;
  /** Что ответит отправка фразы клиенту. */
  readonly phrase?: Phrase | Error;
  /** Ответы отправки фразы по порядку вызовов; когда они кончились, действует phrase. */
  readonly phraseScript?: readonly (Phrase | Error)[];
  /** Отправка фразы бросает не ошибку, а это значение (например, строку). */
  readonly phraseThrows?: { readonly value: unknown };
  /** Отправка фразы не завершается никогда: так выглядит окно, в котором процесс может упасть. */
  readonly phraseHangs?: boolean;
  /** Что ответит отправка уведомления менеджеру. */
  readonly notify?: ManagerNotificationStatus | Error;
  /** Смена статуса чата падает этой ошибкой. */
  readonly setStatusError?: Error;
  /** Запись передачи падает этой ошибкой. */
  readonly openError?: Error;
  /** Сводка о компании клиента (по умолчанию функция выключена) или ошибка её чтения. */
  readonly company?: CompanySummary | Error;
  /** Снятие ожидания ответа о компании падает этой ошибкой. */
  readonly stopAwaitingError?: Error;
  /** Ход разговора чата (рассказанные сильные стороны) или ошибка его чтения; по умолчанию ничего не рассказано. */
  readonly progress?: ChatProgress | Error;
}

interface Harness {
  readonly service: HandoffService;
  readonly events: string[];
  readonly logs: LogEntry[];
  readonly opened: OpenedHandoff[];
  readonly resolved: { readonly chatId: ChatId; readonly nowMs: number }[];
  readonly statusChanges: StatusChangeCall[];
  readonly notices: NoticeCall[];
  /** Сообщения модели, отправленные клиенту вместо фиксированной фразы. */
  readonly texts: TextCall[];
  readonly notifications: NotifyCall[];
  /** ID чатов, для которых читалась сводка о компании. */
  readonly summaries: ChatId[];
  /** ID чатов, для которых снималось ожидание ответа на «Вы из компании X?». */
  readonly stopped: ChatId[];
  /** ID чатов, у которых возврат боту обнулил ход разговора о цене. */
  readonly progressResets: ChatId[];
  /** Записи заметки для бота: поставлена при возврате, снята (null) при передаче. */
  readonly notes: { id: ChatId; note: BotNote | null }[];
}

function setup(options: SetupOptions = {}): Harness {
  const events: string[] = [];
  const logs: LogEntry[] = [];
  const opened: OpenedHandoff[] = [];
  const resolved: { chatId: ChatId; nowMs: number }[] = [];
  const statusChanges: StatusChangeCall[] = [];
  const notices: NoticeCall[] = [];
  const texts: TextCall[] = [];
  const notifications: NotifyCall[] = [];
  const summaries: ChatId[] = [];
  const stopped: ChatId[] = [];
  const progressResets: ChatId[] = [];
  const notes: { id: ChatId; note: BotNote | null }[] = [];
  let chat = options.chat === undefined ? makeChat() : options.chat;
  let isOpen = options.alreadyOpen === true;
  const unexpected = (): never => {
    throw new Error('Неожиданный вызов');
  };
  const chats: ChatsRepo = {
    upsertByIdentity: unexpected,
    findByJid: unexpected,
    getById: (id) => (chat !== null && chat.id === id ? chat : null),
    setStatus: (id, change, nowMs) => {
      events.push('chats.setStatus');
      if (options.setStatusError !== undefined) throw options.setStatusError;
      statusChanges.push({ id, change, nowMs });
      if (chat !== null) chat = { ...chat, control: controlAfter(change) };
    },
    saveAssessment: unexpected,
    listForPanel: unexpected,
    countForPanel: unexpected,
    getProgress: () => {
      const progress = options.progress ?? { priceAsks: 0, refused: false };
      if (progress instanceof Error) throw progress;
      return progress;
    },
    recordTurn: unexpected,
    recordReply: unexpected,
    resetProgress: (id) => {
      events.push('chats.resetProgress');
      progressResets.push(id);
    },
    getNote: unexpected,
    setNote: (id, note) => {
      events.push('chats.setNote');
      notes.push({ id, note });
    },
  };
  const handoffs: HandoffsRepo = {
    open: (chatId, reason, level, snapshot, nowMs) => {
      events.push('handoffs.open');
      if (options.openError !== undefined) throw options.openError;
      opened.push({ chatId, reason, level, snapshot, nowMs });
      if (isOpen) return false;
      isOpen = true;
      return true;
    },
    findOpen: unexpected,
    resolve: (chatId, nowMs) => {
      events.push('handoffs.resolve');
      resolved.push({ chatId, nowMs });
      isOpen = false;
    },
  };
  // Фраза и сообщение модели идут одним путём отправки клиенту: сценарий options.phrase* общий.
  const deliver = (): Promise<Phrase> => {
    const phrase =
      options.phraseScript?.[notices.length + texts.length - 1] ?? options.phrase ?? 'sent';
    if (options.phraseThrows !== undefined) throw options.phraseThrows.value;
    if (options.phraseHangs === true) return new Promise<Phrase>(() => undefined);
    return phrase instanceof Error ? Promise.reject(phrase) : Promise.resolve(phrase);
  };
  const outbox: Pick<Outbox, 'sendHandoffNotice' | 'sendHandoffText'> = {
    sendHandoffNotice: (chatId, notice, replyToWaId) => {
      events.push('outbox.sendHandoffNotice');
      notices.push({ chatId, notice, replyToWaId });
      return deliver();
    },
    sendHandoffText: (chatId, text, replyToWaId) => {
      events.push('outbox.sendHandoffText');
      texts.push({ chatId, text, replyToWaId });
      return deliver();
    },
  };
  const notifier: Pick<ManagerNotifier, 'notify'> = {
    notify: (kind, chatId, text, context) => {
      events.push('notifier.notify');
      notifications.push({ kind, chatId, text, context });
      const result = options.notify ?? 'sent';
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
  const clock: Clock = {
    ...createManualClock(),
    sleep: (ms) => {
      events.push(`clock.sleep:${ms}`);
      return Promise.resolve();
    },
  };
  const company = {
    summary: (chatId: ChatId): CompanySummary => {
      summaries.push(chatId);
      const summary = options.company ?? OFF_SUMMARY;
      if (summary instanceof Error) throw summary;
      return summary;
    },
    stopAwaiting: (chatId: ChatId): void => {
      events.push('company.stopAwaiting');
      stopped.push(chatId);
      if (options.stopAwaitingError !== undefined) throw options.stopAwaitingError;
    },
  };
  const service = createHandoffService({
    chats,
    handoffs,
    unitOfWork: createFakeUnitOfWork(events),
    outbox,
    notifier,
    company,
    clock,
    logger: createFakeLogger(logs),
  });
  return {
    service,
    events,
    logs,
    opened,
    resolved,
    statusChanges,
    notices,
    texts,
    notifications,
    summaries,
    stopped,
    progressResets,
    notes,
  };
}

/** Снятие ожидания ответа на «Вы из компании X?»: последний шаг любой передачи, чат уже у менеджера. */
const STOP_AWAITING = 'company.stopAwaiting';

// Уведомление менеджеру идёт сразу после транзакции, до фразы клиенту: фраза может ждать повтор 5 с, и падение
// процесса в этом окне не должно оставить горячего клиента без записи в manager_notifications.
const PHRASE_FLOW = [
  'tx:begin',
  'handoffs.open',
  'chats.setStatus',
  'chats.setNote',
  'tx:commit',
  'notifier.notify',
  'outbox.sendHandoffNotice',
];

/** Передача с фразой целиком: после фразы снимается ожидание ответа о компании. */
const FULL_FLOW = [...PHRASE_FLOW, STOP_AWAITING];

type PlainReason = 'hot' | 'no_answer' | 'check_failed' | 'asked_human' | 'llm_error';

/** Запрос передачи с фразой клиенту, кроме жалобы (у неё свой параметр). */
function plainRequest(reason: PlainReason): HandOffRequest {
  const notice: HandoffNotice = { reason };
  return { ...notice, replyToWaId: IN_1 };
}

function controlAfter(change: StatusChange): ChatControl {
  return change.status === 'manager'
    ? { status: 'manager', by: change.by }
    : { status: 'bot', by: change.by };
}

/** Текст уведомления для чата по умолчанию (makeChat) с заданной причиной; компания по умолчанию: функция выключена. */
function notificationFor(
  reason: NotificationReason,
  company: CompanySummary | null = OFF_SUMMARY,
): string {
  return formatManagerNotification({
    ...reason,
    name: 'Иван Петров',
    phone: CLIENT_PHONE,
    level: 'warm',
    profile: FULL_PROFILE,
    chatId: CHAT_ID,
    company,
  });
}

describe('createHandoffService: handOff с фразой клиенту', () => {
  it('горячий клиент: запись передачи и статус manager в одной транзакции, затем уведомление менеджеру, затем фраза клиенту', async () => {
    const h = setup();

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

    expect(h.events).toEqual(FULL_FLOW);
    expect(h.opened).toEqual([
      {
        chatId: CHAT_ID,
        reason: 'hot',
        level: 'warm',
        snapshot: JSON.stringify(FULL_PROFILE),
        nowMs: T0,
      },
    ]);
    expect(h.statusChanges).toEqual([
      { id: CHAT_ID, change: { status: 'manager', by: 'bot' }, nowMs: T0 },
    ]);
    expect(h.notices).toEqual([{ chatId: CHAT_ID, notice: { reason: 'hot' }, replyToWaId: IN_1 }]);
    expect(h.notifications).toEqual([
      {
        kind: 'handoff',
        chatId: CHAT_ID,
        text: notificationFor({ reason: 'hot' }),
        context: { reason: 'hot' },
      },
    ]);
  });

  it('hot после вопроса цены: фраза с пометкой aboutPrice, уведомление как у hot', async () => {
    const h = setup();

    await h.service.handOff(CHAT_ID, { reason: 'hot', aboutPrice: true, replyToWaId: IN_1 });

    expect(h.events).toEqual(FULL_FLOW);
    expect(h.notices).toStrictEqual([
      { chatId: CHAT_ID, notice: { reason: 'hot', aboutPrice: true }, replyToWaId: IN_1 },
    ]);
    expect(h.notifications[0]?.text).toBe(notificationFor({ reason: 'hot' }));
  });

  it('hot с aboutPrice false: в фразе пометки нет', async () => {
    const h = setup();

    await h.service.handOff(CHAT_ID, { reason: 'hot', aboutPrice: false, replyToWaId: IN_1 });

    expect(h.notices).toStrictEqual([
      { chatId: CHAT_ID, notice: { reason: 'hot' }, replyToWaId: IN_1 },
    ]);
  });

  it('текст уведомления: имя, номер, уровень и выжимка чата из базы', async () => {
    const h = setup({ chat: makeChat({ level: 'hot', pushName: 'Анна' }) });

    await h.service.handOff(CHAT_ID, { reason: 'asked_human', replyToWaId: IN_1 });

    const text = h.notifications[0]?.text ?? '';
    expect(text).toContain('клиент просит живого человека');
    expect(text).toContain('Имя в WhatsApp: Анна');
    expect(text).toContain('Номер: +77000000001');
    expect(text).toContain('Уровень интереса: горячий');
    expect(text).toContain('Бизнес: магазин одежды');
    expect(h.opened[0]?.level).toBe('hot');
  });

  it('причина своими словами (detail): строкой «Причина» сразу после заголовка, фраза клиенту прежняя', async () => {
    const h = setup();
    const detail = 'Спрашивает цену, сроки или договор, задача понятна. Клиент: «Так сколько?»';

    await h.service.handOff(CHAT_ID, {
      reason: 'hot',
      aboutPrice: true,
      replyToWaId: IN_1,
      detail,
    });

    const lines = (h.notifications[0]?.text ?? '').split('\n');
    expect(lines[0]).toBe('Передача чата менеджеру: горячий клиент.');
    expect(lines[1]).toBe(`Причина: ${detail}`);
    expect(h.notices).toStrictEqual([
      { chatId: CHAT_ID, notice: { reason: 'hot', aboutPrice: true }, replyToWaId: IN_1 },
    ]);
  });

  it('причина своими словами у сообщения модели: та же строка, клиенту текст модели', async () => {
    const h = setup();
    const detail = 'Ответа нет в документах. Клиент: «А RFID видит сквозь металл?»';

    await h.service.handOff(CHAT_ID, {
      reason: 'no_answer',
      replyToWaId: IN_1,
      text: 'Уточню у коллеги и вернусь к вам.' as ReviewedText,
      detail,
    });

    expect(h.notifications[0]?.text.split('\n')[1]).toBe(`Причина: ${detail}`);
    expect(h.texts).toHaveLength(1);
  });

  it('без причины своими словами (технические поводы): строки «Причина» нет', async () => {
    const h = setup();

    await h.service.handOff(CHAT_ID, plainRequest('check_failed'));

    expect(h.notifications[0]?.text).not.toContain('Причина:');
  });

  it.each(['no_answer', 'check_failed', 'asked_human', 'llm_error'] as const)(
    'повод %s: фраза этого повода и уведомление handoff',
    async (reason) => {
      const h = setup();

      await h.service.handOff(CHAT_ID, plainRequest(reason));

      expect(h.events).toEqual(FULL_FLOW);
      expect(h.notices).toEqual([{ chatId: CHAT_ID, notice: { reason }, replyToWaId: IN_1 }]);
      expect(h.opened[0]?.reason).toBe(reason);
      expect(h.notifications[0]).toMatchObject({ kind: 'handoff', context: { reason } });
      expect(h.notifications[0]?.text).toBe(notificationFor({ reason }));
    },
  );

  it.each([true, false])(
    'жалоба, клиент просит больше не писать: %s; повод передаётся фразе как есть',
    async (stopRequested) => {
      const h = setup();

      await h.service.handOff(CHAT_ID, { reason: 'complaint', stopRequested, replyToWaId: IN_1 });

      expect(h.events).toEqual(FULL_FLOW);
      expect(h.notices).toEqual([
        { chatId: CHAT_ID, notice: { reason: 'complaint', stopRequested }, replyToWaId: IN_1 },
      ]);
      expect(h.notifications[0]?.text).toBe(notificationFor({ reason: 'complaint' }));
    },
  );

  it('номера нет (чат только с @lid): в уведомлении «номер скрыт» и ID чата', async () => {
    const lid = '100000000000001@lid' as Jid;
    const h = setup({
      chat: makeChat({ identity: { replyJid: lid, lidJid: lid, pnJid: null } }),
    });

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

    expect(h.notifications[0]?.text).toContain('Номер: номер скрыт, чат ищите в панели по ID 12');
  });

  it('номер берётся из адреса без суффикса устройства', async () => {
    const jid = '77000000001:7@s.whatsapp.net' as Jid;
    const h = setup({ chat: makeChat({ identity: { replyJid: jid, lidJid: null, pnJid: jid } }) });

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

    expect(h.notifications[0]?.text).toContain('Номер: +77000000001\n');
  });

  it('open вернул false (передача уже открыта): ни фразы, ни уведомления, ни смены статуса', async () => {
    const h = setup({
      alreadyOpen: true,
      chat: makeChat({ control: { status: 'manager', by: 'bot' } }),
    });

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

    expect(h.events).toEqual(['tx:begin', 'handoffs.open', 'tx:commit', STOP_AWAITING]);
    expect(h.statusChanges).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

  it('повтор той же передачи подряд ничего не дублирует', async () => {
    const h = setup();

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });
    await h.service.handOff(CHAT_ID, { reason: 'no_answer', replyToWaId: IN_1 });

    expect(h.notices).toHaveLength(1);
    expect(h.notifications).toHaveLength(1);
    expect(h.statusChanges).toHaveLength(1);
    expect(h.opened).toHaveLength(2);
  });

  it('человек уже ведёт чат, а бот в это время дописал ответ: передача не открывается второй раз', async () => {
    const h = setup({
      alreadyOpen: true,
      chat: makeChat({ control: { status: 'manager', by: 'phone' } }),
    });

    await h.service.handOff(CHAT_ID, { reason: 'check_failed', replyToWaId: IN_1 });

    expect(h.statusChanges).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

  it('чата нет: отказ, ничего не записано и не отправлено', async () => {
    const h = setup({ chat: null });

    await expect(h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 })).rejects.toThrow(
      /не найден/,
    );
    expect(h.events).toEqual([]);
  });

  it('смена статуса не удалась: запись передачи откатывается, фразы и уведомления нет', async () => {
    const failure = new Error('база недоступна');
    const h = setup({ setStatusError: failure });

    await expect(h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 })).rejects.toBe(
      failure,
    );
    expect(h.events).toEqual(['tx:begin', 'handoffs.open', 'chats.setStatus', 'tx:rollback']);
    expect(h.notices).toEqual([]);
    expect(h.notifications).toEqual([]);
    expect(h.stopped).toEqual([]);
  });

  it('запись передачи не удалась: статус не меняется, фразы и уведомления нет', async () => {
    const failure = new Error('база недоступна');
    const h = setup({ openError: failure });

    await expect(h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 })).rejects.toBe(
      failure,
    );
    expect(h.events).toEqual(['tx:begin', 'handoffs.open', 'tx:rollback']);
  });

  it('исключение отправки фразы (сокет переподключается): один повтор через 5 с, уведомление менеджеру уже записано до первой попытки', async () => {
    const h = setup({ phraseScript: [new Error('Connection Closed'), 'sent'] });

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

    expect(PHRASE_RETRY_DELAY_MS).toBe(5_000);
    expect(h.events).toEqual([
      'tx:begin',
      'handoffs.open',
      'chats.setStatus',
      'chats.setNote',
      'tx:commit',
      'notifier.notify',
      'outbox.sendHandoffNotice',
      'clock.sleep:5000',
      'outbox.sendHandoffNotice',
      STOP_AWAITING,
    ]);
    expect(h.notices).toEqual([
      { chatId: CHAT_ID, notice: { reason: 'hot' }, replyToWaId: IN_1 },
      { chatId: CHAT_ID, notice: { reason: 'hot' }, replyToWaId: IN_1 },
    ]);
    expect(h.logs.filter((entry) => entry.level === 'error')).toEqual([]);
    expect(h.logs.filter((entry) => entry.level === 'warn')).toEqual([
      expect.objectContaining({ context: { chatId: CHAT_ID, errorName: 'Error' } }),
    ]);
  });

  it.each(['hot', 'no_answer', 'check_failed', 'asked_human', 'llm_error'] as const)(
    'оба раза исключение (повод %s): ошибка «клиент остался без фразы передачи» без текста и номера, уведомление менеджеру уже ушло до фразы',
    async (reason) => {
      const h = setup({ phrase: new Error('Connection Closed') });

      await expect(h.service.handOff(CHAT_ID, plainRequest(reason))).resolves.toBeUndefined();

      expect(h.notices).toHaveLength(2);
      expect(h.notifications).toHaveLength(1);
      expect(h.statusChanges).toHaveLength(1);
      expect(h.logs.filter((entry) => entry.level === 'error')).toEqual([
        expect.objectContaining({
          context: { chatId: CHAT_ID, reason, errorName: 'Error' },
          message: expect.stringContaining('Клиент остался без фразы передачи') as unknown,
        }),
      ]);
      for (const secret of ['Иван', '77000000001', 'магазин одежды']) {
        expect(loggedText(h.logs)).not.toContain(secret);
      }
    },
  );

  it('брошена не ошибка, а строка: в лог идёт только тип значения', async () => {
    const h = setup({ phraseThrows: { value: 'Connection Closed: 77000000001' } });

    await expect(
      h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 }),
    ).resolves.toBeUndefined();

    expect(h.logs.filter((entry) => entry.level === 'error')).toEqual([
      expect.objectContaining({ context: { chatId: CHAT_ID, reason: 'hot', errorName: 'string' } }),
    ]);
    expect(loggedText(h.logs)).not.toContain('77000000001');
  });

  it('жалоба: повтор фразы идёт с теми же параметрами, повод в строке ошибки', async () => {
    const h = setup({ phrase: new Error('Connection Closed') });

    await h.service.handOff(CHAT_ID, {
      reason: 'complaint',
      stopRequested: true,
      replyToWaId: IN_1,
    });

    expect(h.notices).toEqual([
      { chatId: CHAT_ID, notice: { reason: 'complaint', stopRequested: true }, replyToWaId: IN_1 },
      { chatId: CHAT_ID, notice: { reason: 'complaint', stopRequested: true }, replyToWaId: IN_1 },
    ]);
    expect(h.logs.filter((entry) => entry.level === 'error')[0]?.context).toMatchObject({
      reason: 'complaint',
    });
  });

  it.each(['skipped_limit', 'skipped_test_mode', 'skipped_no_inbound', 'disabled'] as const)(
    'фраза не отправлена, но без исключения (%s): без повтора, строка warn, уведомление менеджеру уходит',
    async (phrase) => {
      const h = setup({ phrase });

      await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

      expect(h.notices).toHaveLength(1);
      expect(h.events).not.toContain('clock.sleep:5000');
      expect(h.notifications).toHaveLength(1);
      expect(h.logs.filter((entry) => entry.level === 'warn')).toEqual([
        expect.objectContaining({ context: { chatId: CHAT_ID, result: phrase } }),
      ]);
      expect(h.logs.filter((entry) => entry.level === 'error')).toEqual([]);
    },
  );

  it('повтор вернул отказ без исключения: больше не повторяется, результат в warn', async () => {
    const h = setup({ phraseScript: [new Error('Connection Closed'), 'skipped_limit'] });

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

    expect(h.notices).toHaveLength(2);
    expect(h.logs.filter((entry) => entry.level === 'warn')).toEqual([
      expect.objectContaining({ context: { chatId: CHAT_ID, errorName: 'Error' } }),
      expect.objectContaining({ context: { chatId: CHAT_ID, result: 'skipped_limit' } }),
    ]);
    expect(h.logs.filter((entry) => entry.level === 'error')).toEqual([]);
  });

  it('уведомление не записалось: передача остаётся, фраза клиенту всё равно уходит, ошибка в лог, наружу не бросается', async () => {
    const failure = new Error('база недоступна');
    const h = setup({ notify: failure });

    await expect(
      h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 }),
    ).resolves.toBeUndefined();

    expect(h.statusChanges).toHaveLength(1);
    expect(h.events).toEqual(FULL_FLOW);
    expect(h.notices).toEqual([{ chatId: CHAT_ID, notice: { reason: 'hot' }, replyToWaId: IN_1 }]);
    expect(h.logs.filter((entry) => entry.level === 'error')).toEqual([
      expect.objectContaining({
        context: { err: failure, chatId: CHAT_ID, kind: 'handoff' },
      }),
    ]);
  });

  it('фраза клиенту зависла (так выглядит падение в окне повтора): уведомление менеджеру уже записано', async () => {
    const h = setup({ phraseHangs: true });

    void h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    // Ожидание ответа о компании снимается после фразы; до того чат уже у менеджера, а бот молчит.
    expect(h.events).toEqual(PHRASE_FLOW);
    expect(h.notifications).toEqual([
      expect.objectContaining({ kind: 'handoff', chatId: CHAT_ID, context: { reason: 'hot' } }),
    ]);
  });

  it.each(['no_manager', 'skipped_limit', 'failed', 'sent'] as const)(
    'итог уведомления %s не меняет передачу: она уже записана',
    async (notify) => {
      const h = setup({ notify });

      await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

      expect(h.events).toEqual(FULL_FLOW);
    },
  );

  it('в лог не попадают имя, номер и выжимка клиента', async () => {
    const h = setup();

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

    const logged = loggedText(h.logs);
    expect(h.logs.length).toBeGreaterThan(0);
    for (const secret of ['Иван', '77000000001', 'магазин одежды', 'путаница']) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe('createHandoffService: handOff с сообщением модели вместо фразы', () => {
  const TEXT_FLOW = [
    'tx:begin',
    'handoffs.open',
    'chats.setStatus',
    'chats.setNote',
    'tx:commit',
    'notifier.notify',
    'outbox.sendHandoffText',
    STOP_AWAITING,
  ];

  it('горячий клиент: порядок прежний, уведомление менеджеру до сообщения клиенту; клиенту уходит этот текст, фиксированной фразы нет', async () => {
    const h = setup({ chat: makeChat({ level: 'hot' }) });

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1, text: MODEL_TEXT });

    expect(h.events).toEqual(TEXT_FLOW);
    expect(h.texts).toEqual([{ chatId: CHAT_ID, text: MODEL_TEXT, replyToWaId: IN_1 }]);
    expect(h.notices).toEqual([]);
    expect(h.opened[0]).toMatchObject({ chatId: CHAT_ID, reason: 'hot', level: 'hot' });
    expect(h.statusChanges).toEqual([
      { id: CHAT_ID, change: { status: 'manager', by: 'bot' }, nowMs: T0 },
    ]);
    expect(h.notifications).toEqual([
      {
        kind: 'handoff',
        chatId: CHAT_ID,
        text: formatManagerNotification({
          reason: 'hot',
          name: 'Иван Петров',
          phone: CLIENT_PHONE,
          level: 'hot',
          profile: FULL_PROFILE,
          chatId: CHAT_ID,
          company: OFF_SUMMARY,
        }),
        context: { reason: 'hot' },
      },
    ]);
    expect(h.notifications[0]?.text).toContain('горячий клиент');
  });

  it.each(['hot', 'no_answer', 'asked_human'] as const)(
    'повод %s: причина в записи и уведомлении своя, клиенту текст модели',
    async (reason) => {
      const h = setup();

      await h.service.handOff(CHAT_ID, { reason, replyToWaId: IN_1, text: MODEL_TEXT });

      expect(h.events).toEqual(TEXT_FLOW);
      expect(h.opened[0]?.reason).toBe(reason);
      expect(h.notifications[0]).toMatchObject({ kind: 'handoff', context: { reason } });
      expect(h.notifications[0]?.text).toBe(notificationFor({ reason }));
      expect(h.texts).toHaveLength(1);
      expect(h.notices).toEqual([]);
    },
  );

  it('без text клиенту уходит фиксированная фраза, как раньше', async () => {
    const h = setup();

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

    expect(h.events).toEqual(FULL_FLOW);
    expect(h.texts).toEqual([]);
    expect(h.notices).toEqual([{ chatId: CHAT_ID, notice: { reason: 'hot' }, replyToWaId: IN_1 }]);
  });

  it('исключение отправки (сокет переподключается): один повтор через 5 с с тем же текстом', async () => {
    const h = setup({ phraseScript: [new Error('Connection Closed'), 'sent'] });

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1, text: MODEL_TEXT });

    expect(h.events).toEqual([
      'tx:begin',
      'handoffs.open',
      'chats.setStatus',
      'chats.setNote',
      'tx:commit',
      'notifier.notify',
      'outbox.sendHandoffText',
      'clock.sleep:5000',
      'outbox.sendHandoffText',
      STOP_AWAITING,
    ]);
    expect(h.texts).toEqual([
      { chatId: CHAT_ID, text: MODEL_TEXT, replyToWaId: IN_1 },
      { chatId: CHAT_ID, text: MODEL_TEXT, replyToWaId: IN_1 },
    ]);
    expect(h.notices).toEqual([]);
    expect(h.logs.filter((entry) => entry.level === 'error')).toEqual([]);
  });

  it('оба раза исключение: ошибка «клиент остался без фразы передачи», в лог нет текста сообщения, имени и номера', async () => {
    const h = setup({ phrase: new Error('Connection Closed') });

    await expect(
      h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1, text: MODEL_TEXT }),
    ).resolves.toBeUndefined();

    expect(h.texts).toHaveLength(2);
    expect(h.notifications).toHaveLength(1);
    expect(h.logs.filter((entry) => entry.level === 'error')).toEqual([
      expect.objectContaining({
        context: { chatId: CHAT_ID, reason: 'hot', errorName: 'Error' },
      }),
    ]);
    for (const secret of ['Иван', '77000000001', 'интеграцию', 'конфигурации']) {
      expect(loggedText(h.logs)).not.toContain(secret);
    }
  });

  it.each(['skipped_limit', 'skipped_test_mode', 'skipped_no_inbound', 'disabled'] as const)(
    'отправка отказала без исключения (%s): без повтора, строка warn, уведомление менеджеру уходит',
    async (phrase) => {
      const h = setup({ phrase });

      await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1, text: MODEL_TEXT });

      expect(h.texts).toHaveLength(1);
      expect(h.events).not.toContain('clock.sleep:5000');
      expect(h.notifications).toHaveLength(1);
      expect(h.logs.filter((entry) => entry.level === 'warn')).toEqual([
        expect.objectContaining({ context: { chatId: CHAT_ID, result: phrase } }),
      ]);
    },
  );

  it('передача уже открыта: ни текста, ни фразы, ни уведомления', async () => {
    const h = setup({
      alreadyOpen: true,
      chat: makeChat({ control: { status: 'manager', by: 'bot' } }),
    });

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1, text: MODEL_TEXT });

    expect(h.events).toEqual(['tx:begin', 'handoffs.open', 'tx:commit', STOP_AWAITING]);
    expect(h.texts).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

  it('запись передачи не удалась: сообщение клиенту не отправляется', async () => {
    const failure = new Error('база недоступна');
    const h = setup({ openError: failure });

    await expect(
      h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1, text: MODEL_TEXT }),
    ).rejects.toBe(failure);
    expect(h.texts).toEqual([]);
  });

  it('в лог не попадает текст сообщения модели', async () => {
    const h = setup();

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1, text: MODEL_TEXT });

    expect(loggedText(h.logs)).not.toContain('интеграцию');
    expect(loggedText(h.logs)).not.toContain('вашей задачи');
  });
});

describe('createHandoffService: handOff без фразы клиенту', () => {
  it.each(['chat', 'global'] as const)(
    'лимит, область %s: статус manager (by bot), фразы нет, уведомление вида limit',
    async (scope) => {
      const h = setup();

      await h.service.handOff(CHAT_ID, { reason: 'limit', scope });

      expect(h.events).toEqual([
        'tx:begin',
        'handoffs.open',
        'chats.setStatus',
        'chats.setNote',
        'tx:commit',
        'notifier.notify',
        STOP_AWAITING,
      ]);
      expect(h.opened[0]).toMatchObject({ chatId: CHAT_ID, reason: 'limit' });
      expect(h.statusChanges).toEqual([
        { id: CHAT_ID, change: { status: 'manager', by: 'bot' }, nowMs: T0 },
      ]);
      expect(h.notices).toEqual([]);
      expect(h.notifications).toEqual([
        {
          kind: 'limit',
          chatId: CHAT_ID,
          text: notificationFor({ reason: 'limit', scope }),
          context: { reason: 'limit' },
        },
      ]);
      expect(h.notifications[0]?.text).toContain(
        scope === 'chat' ? 'API_DAILY_LIMIT_PER_CHAT' : 'исчерпан общий лимит бота на сутки',
      );
    },
  );

  it('лимит при уже открытой передаче: молча, без второго уведомления', async () => {
    const h = setup({
      alreadyOpen: true,
      chat: makeChat({ control: { status: 'manager', by: 'bot' } }),
    });

    await h.service.handOff(CHAT_ID, { reason: 'limit', scope: 'global' });

    expect(h.notifications).toEqual([]);
  });

  it.each(['phone', 'panel'] as const)(
    'человек подключился (%s): запись передачи и статус manager от его имени, без фразы и без уведомления',
    async (by) => {
      const h = setup();

      await h.service.handOff(CHAT_ID, { reason: 'human_took_over', by });

      expect(h.events).toEqual([
        'tx:begin',
        'handoffs.open',
        'chats.setStatus',
        'chats.setNote',
        'tx:commit',
        STOP_AWAITING,
      ]);
      expect(h.opened[0]).toMatchObject({ chatId: CHAT_ID, reason: 'human_took_over' });
      expect(h.statusChanges).toEqual([
        { id: CHAT_ID, change: { status: 'manager', by }, nowMs: T0 },
      ]);
      expect(h.notices).toEqual([]);
      expect(h.notifications).toEqual([]);
    },
  );

  it('чат передал бот, потом написал человек: передача уже есть, но статус переходит к человеку', async () => {
    const h = setup({
      alreadyOpen: true,
      chat: makeChat({ control: { status: 'manager', by: 'bot' } }),
    });

    await h.service.handOff(CHAT_ID, { reason: 'human_took_over', by: 'phone' });

    expect(h.events).toEqual([
      'tx:begin',
      'handoffs.open',
      'chats.setStatus',
      'tx:commit',
      STOP_AWAITING,
    ]);
    expect(h.statusChanges).toEqual([
      { id: CHAT_ID, change: { status: 'manager', by: 'phone' }, nowMs: T0 },
    ]);
    expect(h.notifications).toEqual([]);
  });

  it.each([
    ['phone', 'phone'],
    ['phone', 'panel'],
    ['panel', 'phone'],
  ] as const)(
    'чат уже ведёт человек (%s), пишет он же или другой (%s): время перехвата не сдвигается',
    async (current, by) => {
      const h = setup({
        alreadyOpen: true,
        chat: makeChat({ control: { status: 'manager', by: current } }),
      });

      await h.service.handOff(CHAT_ID, { reason: 'human_took_over', by });

      expect(h.statusChanges).toEqual([]);
      expect(h.events).toEqual(['tx:begin', 'handoffs.open', 'tx:commit', STOP_AWAITING]);
    },
  );

  it('статус bot при открытой передаче (рассинхрон): чат всё равно уходит менеджеру', async () => {
    const h = setup({ alreadyOpen: true });

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

    expect(h.statusChanges).toEqual([
      { id: CHAT_ID, change: { status: 'manager', by: 'bot' }, nowMs: T0 },
    ]);
    expect(h.notices).toEqual([]);
    expect(h.notifications).toEqual([]);
  });
});

describe('createHandoffService: рассказанное клиенту в уведомлении (решение владельца 30.10.2026)', () => {
  it('сильные стороны из хода разговора короткими названиями', async () => {
    const h = setup({ progress: { priceAsks: 0, refused: false, toldFacts: ['F1', 'F3'] } });

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

    expect(h.notifications[0]?.text).toContain(
      'Рассказано клиенту: метка без батарейки, антенны на входе и выходе',
    );
  });

  it('ход разговора прочитать не удалось: уведомление и фраза уходят, «ничего», в лог ID и имя ошибки', async () => {
    const h = setup({ progress: new TypeError('база недоступна') });

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

    expect(h.notifications[0]?.text).toContain('Рассказано клиенту: ничего');
    expect(h.notices).toHaveLength(1);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        context: { chatId: CHAT_ID, errorName: 'TypeError' },
      }),
    );
  });

  it('лимит: ход разговора не читается, строк для расчёта нет', async () => {
    const h = setup({ progress: new TypeError('не должен читаться') });

    await h.service.handOff(CHAT_ID, { reason: 'limit', scope: 'chat' });

    expect(h.notifications[0]?.text).not.toContain('Рассказано клиенту');
    expect(h.logs.filter((entry) => entry.level === 'warn')).toEqual([]);
  });
});

describe('createHandoffService: компания клиента в уведомлении', () => {
  it('передача: сводка о компании этого чата идёт строками после выжимки', async () => {
    const h = setup({ company: CONFIRMED_SUMMARY });

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

    expect(h.summaries).toEqual([CHAT_ID]);
    expect(h.notifications[0]?.text).toBe(notificationFor({ reason: 'hot' }, CONFIRMED_SUMMARY));
    expect(h.notifications[0]?.text).toContain(
      'Компания: «Мебель Плюс», Алматы (клиент подтвердил)\nКарточка: https://mail.example.kz/companies/42',
    );
  });

  it('функция выключена: «Компания: не определена» последней строкой', async () => {
    const h = setup();

    await h.service.handOff(CHAT_ID, { reason: 'no_answer', replyToWaId: IN_1 });

    expect(h.notifications[0]?.text.split('\n').at(-1)).toBe('Компания: не определена');
  });

  it.each(['chat', 'global'] as const)(
    'лимит (%s): сводку о компании не читает, текст уведомления прежний',
    async (scope) => {
      const h = setup({ company: CONFIRMED_SUMMARY });

      await h.service.handOff(CHAT_ID, { reason: 'limit', scope });

      expect(h.summaries).toEqual([]);
      expect(h.notifications[0]?.text).toBe(notificationFor({ reason: 'limit', scope }, null));
      expect(h.notifications[0]?.text).not.toContain('Компания');
    },
  );

  it('человек подключился: ни уведомления, ни чтения сводки', async () => {
    const h = setup({ company: CONFIRMED_SUMMARY });

    await h.service.handOff(CHAT_ID, { reason: 'human_took_over', by: 'panel' });

    expect(h.summaries).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

  it('сводку прочитать не удалось: уведомление и фраза уходят без строк о компании, в лог ID и имя ошибки', async () => {
    const h = setup({ company: new TypeError('база недоступна: Мебель Плюс') });

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

    expect(h.events).toEqual(FULL_FLOW);
    expect(h.notifications[0]?.text).toBe(notificationFor({ reason: 'hot' }, null));
    expect(h.logs.filter((entry) => entry.level === 'warn')).toEqual([
      expect.objectContaining({ context: { chatId: CHAT_ID, errorName: 'TypeError' } }),
    ]);
    expect(loggedText(h.logs)).not.toContain('Мебель');
  });

  it('в лог не попадает ничего из сводки: название, город, ссылка и боли', async () => {
    const h = setup({ company: CONFIRMED_SUMMARY });

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

    const logged = loggedText(h.logs);
    for (const secret of ['Мебель', 'Алматы', 'mail.example.kz', 'теряются', 'пересорт']) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe('createHandoffService: returnToBot', () => {
  it('закрывает передачу, ставит статус bot (by panel) и обнуляет ход разговора о цене одной транзакцией', async () => {
    const h = setup({
      alreadyOpen: true,
      chat: makeChat({ control: { status: 'manager', by: 'bot' } }),
    });

    await h.service.returnToBot(CHAT_ID);

    expect(h.events).toEqual([
      STOP_AWAITING,
      'tx:begin',
      'handoffs.resolve',
      'chats.setStatus',
      'chats.resetProgress',
      'chats.setNote',
      'tx:commit',
    ]);
    expect(h.progressResets).toEqual([CHAT_ID]);
    expect(h.stopped).toEqual([CHAT_ID]);
    expect(h.resolved).toEqual([{ chatId: CHAT_ID, nowMs: T0 }]);
    expect(h.statusChanges).toEqual([
      { id: CHAT_ID, change: { status: 'bot', by: 'panel' }, nowMs: T0 },
    ]);
    expect(h.notices).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

  it('после возврата новая передача открывается заново', async () => {
    const h = setup({
      alreadyOpen: true,
      chat: makeChat({ control: { status: 'manager', by: 'bot' } }),
    });
    await h.service.returnToBot(CHAT_ID);

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

    expect(h.notices).toHaveLength(1);
    expect(h.notifications).toHaveLength(1);
  });

  it('чата нет: отказ промиса, а не исключение при вызове', async () => {
    const h = setup({ chat: null });

    const returned = h.service.returnToBot(CHAT_ID);

    await expect(returned).rejects.toThrow(/не найден/);
    expect(h.events).toEqual([]);
  });

  it('смена статуса не удалась: передача остаётся открытой (откат), отказ промиса', async () => {
    const failure = new Error('база недоступна');
    const h = setup({
      alreadyOpen: true,
      chat: makeChat({ control: { status: 'manager', by: 'bot' } }),
      setStatusError: failure,
    });

    await expect(h.service.returnToBot(CHAT_ID)).rejects.toBe(failure);
    expect(h.events).toEqual([
      STOP_AWAITING,
      'tx:begin',
      'handoffs.resolve',
      'chats.setStatus',
      'tx:rollback',
    ]);
  });
});

describe('createHandoffService: ожидание ответа на «Вы из компании X?»', () => {
  it.each<[string, HandOffRequest]>([
    ['фраза', { reason: 'hot', replyToWaId: IN_1 }],
    ['сообщение модели', { reason: 'no_answer', replyToWaId: IN_1, text: MODEL_TEXT }],
    ['жалоба', { reason: 'complaint', stopRequested: false, replyToWaId: IN_1 }],
    ['лимит без фразы', { reason: 'limit', scope: 'chat' }],
    ['перехват с телефона', { reason: 'human_took_over', by: 'phone' }],
    ['перехват из панели', { reason: 'human_took_over', by: 'panel' }],
  ])('%s: последним шагом передачи снимается ожидание этого чата', async (_case, request) => {
    const h = setup();

    await h.service.handOff(CHAT_ID, request);

    expect(h.stopped).toEqual([CHAT_ID]);
    expect(h.events.at(-1)).toBe(STOP_AWAITING);
  });

  it('фраза не ушла и после повтора: ожидание всё равно снимается', async () => {
    const h = setup({ phrase: new Error('Connection Closed') });

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

    expect(h.stopped).toEqual([CHAT_ID]);
  });

  it('передача уже открыта: ожидание всё равно снимается, чат у менеджера', async () => {
    const h = setup({
      alreadyOpen: true,
      chat: makeChat({ control: { status: 'manager', by: 'bot' } }),
    });

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

    expect(h.stopped).toEqual([CHAT_ID]);
  });

  it('запись передачи не удалась: ожидание не снимается, чат остаётся у бота', async () => {
    const h = setup({ openError: new Error('база недоступна') });

    await expect(
      h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 }),
    ).rejects.toThrow();
    expect(h.stopped).toEqual([]);
  });

  it('снять ожидание не удалось: передача уже записана, отказа нет, в лог ID чата и имя ошибки', async () => {
    const h = setup({ stopAwaitingError: new TypeError('Альфа: база недоступна') });

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

    expect(h.events).toEqual(FULL_FLOW);
    expect(h.notices).toHaveLength(1);
    const warnings = h.logs.filter((entry) => entry.level === 'warn');
    expect(warnings).toEqual([
      expect.objectContaining({ context: { chatId: CHAT_ID, errorName: 'TypeError' } }),
    ]);
    expect(loggedText(h.logs)).not.toContain('Альфа');
  });

  it('возврат боту: ожидание снимается до транзакции; сбой => отказ, передача и статус не меняются', async () => {
    const failure = new Error('база недоступна');
    const h = setup({
      alreadyOpen: true,
      chat: makeChat({ control: { status: 'manager', by: 'bot' } }),
      stopAwaitingError: failure,
    });

    await expect(h.service.returnToBot(CHAT_ID)).rejects.toBe(failure);
    expect(h.events).toEqual([STOP_AWAITING]);
    expect(h.resolved).toEqual([]);
    expect(h.statusChanges).toEqual([]);
  });
});

describe('createHandoffService: заметка для бота (решение владельца 29.10.2026)', () => {
  const managerChat = (): Chat => makeChat({ control: { status: 'manager', by: 'bot' } });

  it('возврат с заметкой: заметка после чистки и время возврата в той же транзакции; в лог без текста', async () => {
    const h = setup({ alreadyOpen: true, chat: managerChat() });

    await h.service.returnToBot(CHAT_ID, '  Узнай число вещей\r\nи какая 1С\u200B  ');

    expect(h.notes).toEqual([
      { id: CHAT_ID, note: { text: 'Узнай число вещей\nи какая 1С', atMs: T0 } },
    ]);
    expect(h.events.indexOf('chats.setNote')).toBeLessThan(h.events.indexOf('tx:commit'));
    expect(h.logs).toContainEqual(
      expect.objectContaining({ context: { chatId: CHAT_ID, note: true } }),
    );
    expect(loggedText(h.logs)).not.toContain('Узнай');
  });

  it.each([undefined, null, '', '  \n\u200B '])(
    'возврат без заметки (%j): заметка снята',
    async (note) => {
      const h = setup({ alreadyOpen: true, chat: managerChat() });

      await h.service.returnToBot(CHAT_ID, note);

      expect(h.notes).toEqual([{ id: CHAT_ID, note: null }]);
    },
  );

  it('заметка длиннее 1000 символов: отказ до любых записей, чат у менеджера', async () => {
    const h = setup({ alreadyOpen: true, chat: managerChat() });

    await expect(h.service.returnToBot(CHAT_ID, 'я'.repeat(1001))).rejects.toThrow(RangeError);
    expect(h.events).toEqual([]);
    expect(h.notes).toEqual([]);
  });

  it('следующая передача снимает заметку в своей транзакции', async () => {
    const h = setup();

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

    expect(h.notes).toEqual([{ id: CHAT_ID, note: null }]);
  });

  it('передача уже открыта (повтор): заметку не трогает, её сняла прошлая передача', async () => {
    const h = setup({ alreadyOpen: true, chat: managerChat() });

    await h.service.handOff(CHAT_ID, { reason: 'hot', replyToWaId: IN_1 });

    expect(h.notes).toEqual([]);
  });
});
