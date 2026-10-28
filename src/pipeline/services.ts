import type { AppConfig } from '../config/env.js';
import type { CompanyService } from '../domain/company.js';
import type {
  BacklogRepo,
  ChatsRepo,
  Clock,
  HandoffsRepo,
  Logger,
  ManagerNotificationsRepo,
  MessageSender,
  MessagesRepo,
  OutboundIdsRepo,
  UnitOfWork,
} from '../domain/ports.js';
import { createHandoffService, type HandoffService } from '../handoff/handoff.js';
import { createManagerNotifier, type ManagerNotifier } from '../handoff/notifier.js';
import { createOutbox, type Outbox } from '../messaging/outbox.js';
import { phoneToJid } from '../whatsapp/jid.js';
import { createBacklogCollector } from './backlog.js';

/** Повтор неотправленных уведомлений менеджеру раз в 5 минут (решение владельца); ещё один идёт после каждого открытия подключения. */
export const NOTIFY_RETRY_INTERVAL_MS = 5 * 60_000;

const HOUR_MS = 60 * 60_000;

/** Подключения ещё нет: сообщение не уходит, а уведомление менеджеру остаётся на повтор (статус failed). */
const NOT_CONNECTED_TEXT = 'WhatsApp не подключён: сообщение не отправлено';

/** Настройки, нужные общим службам. */
export type ServicesConfig = Pick<AppConfig, 'managerPhone' | 'testMode' | 'backlogMaxAgeHours'>;

/** База общих служб: чаты, переписка, ID исходящих, отметки простоя, передачи и уведомления менеджеру. */
export interface ServicesStorage {
  readonly chats: ChatsRepo;
  readonly messages: MessagesRepo;
  readonly outboundIds: OutboundIdsRepo;
  readonly backlog: BacklogRepo;
  readonly handoffs: HandoffsRepo;
  readonly notifications: ManagerNotificationsRepo;
  readonly unitOfWork: UnitOfWork;
}

/** Из чего собираются общие службы. */
export interface ServicesContext {
  readonly config: ServicesConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly storage: ServicesStorage;
  /**
   * Сервис компании (pipeline/company-setup.ts): компания клиента в уведомлении менеджеру о передаче и снятие ожидания
   * ответа на «Вы из компании X?» при передаче и возврате боту.
   */
  readonly company: Pick<CompanyService, 'summary' | 'stopAwaiting'>;
}

/**
 * Службы этапа 5, одни на всё приложение: конвейер ответов, перехват человеком, сборщик простоя и панель (этап 6)
 * пользуются одним outbox, одной отправкой уведомлений и одним сервисом передачи.
 */
export interface Services {
  readonly outbox: Outbox;
  readonly handoff: HandoffService;
  /** Подключение WhatsApp создано: все исходящие (outbox) идут через него. До этого отправка отклоняется. */
  connect(connection: MessageSender): void;
  /**
   * Подключение открыто и офлайн-очередь разобрана (после каждого открытия, иногда дважды): повтор неотправленных
   * уведомлений менеджеру, затем одно уведомление со списком чатов простоя. С первого раза запускается таймер повтора
   * раз в NOTIFY_RETRY_INTERVAL_MS. Отказ значит, что список простоя не записался в базу: он уйдёт при следующем разе.
   */
  onOfflineQueueDone(): Promise<void>;
  /** Остановка до закрытия базы: таймер снят, идущий проход повтора дождались. Повторный вызов ничего не делает. */
  stop(): Promise<void>;
}

/** Outbox, который появляется вместе с подключением WhatsApp: до него любая отправка отклоняется. */
interface LateOutbox {
  readonly outbox: Outbox;
  readonly attach: (real: Outbox) => void;
}

/** Таймер повтора уведомлений. */
interface RetryTimer {
  /** Запускает периодический повтор; повторный вызов ничего не делает. */
  readonly start: () => void;
  /** Один проход повтора сейчас. Не отклоняется. */
  readonly run: () => Promise<void>;
  /** Снимает таймер и ждёт проходы, которые уже идут. */
  readonly stop: () => Promise<void>;
}

/**
 * Собирает службы этапа 5. Сервис передачи, перехват человеком и сборщик простоя нужны с первого события, а подключение
 * WhatsApp появляется позже (connect), поэтому они получают outbox-обёртку (LateOutbox), которая до подключения
 * отклоняет отправку, а после него передаёт вызовы настоящему outbox. Notifier (запись уведомления в базу до отправки,
 * повтор при сбое) один на всё приложение: его берут сервис передачи и сборщик простоя. Таймер повтора стартует
 * с первого открытия подключения, а не при запуске: пока WhatsApp не открыт (привязка по QR, WA_ENABLED=false),
 * попытки отправки только тратили бы лимит попыток уведомлений.
 */
export function assembleServices(context: ServicesContext): Services {
  const { config, logger, clock, storage } = context;
  const late = createLateOutbox();
  const { outbox } = late;
  const notifier = createManagerNotifier({
    notifications: storage.notifications,
    outbox,
    clock,
    logger,
  });
  const handoff = createHandoffService({
    chats: storage.chats,
    handoffs: storage.handoffs,
    unitOfWork: storage.unitOfWork,
    outbox,
    notifier,
    company: context.company,
    clock,
    logger,
  });
  const backlog = createBacklogCollector({
    chats: storage.chats,
    messages: storage.messages,
    backlog: storage.backlog,
    unitOfWork: storage.unitOfWork,
    notifier,
    clock,
    logger,
    backlogMaxAgeMs: config.backlogMaxAgeHours * HOUR_MS,
  });
  const retry = createRetryTimer(notifier, logger);
  let stopped = false;
  return {
    outbox,
    handoff,
    connect: (connection) => {
      late.attach(
        createOutbox({
          sender: connection,
          chats: storage.chats,
          messages: storage.messages,
          outboundIds: storage.outboundIds,
          clock,
          managerJid: config.managerPhone === null ? null : phoneToJid(config.managerPhone),
          testAllowlist: config.testMode.enabled ? config.testMode.allowlist : null,
          random: Math.random,
        }),
      );
    },
    onOfflineQueueDone: async () => {
      if (stopped) return;
      retry.start();
      await retry.run();
      await backlog.flush();
    },
    stop: async () => {
      stopped = true;
      await retry.stop();
    },
  };
}

function createLateOutbox(): LateOutbox {
  let target: Outbox | null = null;
  // Исполнитель промиса превращает исключение отсутствующего подключения в отказ, а не в бросок.
  const later = <T>(call: (real: Outbox) => Promise<T>): Promise<T> =>
    new Promise<T>((resolve) => {
      if (target === null) throw new Error(NOT_CONNECTED_TEXT);
      resolve(call(target));
    });
  const outbox: Outbox = {
    sendBotReply: (chatId, text, replyToWaId) =>
      later((real) => real.sendBotReply(chatId, text, replyToWaId)),
    sendHandoffNotice: (chatId, notice, replyToWaId) =>
      later((real) => real.sendHandoffNotice(chatId, notice, replyToWaId)),
    sendHandoffText: (chatId, text, replyToWaId) =>
      later((real) => real.sendHandoffText(chatId, text, replyToWaId)),
    sendVoiceNotice: (chatId, replyToWaId) =>
      later((real) => real.sendVoiceNotice(chatId, replyToWaId)),
    notifyManager: (text, kind) => later((real) => real.notifyManager(text, kind)),
    // Проверка синхронная, поэтому без later: до подключения ответ всё равно не уйдёт, и панель не должна
    // передавать чат менеджеру зря.
    canSendFromPanel: (chatId) => target !== null && target.canSendFromPanel(chatId),
    sendFromPanel: (chatId, text) => later((real) => real.sendFromPanel(chatId, text)),
  };
  return {
    outbox,
    attach: (real) => {
      target = real;
    },
  };
}

function createRetryTimer(
  notifier: Pick<ManagerNotifier, 'retryFailed'>,
  logger: Logger,
): RetryTimer {
  const passes = new Set<Promise<number>>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  const run = async (): Promise<void> => {
    if (stopped) return;
    // retryFailed не бросает; перехват здесь страхует остановку от неожиданного отказа.
    const pass = notifier.retryFailed().catch((error: unknown) => {
      logger.error({ err: error }, 'Повтор уведомлений менеджеру упал неожиданно');
      return 0;
    });
    passes.add(pass);
    try {
      await pass;
    } finally {
      passes.delete(pass);
    }
  };
  return {
    start: () => {
      if (timer !== null || stopped) return;
      timer = setInterval(() => {
        run().catch(() => undefined);
      }, NOTIFY_RETRY_INTERVAL_MS);
      // Таймер процесс не держит: остановку ведёт main.
      timer.unref();
    },
    run,
    stop: async () => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      await Promise.all([...passes]);
    },
  };
}
