import type Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { createUnitOfWork } from '../../../src/db/connection.js';
import { createBacklogRepo } from '../../../src/db/repos/backlog.js';
import { createChatsRepo } from '../../../src/db/repos/chats.js';
import { createHandoffsRepo } from '../../../src/db/repos/handoffs.js';
import { createManagerNotificationsRepo } from '../../../src/db/repos/manager-notifications.js';
import { createMessagesRepo } from '../../../src/db/repos/messages.js';
import { createOutboundIdsRepo } from '../../../src/db/repos/outbound-ids.js';
import type { CompanyId, CompanyService, CompanySummary } from '../../../src/domain/company.js';
import type { Clock, Logger, MessageSender } from '../../../src/domain/ports.js';
import type {
  Chat,
  ChatId,
  Jid,
  PhoneDigits,
  ReviewedText,
  WaMessageId,
} from '../../../src/domain/types.js';
import {
  assembleServices,
  NOTIFY_RETRY_INTERVAL_MS,
  type Services,
  type ServicesConfig,
  type ServicesStorage,
} from '../../../src/pipeline/services.js';
import { useMigratedDb } from '../db/fixture.js';

// Настоящие репозитории на SQLite в памяти, подключение WhatsApp поддельное: сети нет.

const CLIENT_PHONE = '77000000002' as PhoneDigits;
const CLIENT_JID = `${CLIENT_PHONE}@s.whatsapp.net` as Jid;
const MANAGER_PHONE = '77000000009' as PhoneDigits;
const MANAGER_JID = `${MANAGER_PHONE}@s.whatsapp.net` as Jid;
const T0 = Date.UTC(2026, 9, 26, 6, 0, 0);
const CONFIG: ServicesConfig = {
  managerPhone: MANAGER_PHONE,
  testMode: { enabled: true, allowlist: new Set([CLIENT_PHONE]) },
  backlogMaxAgeHours: 12,
};
/** Решение владельца: повтор раз в 5 минут. Число записано здесь прямо, чтобы смена константы не прошла незамеченной. */
const FIVE_MINUTES_MS = 5 * 60_000;
/** Паузы мгновенные, время настоящее. */
const CLOCK: Clock = { now: () => Date.now(), sleep: () => Promise.resolve() };

type SendText = MessageSender['sendText'];

/** Сводка о компании, которую сервис компании отдал бы по подтверждённой компании клиента. */
const CONFIRMED_SUMMARY: CompanySummary = {
  status: 'confirmed',
  companyId: 42 as CompanyId,
  name: 'ТОО Склад',
  city: 'Алматы',
  rubric: 'Склады',
  candidateSource: null,
  cardUrl: 'https://mail.example.kz/companies/42',
  confirmedPains: ['Пересорт при отгрузке'],
  briefPains: [],
  emailed: false,
  research: null,
  statedName: null,
};

interface Harness {
  readonly db: Database.Database;
  readonly storage: ServicesStorage;
  readonly services: Services;
  readonly sendText: Mock<SendText>;
  readonly connection: MessageSender;
  readonly logs: { readonly level: string; readonly context: unknown }[];
  readonly chat: Chat;
  readonly summary: Mock<CompanyService['summary']>;
  readonly stopAwaiting: Mock<CompanyService['stopAwaiting']>;
}

function createLogger(logs: Harness['logs']): Logger {
  const log =
    (level: string) =>
    (context: Readonly<Record<string, unknown>>): void => {
      logs.push({ level, context });
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

function setup(config: ServicesConfig = CONFIG): Harness {
  const db = useMigratedDb();
  const storage: ServicesStorage = {
    chats: createChatsRepo(db),
    messages: createMessagesRepo(db),
    outboundIds: createOutboundIdsRepo(db),
    backlog: createBacklogRepo(db),
    handoffs: createHandoffsRepo(db),
    notifications: createManagerNotificationsRepo(db),
    unitOfWork: createUnitOfWork(db),
  };
  const logs: Harness['logs'] = [];
  const summary = vi.fn<CompanyService['summary']>(() => CONFIRMED_SUMMARY);
  const stopAwaiting = vi.fn<CompanyService['stopAwaiting']>();
  const services = assembleServices({
    config,
    logger: createLogger(logs),
    clock: CLOCK,
    storage,
    company: { summary, stopAwaiting },
  });
  onTestFinished(async () => {
    await services.stop();
  });
  let sent = 0;
  const sendText = vi.fn<SendText>(() => Promise.resolve());
  const connection: MessageSender = {
    newMessageId: () => `OUT-${(sent += 1)}` as WaMessageId,
    sendText,
    setTyping: () => Promise.resolve(),
  };
  const chat = storage.chats.upsertByIdentity(
    { replyJid: CLIENT_JID, lidJid: null, pnJid: CLIENT_JID },
    'Клиент',
    T0,
  );
  return { db, storage, services, sendText, connection, logs, chat, summary, stopAwaiting };
}

/** Передача, после которой менеджеру уходит уведомление (лимит: фразы клиенту нет). */
function limitHandoff(h: Harness): Promise<void> {
  return h.services.handoff.handOff(h.chat.id, { reason: 'limit', scope: 'chat' });
}

function notificationOf(h: Harness): { status: string; attempts: number; waId: string | null } {
  const row = h.db
    .prepare<[], { status: string; attempts: number; waId: string | null }>(
      'SELECT status, attempts, wa_id AS waId FROM manager_notifications ORDER BY id DESC LIMIT 1',
    )
    .get();
  if (row === undefined) throw new Error('Уведомления нет');
  return row;
}

function useFakeIntervals(): void {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

/** Старое сообщение клиента, на которое бот не отвечал: чат отмечен для менеджера. */
function staleChat(h: Harness): void {
  h.storage.messages.insertIfNew({
    chatId: h.chat.id,
    waId: 'OLD-1' as WaMessageId,
    author: 'client',
    kind: 'text',
    text: 'Сообщение за время простоя',
    tsMs: T0,
  });
  h.storage.backlog.markStale(h.chat.id, T0);
}

/** Даёт завершиться цепочкам промисов, которые запустил таймер. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('pipeline/services: подключение появляется позже', () => {
  it('до подключения отправка падает исключением: передача не отклоняется, уведомление ждёт повтора', async () => {
    const h = setup();

    await limitHandoff(h);

    expect(notificationOf(h)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it('до подключения любая отправка через outbox отклоняется, после connect идёт через подключение', async () => {
    const h = setup();
    const inbound = (waId: string): WaMessageId => {
      h.storage.messages.insertIfNew({
        chatId: h.chat.id,
        waId: waId as WaMessageId,
        author: 'client',
        kind: 'text',
        text: 'Здравствуйте',
        tsMs: T0,
      });
      return waId as WaMessageId;
    };
    const { outbox } = h.services;
    const sends = [
      () => outbox.sendBotReply(h.chat.id, 'Ответ' as ReviewedText, inbound('IN-1')),
      () => outbox.sendHandoffNotice(h.chat.id, { reason: 'asked_human' }, inbound('IN-2')),
      () => outbox.sendVoiceNotice(h.chat.id, inbound('IN-3')),
      () => outbox.notifyManager('Текст уведомления', 'handoff'),
      () => outbox.sendFromPanel(h.chat.id, 'Ответ из панели'),
      () =>
        outbox.sendHandoffText(h.chat.id, 'Сообщение о передаче' as ReviewedText, inbound('IN-4')),
    ];

    for (const send of sends) await expect(send()).rejects.toThrow('WhatsApp не подключён');
    expect(h.sendText).not.toHaveBeenCalled();

    h.services.connect(h.connection);
    await expect(sends[0]?.()).resolves.toBe('sent');
    await expect(sends[1]?.()).resolves.toBe('sent');
    await expect(sends[2]?.()).resolves.toBe('sent');
    await expect(sends[3]?.()).resolves.toMatchObject({ status: 'sent' });
    await expect(sends[5]?.()).resolves.toBe('sent');
    expect(h.sendText.mock.calls.map(([jid]) => jid)).toEqual([
      CLIENT_JID,
      CLIENT_JID,
      CLIENT_JID,
      MANAGER_JID,
      CLIENT_JID,
    ]);
  });

  it('canSendFromPanel: до подключения нельзя (ответ не уйдёт), после connect решает настоящий outbox', () => {
    const h = setup();
    const strangerJid = '77000000003@s.whatsapp.net' as Jid;
    const stranger = h.storage.chats.upsertByIdentity(
      { replyJid: strangerJid, lidJid: null, pnJid: strangerJid },
      'Чужой',
      T0,
    );
    const { outbox } = h.services;

    expect(outbox.canSendFromPanel(h.chat.id)).toBe(false);

    h.services.connect(h.connection);
    expect(outbox.canSendFromPanel(h.chat.id)).toBe(true);
    expect(outbox.canSendFromPanel(stranger.id)).toBe(false);
    expect(outbox.canSendFromPanel(404 as ChatId)).toBe(false);
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it('рабочий режим (TEST_MODE=false, этап 8): outbox пишет и в чат не из TEST_ALLOWLIST, ответ уходит', async () => {
    const h = setup({ ...CONFIG, testMode: { ...CONFIG.testMode, enabled: false } });
    const strangerJid = '77000000003@s.whatsapp.net' as Jid;
    const stranger = h.storage.chats.upsertByIdentity(
      { replyJid: strangerJid, lidJid: null, pnJid: strangerJid },
      'Новый клиент',
      T0,
    );
    h.storage.messages.insertIfNew({
      chatId: stranger.id,
      waId: 'WA-1' as WaMessageId,
      author: 'client',
      kind: 'text',
      text: 'Здравствуйте',
      tsMs: T0,
    });
    h.services.connect(h.connection);

    expect(h.services.outbox.canSendFromPanel(stranger.id)).toBe(true);
    await expect(
      h.services.outbox.sendHandoffNotice(
        stranger.id,
        { reason: 'asked_human' },
        'WA-1' as WaMessageId,
      ),
    ).resolves.toBe('sent');
    expect(h.sendText).toHaveBeenCalledWith(strangerJid, expect.any(String), 'OUT-1');
  });

  it('после connect и открытия подключения неотправленное уходит менеджеру', async () => {
    const h = setup();
    await limitHandoff(h);

    h.services.connect(h.connection);
    await h.services.onOfflineQueueDone();

    expect(notificationOf(h)).toMatchObject({ status: 'sent', attempts: 2, waId: 'OUT-1' });
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.sendText).toHaveBeenCalledWith(MANAGER_JID, expect.any(String), 'OUT-1');
  });

  it('одни службы на всех: уведомление менеджеру и фраза клиенту идут через общий outbox и подключение, уведомление первым', async () => {
    const h = setup();
    h.services.connect(h.connection);
    const message = {
      chatId: h.chat.id,
      waId: 'IN-1' as WaMessageId,
      author: 'client',
      kind: 'text',
      text: 'Здравствуйте',
      tsMs: T0,
    } as const;
    h.storage.messages.insertIfNew(message);

    await h.services.handoff.handOff(h.chat.id, { reason: 'hot', replyToWaId: message.waId });

    expect(h.sendText.mock.calls.map(([jid]) => jid)).toEqual([MANAGER_JID, CLIENT_JID]);
    expect(h.storage.handoffs.findOpen(h.chat.id)).toMatchObject({ reason: 'hot' });
  });

  it('сервис передачи берёт компанию клиента из общего сервиса компании: она в уведомлении менеджеру', async () => {
    const h = setup();
    h.services.connect(h.connection);
    const waId = 'IN-1' as WaMessageId;
    h.storage.messages.insertIfNew({
      chatId: h.chat.id,
      waId,
      author: 'client',
      kind: 'text',
      text: 'Позовите человека',
      tsMs: T0,
    });

    await h.services.handoff.handOff(h.chat.id, { reason: 'asked_human', replyToWaId: waId });

    expect(h.summary).toHaveBeenCalledWith(h.chat.id);
    const [jid, text] = h.sendText.mock.calls[0] ?? [];
    expect(jid).toBe(MANAGER_JID);
    expect(text).toContain('ТОО Склад');
    expect(h.stopAwaiting).toHaveBeenCalledWith(h.chat.id);
  });

  it('передача и возврат боту снимают ожидание ответа на «Вы из компании X?» через тот же сервис компании', async () => {
    const h = setup();

    await limitHandoff(h);
    await h.services.handoff.returnToBot(h.chat.id);

    expect(h.stopAwaiting.mock.calls).toEqual([[h.chat.id], [h.chat.id]]);
    expect(h.storage.chats.getById(h.chat.id)?.control).toEqual({ status: 'bot', by: 'panel' });
  });
});

describe('pipeline/services: повтор неотправленных уведомлений', () => {
  it('таймер не стартует при подключении: только с первого открытия, раз в 5 минут', async () => {
    useFakeIntervals();
    const h = setup();
    h.services.connect(h.connection);

    expect(vi.getTimerCount()).toBe(0);
    await h.services.onOfflineQueueDone();
    expect(vi.getTimerCount()).toBe(1);
    await h.services.onOfflineQueueDone();
    expect(vi.getTimerCount()).toBe(1);

    // Уведомление упало уже при открытом подключении: его повторит таймер.
    h.sendText.mockRejectedValueOnce(new Error('Connection Closed'));
    await limitHandoff(h);
    expect(notificationOf(h).status).toBe('failed');
    expect(NOTIFY_RETRY_INTERVAL_MS).toBe(FIVE_MINUTES_MS);
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS - 1);
    await settle();
    expect(notificationOf(h).status).toBe('failed');
    await vi.advanceTimersByTimeAsync(1);
    await settle();

    expect(notificationOf(h)).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('после пяти попыток запись больше не повторяется', async () => {
    useFakeIntervals();
    const h = setup();
    h.sendText.mockRejectedValue(new Error('Connection Closed'));
    h.services.connect(h.connection);
    await h.services.onOfflineQueueDone();
    await limitHandoff(h);

    for (let pass = 0; pass < 8; pass += 1) {
      await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
      await settle();
    }

    expect(notificationOf(h)).toMatchObject({ status: 'failed', attempts: 5 });
    expect(h.sendText).toHaveBeenCalledTimes(5);
  });

  it('остановка снимает таймер и ждёт проход, который уже идёт; повторная остановка безопасна', async () => {
    useFakeIntervals();
    const h = setup();
    h.sendText.mockRejectedValueOnce(new Error('Connection Closed'));
    h.services.connect(h.connection);
    await limitHandoff(h);
    let finishSend: () => void = () => undefined;
    h.sendText.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSend = resolve;
        }),
    );
    const opening = h.services.onOfflineQueueDone();
    await settle();
    expect(vi.getTimerCount()).toBe(1);

    let stopped = false;
    const stopping = h.services.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    finishSend();
    await stopping;
    await opening;

    expect(notificationOf(h)).toMatchObject({ status: 'sent' });
    await expect(h.services.stop()).resolves.toBeUndefined();
  });

  it('после остановки открытие подключения ничего не отправляет и не пишет, таймер не заводится', async () => {
    useFakeIntervals();
    const h = setup();
    staleChat(h);
    h.services.connect(h.connection);
    await h.services.stop();

    await h.services.onOfflineQueueDone();

    expect(vi.getTimerCount()).toBe(0);
    expect(h.sendText).not.toHaveBeenCalled();
    expect(h.storage.backlog.listPending()).toHaveLength(1);
    expect(h.storage.notifications.countAll()).toBe(0);
  });
});

describe('pipeline/services: список простоя после офлайн-очереди', () => {
  it('одно уведомление менеджеру со списком, повторное открытие его не дублирует', async () => {
    const h = setup();
    staleChat(h);
    h.services.connect(h.connection);

    await h.services.onOfflineQueueDone();
    await h.services.onOfflineQueueDone();

    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.sendText).toHaveBeenCalledWith(
      MANAGER_JID,
      expect.stringContaining('Клиент'),
      'OUT-1',
    );
    expect(notificationOf(h)).toMatchObject({ status: 'sent' });
    expect(h.storage.backlog.listPending()).toEqual([]);
  });

  it('сообщений простоя нет: ничего не отправляется', async () => {
    const h = setup();
    h.services.connect(h.connection);

    await h.services.onOfflineQueueDone();

    expect(h.sendText).not.toHaveBeenCalled();
  });

  it('номера менеджера нет: список записан для панели, чаты отмечены, отправки нет', async () => {
    const h = setup({ ...CONFIG, managerPhone: null });
    staleChat(h);
    h.services.connect(h.connection);

    await h.services.onOfflineQueueDone();

    expect(notificationOf(h)).toMatchObject({ status: 'no_manager' });
    expect(h.storage.backlog.listPending()).toEqual([]);
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it('список не записался в базу: открытие отклоняется, чаты остаются в ожидании до следующего раза', async () => {
    const h = setup();
    staleChat(h);
    h.services.connect(h.connection);
    h.db.exec('DROP TABLE manager_notifications');

    await expect(h.services.onOfflineQueueDone()).rejects.toThrow();

    expect(h.storage.backlog.listPending()).toHaveLength(1);
  });
});
