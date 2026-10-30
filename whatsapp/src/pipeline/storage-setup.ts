import type { AppConfig } from '../config/env.js';
import { createUnitOfWork, openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { createAppStateRepo } from '../db/repos/app-state.js';
import { createBacklogRepo } from '../db/repos/backlog.js';
import { createCallBudget } from '../db/repos/call-budget.js';
import { createChatCompaniesRepo } from '../db/repos/chat-companies.js';
import { createChatsRepo } from '../db/repos/chats.js';
import { createConsoleReads } from '../db/repos/console-details.js';
import { createHandoffsRepo } from '../db/repos/handoffs.js';
import { createKnownChatsRepo } from '../db/repos/known-chats.js';
import { createManagerNotificationsRepo } from '../db/repos/manager-notifications.js';
import { createMessagesRepo } from '../db/repos/messages.js';
import { createOutboundIdsRepo } from '../db/repos/outbound-ids.js';
import { createPairingGuard } from '../db/repos/pairing-attempts.js';
import { createRejectedDraftsRepo } from '../db/repos/rejected-drafts.js';
import { createWorkingModeRepo } from '../db/repos/working-mode.js';
import type { ChatCompaniesRepo } from '../domain/company.js';
import type { ConsoleReads } from '../domain/console.js';
import type {
  AppStateRepo,
  BacklogRepo,
  CallBudget,
  ChatsRepo,
  Clock,
  HandoffsRepo,
  Logger,
  ManagerNotificationsRepo,
  MessagesRepo,
  OutboundIdsRepo,
  PairingGuard,
  RejectedDraftsRepo,
  UnitOfWork,
} from '../domain/ports.js';
import type { WorkingMode } from '../domain/types.js';
import { createInboundRecorder, type InboundRecorder } from './recorder.js';
import { createHeldForManagerCheck, createUnseenHold, settleWorkingMode } from './working-mode.js';

// База приложения и всё, что на ней собрано (часть composition root из main.ts): репозитории, запись входящих и
// рабочий режим. Порядок сборки прежний, main зовёт openStorage после замка процесса и до WhatsApp.

type Database = ReturnType<typeof openDatabase>;

/** Настройки, которые нужны базе: путь, режим, копия счётчика привязки, предохранитель расходов. */
export type StorageConfig = Pick<
  AppConfig,
  'databasePath' | 'testMode' | 'pairingMirrorPath' | 'limits'
>;

/** База и всё, что на ней собрано. */
export interface AppStorage {
  readonly appState: AppStateRepo;
  readonly pairingGuard: PairingGuard;
  readonly backlog: BacklogRepo;
  readonly recorder: InboundRecorder;
  readonly chats: ChatsRepo;
  readonly messages: MessagesRepo;
  readonly outboundIds: OutboundIdsRepo;
  readonly unitOfWork: UnitOfWork;
  /** Дневной предохранитель расходов API (API_DAILY_LIMIT и API_DAILY_LIMIT_PER_CHAT). */
  readonly budget: CallBudget;
  /** Передачи чатов менеджеру и уведомления ему (этап 5). */
  readonly handoffs: HandoffsRepo;
  readonly notifications: ManagerNotificationsRepo;
  /** Определение компании клиента по чатам. */
  readonly chatCompanies: ChatCompaniesRepo;
  /** Отклонённые черновики и замечания проверок для панели (срок 30 дней). */
  readonly rejectedDrafts: RejectedDraftsRepo;
  /** Выборки только на чтение для API консоли; запросы готовятся при первом обращении (без консоли никогда). */
  readonly consoleReads: ConsoleReads;
  /** Рабочий режим с границей перехода (этап 8); null: закрытый режим. Решается при открытии базы. */
  readonly workingMode: WorkingMode | null;
  isOpen(): boolean;
  /** Закрывает базу; повторный вызов ничего не делает. */
  close(): void;
}

/** База с миграциями; сбой миграции закрывает её до выхода ошибки. */
export function openStorage(config: StorageConfig, logger: Logger, clock: Clock): AppStorage {
  const db = openDatabase(config.databasePath);
  try {
    runMigrations(db);
    return assembleStorage(db, config, logger, clock);
  } catch (error: unknown) {
    db.close();
    throw error;
  }
}

function assembleStorage(
  db: Database,
  config: StorageConfig,
  logger: Logger,
  clock: Clock,
): AppStorage {
  const appState = createAppStateRepo(db);
  const backlog = createBacklogRepo(db);
  const chats = createChatsRepo(db);
  const messages = createMessagesRepo(db);
  const unitOfWork = createUnitOfWork(db);
  const switchRepo = createWorkingModeRepo(db);
  // До записи входящих и до WhatsApp: отказ перехода останавливает запуск, в базе ничего не записано.
  const workingMode = settleWorkingMode(
    { appState, repo: switchRepo, chats, unitOfWork, clock, logger },
    config.testMode,
  );
  const recorder = createInboundRecorder({
    chats,
    messages,
    backlog,
    knownChats: createKnownChatsRepo(db),
    unitOfWork,
    heldForManager: createHeldForManagerCheck(workingMode, switchRepo),
    holdUnseen: createUnseenHold(workingMode, switchRepo),
    logger,
    clock,
  });
  return {
    appState,
    pairingGuard: createPairingGuard(db, config.pairingMirrorPath),
    backlog,
    recorder,
    chats,
    messages,
    outboundIds: createOutboundIdsRepo(db),
    unitOfWork,
    budget: createCallBudget(db, config.limits),
    handoffs: createHandoffsRepo(db),
    notifications: createManagerNotificationsRepo(db),
    chatCompanies: createChatCompaniesRepo(db, logger),
    rejectedDrafts: createRejectedDraftsRepo(db),
    consoleReads: createConsoleReads(db),
    workingMode,
    isOpen: () => db.open,
    // close в better-sqlite3 сам ничего не делает с уже закрытой базой.
    close: () => {
      db.close();
    },
  };
}
