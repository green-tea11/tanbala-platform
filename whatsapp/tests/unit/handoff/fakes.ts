import type { CompanyId, CompanySummary } from '../../../src/domain/company.js';
import type {
  Clock,
  Logger,
  ManagerNotificationsRepo,
  UnitOfWork,
} from '../../../src/domain/ports.js';
import type {
  Chat,
  ChatId,
  ClientProfile,
  Jid,
  ManagerNotification,
  PhoneDigits,
  WaMessageId,
} from '../../../src/domain/types.js';
import type {
  ManagerNotifyKind,
  ManagerNotifyResult,
  Outbox,
} from '../../../src/messaging/outbox.js';

// Фейки портов для тестов передачи менеджеру: без базы, сети и реального времени.

/** 26.10.2026 07:30 UTC, 12:30 по Алматы. */
export const T0 = Date.UTC(2026, 9, 26, 7, 30, 0);

export const MINUTE_MS = 60_000;

export interface LogEntry {
  readonly level: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly message: string | undefined;
}

/** Логгер, который запоминает сырые аргументы: видно, что ушло в лог до любой маскировки. */
export function createFakeLogger(entries: LogEntry[]): Logger {
  const log =
    (level: string) =>
    (context: Readonly<Record<string, unknown>>, message?: string): void => {
      entries.push({ level, context, message });
    };
  const logger: Logger = {
    level: 'debug',
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

/** Всё записанное в лог одной строкой, кроме объектов ошибок: так проверяют, что в лог не попали данные клиента. */
export function loggedText(entries: readonly LogEntry[]): string {
  return JSON.stringify(
    entries.map(({ level, context, message }) => ({
      level,
      message,
      context: Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'err')),
    })),
  );
}

export interface ManualClock extends Clock {
  advance(ms: number): void;
}

/** Часы, которые идут только по команде. */
export function createManualClock(startMs: number = T0): ManualClock {
  let now = startMs;
  return {
    now: () => now,
    sleep: () => Promise.resolve(),
    advance: (ms) => {
      now += ms;
    },
  };
}

type RetryQuery = Parameters<ManagerNotificationsRepo['listRetryable']>[0];
type FailingMethod = 'add' | 'setResult' | 'listRetryable';

export interface FakeNotifications {
  readonly repo: ManagerNotificationsRepo;
  /** Все строки так, как их увидит панель. */
  rows(): readonly ManagerNotification[];
  /** ID сообщения WhatsApp, записанный вместе с итогом sent. */
  waIdOf(id: number): WaMessageId | null;
  /** Запросы повтора в том виде, в каком их получил репозиторий. */
  readonly retryQueries: RetryQuery[];
  /** Следующий вызов метода падает этой ошибкой (один раз). */
  failNext(method: FailingMethod, error: Error): void;
  /** Строка как есть: например, зависшая запись прошлого запуска. */
  seed(row: Omit<ManagerNotification, 'id'>): number;
}

function isRetryable(row: ManagerNotification, query: RetryQuery): boolean {
  const waiting =
    row.status === 'failed' || (row.status === 'pending' && row.updatedAtMs <= query.staleBeforeMs);
  return waiting && row.attempts < query.maxAttempts;
}

/** Репозиторий уведомлений в памяти по документации порта ManagerNotificationsRepo. */
export function createFakeNotifications(events: string[] = []): FakeNotifications {
  let rows: readonly ManagerNotification[] = [];
  let nextId = 1;
  const waIds = new Map<number, WaMessageId>();
  const failures = new Map<FailingMethod, Error>();
  const retryQueries: RetryQuery[] = [];
  const failIfScheduled = (method: FailingMethod): void => {
    const error = failures.get(method);
    if (error === undefined) return;
    failures.delete(method);
    throw error;
  };
  const replace = (id: number, change: (row: ManagerNotification) => ManagerNotification): void => {
    if (!rows.some((row) => row.id === id)) throw new Error(`Нет уведомления #${id}`);
    rows = rows.map((row) => (row.id === id ? change(row) : row));
  };
  const repo: ManagerNotificationsRepo = {
    add: (entry) => {
      failIfScheduled('add');
      events.push('notifications.add');
      const id = nextId;
      nextId += 1;
      rows = [
        ...rows,
        {
          id,
          kind: entry.kind,
          chatId: entry.chatId,
          text: entry.text,
          status: 'pending',
          attempts: 0,
          createdAtMs: entry.nowMs,
          updatedAtMs: entry.nowMs,
        },
      ];
      return id;
    },
    setResult: (id, result, nowMs) => {
      failIfScheduled('setResult');
      events.push(`notifications.setResult:${result.status}`);
      if (result.waId !== null) waIds.set(id, result.waId);
      replace(id, (row) => ({
        ...row,
        status: result.status,
        attempts: row.attempts + 1,
        updatedAtMs: nowMs,
      }));
    },
    listRetryable: (query) => {
      failIfScheduled('listRetryable');
      retryQueries.push(query);
      return rows
        .filter((row) => isRetryable(row, query))
        .toSorted((a, b) => a.createdAtMs - b.createdAtMs || a.id - b.id)
        .slice(0, query.limit);
    },
    listRecent: (query) =>
      rows.toSorted((a, b) => b.id - a.id).slice(query.offset, query.offset + query.limit),
    countAll: () => rows.length,
    latestForChat: (chatId) =>
      rows.filter((row) => row.chatId === chatId).toSorted((a, b) => b.id - a.id)[0] ?? null,
  };
  return {
    repo,
    rows: () => rows,
    waIdOf: (id) => waIds.get(id) ?? null,
    retryQueries,
    failNext: (method, error) => {
      failures.set(method, error);
    },
    seed: (row) => {
      const id = nextId;
      nextId += 1;
      rows = [...rows, { ...row, id }];
      return id;
    },
  };
}

/** Что делает поддельная отправка уведомления: ответ, сбой или отложенный ответ. */
export type OutboxStep = ManagerNotifyResult | Error | Promise<ManagerNotifyResult>;

export interface SentNotification {
  readonly text: string;
  readonly kind: ManagerNotifyKind;
}

export interface FakeOutbox {
  readonly outbox: Pick<Outbox, 'notifyManager'>;
  readonly sent: SentNotification[];
}

/** Отправка уведомлений по сценарию; когда сценарий кончился, каждая отправка удаётся. */
export function createFakeOutbox(
  events: string[] = [],
  script: readonly OutboxStep[] = [],
): FakeOutbox {
  const sent: SentNotification[] = [];
  let calls = 0;
  const outbox: Pick<Outbox, 'notifyManager'> = {
    notifyManager: (text, kind) => {
      events.push('outbox.notifyManager');
      sent.push({ text, kind });
      const step = script[calls] ?? { status: 'sent', waId: `OUT-${calls + 1}` as WaMessageId };
      calls += 1;
      if (step instanceof Error) return Promise.reject(step);
      return Promise.resolve(step);
    },
  };
  return { outbox, sent };
}

export function chatIdOf(value: number): ChatId {
  return value as ChatId;
}

/** Вымышленный номер клиента и его адрес. */
export const CLIENT_PHONE = '77000000001' as PhoneDigits;
export const CLIENT_JID = '77000000001@s.whatsapp.net' as Jid;

export const FULL_PROFILE: ClientProfile = {
  business: 'магазин одежды',
  area: '300 кв. м',
  scope: 'где лежит каждая вещь',
  itemCount: 'около 5000',
  has1C: true,
  oneCName: null,
  problem: 'путаница с остатками',
  specifics: 'два склада',
  problemAgreed: false,
  items: null,
  packaging: null,
  material: null,
  city: null,
  premises: null,
  turnover: null,
  currentTracking: null,
};

/** Чат клиента: по умолчанию бот ведёт, интерес тёплый, выжимка заполнена. */
export function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: chatIdOf(12),
    identity: { replyJid: CLIENT_JID, lidJid: null, pnJid: CLIENT_JID },
    pushName: 'Иван Петров',
    control: { status: 'bot', by: null },
    level: 'warm',
    profile: FULL_PROFILE,
    ...overrides,
  };
}

/** Сводка выключенной функции определения компании: так сервис передачи работает по умолчанию в тестах. */
export const OFF_SUMMARY: CompanySummary = {
  status: 'off',
  companyId: null,
  name: null,
  city: null,
  rubric: null,
  candidateSource: null,
  cardUrl: null,
  confirmedPains: [],
  briefPains: [],
  emailed: null,
  research: null,
  statedName: null,
};

/** Подтверждённая компания со справкой, ссылкой на карточку и болями клиента (вымышленная). */
export const CONFIRMED_SUMMARY: CompanySummary = {
  ...OFF_SUMMARY,
  status: 'confirmed',
  companyId: 42 as CompanyId,
  name: 'Мебель Плюс',
  city: 'Алматы',
  rubric: 'Мебель',
  cardUrl: 'https://mail.example.kz/companies/42',
  confirmedPains: ['теряются вещи', 'долгая инвентаризация'],
  briefPains: [{ pain: 'пересорт на складе', evidence: 'склад на 2000 м²', source: 'site' }],
  emailed: true,
};

/** Транзакция-пустышка: порядок и откат видны в журнале событий. */
export function createFakeUnitOfWork(events: string[]): UnitOfWork {
  return {
    run: (work) => {
      events.push('tx:begin');
      try {
        const result = work();
        events.push('tx:commit');
        return result;
      } catch (error: unknown) {
        events.push('tx:rollback');
        throw error;
      }
    },
  };
}
