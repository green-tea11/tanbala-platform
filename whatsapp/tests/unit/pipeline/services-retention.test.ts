import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createUnitOfWork } from '../../../src/db/connection.js';
import { createBacklogRepo } from '../../../src/db/repos/backlog.js';
import { createChatsRepo } from '../../../src/db/repos/chats.js';
import { createHandoffsRepo } from '../../../src/db/repos/handoffs.js';
import { createManagerNotificationsRepo } from '../../../src/db/repos/manager-notifications.js';
import { createMessagesRepo } from '../../../src/db/repos/messages.js';
import { createOutboundIdsRepo } from '../../../src/db/repos/outbound-ids.js';
import { createRejectedDraftsRepo } from '../../../src/db/repos/rejected-drafts.js';
import type { Clock, Logger, MessageSender } from '../../../src/domain/ports.js';
import type { ChatId, Jid, WaMessageId } from '../../../src/domain/types.js';
import {
  assembleServices,
  NOTIFY_RETRY_INTERVAL_MS,
  REJECTED_DRAFTS_RETENTION_MS,
} from '../../../src/pipeline/services.js';
import { insertChat, PN_A, useMigratedDb } from '../db/fixture.js';

// Срок хранения отклонённых черновиков 30 дней (пункт 7 задания 29.10.2026): старые строки удаляются при запуске и
// тем же таймером, что повторяет уведомления менеджеру (раз в 5 минут после первого открытия подключения).

const T0 = Date.UTC(2026, 9, 29, 6, 0, 0);
const DAY_MS = 24 * 60 * 60_000;

const SILENT: Logger = {
  level: 'silent',
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  silent: () => undefined,
  child: () => SILENT,
};

function setup(logger: Logger = SILENT) {
  const db = useMigratedDb();
  const chatId = insertChat(db, { replyJid: PN_A });
  const rejectedDrafts = createRejectedDraftsRepo(db);
  let now = T0;
  const clock: Clock = { now: () => now, sleep: () => Promise.resolve() };
  const seed = (atMs: number, draft: string): void => {
    rejectedDrafts.add({ chatId, attempt: 1, source: 'code', draft, remarks: [], atMs });
  };
  const start = () =>
    assembleServices({
      config: {
        managerPhone: null,
        testMode: { enabled: false, allowlist: new Set() },
        backlogMaxAgeHours: 12,
      },
      logger,
      clock,
      storage: {
        chats: createChatsRepo(db),
        messages: createMessagesRepo(db),
        outboundIds: createOutboundIdsRepo(db),
        backlog: createBacklogRepo(db),
        handoffs: createHandoffsRepo(db),
        notifications: createManagerNotificationsRepo(db),
        unitOfWork: createUnitOfWork(db),
        rejectedDrafts,
      },
      company: { summary: () => null as never, stopAwaiting: () => undefined },
    });
  return {
    chatId,
    seed,
    start,
    drafts: (id: ChatId) => rejectedDrafts.listForChat(id, 100).map((item) => item.draft),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const CONNECTION: MessageSender = {
  newMessageId: () => 'OUT-1' as WaMessageId,
  sendText: (_to: Jid) => Promise.resolve(),
  setTyping: () => Promise.resolve(),
};

describe('pipeline/services: срок хранения отклонённых черновиков', () => {
  it('срок 30 дней', () => {
    expect(REJECTED_DRAFTS_RETENTION_MS).toBe(30 * DAY_MS);
  });

  it('при запуске удаляются строки старше 30 дней, остальные остаются', () => {
    const h = setup();
    h.seed(T0 - 31 * DAY_MS, 'старый');
    h.seed(T0 - 30 * DAY_MS, 'ровно 30 дней');
    h.seed(T0 - DAY_MS, 'вчерашний');

    const services = h.start();
    onTestFinished(() => services.stop());

    expect(h.drafts(h.chatId)).toEqual(['вчерашний', 'ровно 30 дней']);
  });

  it('таймер повтора уведомлений раз в 5 минут удаляет то, что устарело за время работы', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const h = setup();
    h.seed(T0 - 29 * DAY_MS, 'почти старый');
    const services = h.start();
    onTestFinished(() => services.stop());
    services.connect(CONNECTION);
    await services.onOfflineQueueDone();
    expect(h.drafts(h.chatId)).toEqual(['почти старый']);

    h.advance(2 * DAY_MS);
    await vi.advanceTimersByTimeAsync(NOTIFY_RETRY_INTERVAL_MS);

    expect(h.drafts(h.chatId)).toEqual([]);
  });

  it('сбой чистки не мешает запуску: предупреждение без текстов', () => {
    const warnings: unknown[] = [];
    const logger: Logger = { ...SILENT, warn: (context) => warnings.push(context), child: () => logger };
    const h = setup(logger);
    const services = assembleServicesWithFailingPrune(h, logger);
    onTestFinished(() => services.stop());

    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).toContain('errorName');
  });
});

function assembleServicesWithFailingPrune(h: ReturnType<typeof setup>, logger: Logger) {
  const db = useMigratedDb();
  void h;
  return assembleServices({
    config: {
      managerPhone: null,
      testMode: { enabled: false, allowlist: new Set() },
      backlogMaxAgeHours: 12,
    },
    logger,
    clock: { now: () => T0, sleep: () => Promise.resolve() },
    storage: {
      chats: createChatsRepo(db),
      messages: createMessagesRepo(db),
      outboundIds: createOutboundIdsRepo(db),
      backlog: createBacklogRepo(db),
      handoffs: createHandoffsRepo(db),
      notifications: createManagerNotificationsRepo(db),
      unitOfWork: createUnitOfWork(db),
      rejectedDrafts: {
        deleteOlderThan: () => {
          throw new Error('база занята');
        },
      },
    },
    company: { summary: () => null as never, stopAwaiting: () => undefined },
  });
}
