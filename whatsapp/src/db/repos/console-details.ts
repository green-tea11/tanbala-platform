import type Database from 'better-sqlite3';
import type {
  ChatMeta,
  CompanyLinkRow,
  ConsoleReads,
  HandoffHistoryRow,
  NotificationWithChat,
  PageQuery,
  ProfileMeta,
} from '../../domain/console.js';
import type {
  ChatId,
  ChatStatus,
  Jid,
  ManagerNotificationKind,
  ManagerNotificationStatus,
} from '../../domain/types.js';
import { assertTimeMs } from '../time.js';
import { assertCount, HANDOFF_REASONS, LEVELS, oneOf } from '../values.js';
import { createConsoleChatListReads } from './console-chat-list.js';

const STATUSES: readonly ChatStatus[] = ['bot', 'manager'];
const KINDS: readonly ManagerNotificationKind[] = ['handoff', 'limit', 'backlog'];
const NOTIFICATION_STATUSES: readonly ManagerNotificationStatus[] = [
  'pending',
  'sent',
  'no_manager',
  'skipped_limit',
  'failed',
];
/** chat_id общего счётчика бота в api_usage (db/repos/call-budget.ts). */
const GLOBAL_COUNTER = 0;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface HandoffRow {
  readonly id: number;
  readonly reason: string;
  readonly level: string;
  readonly openedAtMs: number;
  readonly resolvedAtMs: number | null;
}

interface NotificationRow {
  readonly id: number;
  readonly kind: string;
  readonly chatId: number | null;
  readonly text: string;
  readonly status: string;
  readonly attempts: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly chatName: string | null;
}

interface LinkRow {
  readonly chatId: number;
  readonly companyId: number;
  readonly confirmedAtMs: number | null;
  readonly pushName: string | null;
  readonly pnJid: string | null;
  readonly status: string;
  readonly level: string;
  readonly firstClientMessageAtMs: number | null;
  readonly lastMessageAtMs: number | null;
}

/** Уведомления с именем клиента; status NULL => все. Новые сверху, как в старой панели. */
const LIST_NOTIFICATIONS = `SELECT n.id, n.kind, n.chat_id AS chatId, n.text, n.status, n.attempts,
  n.created_at_ms AS createdAtMs, n.updated_at_ms AS updatedAtMs, c.push_name AS chatName
FROM manager_notifications AS n LEFT JOIN chats AS c ON c.id = n.chat_id
WHERE (@status IS NULL OR n.status = @status)
ORDER BY n.created_at_ms DESC, n.id DESC
LIMIT @limit OFFSET @offset`;

/**
 * Подтверждённые связи чат → компания из JSON записи бота ($.confirmed.id, целое больше нуля). CASE, а не AND:
 * json_type на тексте не JSON бросает ошибку. companyId NULL => все связи.
 */
const COMPANY_LINKS = `WITH links AS (
  SELECT cc.chat_id,
    CASE WHEN json_valid(cc.state) THEN
      CASE WHEN json_type(cc.state, '$.confirmed.id') = 'integer' THEN json_extract(cc.state, '$.confirmed.id') END
    END AS company_id,
    CASE WHEN json_valid(cc.state) THEN
      CASE WHEN json_type(cc.state, '$.confirmed.confirmedAtMs') = 'integer'
        THEN json_extract(cc.state, '$.confirmed.confirmedAtMs') END
    END AS confirmed_at_ms
  FROM chat_companies AS cc
)
SELECT l.chat_id AS chatId, l.company_id AS companyId, l.confirmed_at_ms AS confirmedAtMs,
  c.push_name AS pushName, c.pn_jid AS pnJid, c.status, c.interest_level AS level,
  (SELECT min(m.ts_ms) FROM messages AS m WHERE m.chat_id = c.id AND m.author = 'client') AS firstClientMessageAtMs,
  (SELECT max(m.ts_ms) FROM messages AS m WHERE m.chat_id = c.id) AS lastMessageAtMs
FROM links AS l JOIN chats AS c ON c.id = l.chat_id
WHERE l.company_id > 0 AND (@companyId IS NULL OR l.company_id = @companyId)
ORDER BY l.company_id, l.chat_id
LIMIT @limit`;

/** Карточка чата, уведомления, связи с компаниями и счётчики для консоли. */
export type ConsoleDetailReads = Omit<
  ConsoleReads,
  'listChats' | 'countChats' | 'openHandoffs' | 'hotChats' | 'waitingChats' | 'pendingBacklogCount'
>;

/**
 * Выборки для консоли в SQLite (src/domain/console.ts): все вместе на одном соединении бота. Только SELECT и только
 * подготовленные запросы, которые готовятся при первом обращении: без консоли запуск бота их не касается.
 */
export function createConsoleReads(db: Database.Database): ConsoleReads {
  return { ...createConsoleChatListReads(db), ...createConsoleDetailReads(db) };
}

/** Карточка чата, уведомления, связи с компаниями и дневные счётчики. */
export function createConsoleDetailReads(db: Database.Database): ConsoleDetailReads {
  let prepared: ReturnType<typeof prepareStatements> | null = null;
  const statements = (): ReturnType<typeof prepareStatements> =>
    (prepared ??= prepareStatements(db));
  return {
    chatMeta(chatId: ChatId): ChatMeta | null {
      return statements().chatMeta.get(chatId) ?? null;
    },
    profileMeta(chatId: ChatId): ProfileMeta | null {
      return statements().profileMeta.get(chatId) ?? null;
    },
    handoffHistory(chatId: ChatId, limit: number): readonly HandoffHistoryRow[] {
      assertCount(limit, 'limit');
      return statements().handoffs.all(chatId, limit).map(toHandoff);
    },
    countRejected(chatId: ChatId): number {
      return statements().rejected.get(chatId) ?? 0;
    },
    listNotifications(
      query: PageQuery & { readonly status?: ManagerNotificationStatus },
    ): readonly NotificationWithChat[] {
      assertCount(query.limit, 'limit');
      assertCount(query.offset, 'offset');
      const params = { status: query.status ?? null, limit: query.limit, offset: query.offset };
      return statements().notifications.all(params).map(toNotification);
    },
    countNotifications(query: { readonly status?: ManagerNotificationStatus }): number {
      return statements().countNotifications.get({ status: query.status ?? null }) ?? 0;
    },
    companyLinks(query: {
      readonly companyId?: number;
      readonly limit: number;
    }): readonly CompanyLinkRow[] {
      assertCount(query.limit, 'limit');
      const params = { companyId: query.companyId ?? null, limit: query.limit };
      return statements().links.all(params).map(toLink);
    },
    apiCallsOn(day: string): number {
      if (!DAY_PATTERN.test(day)) throw new RangeError('day: ожидается дата ГГГГ-ММ-ДД');
      return statements().apiCalls.get(day, GLOBAL_COUNTER) ?? 0;
    },
    pairingAttemptsSince(sinceMs: number): number {
      assertTimeMs(sinceMs, 'sinceMs');
      return statements().pairing.get(sinceMs) ?? 0;
    },
  };
}

function prepareStatements(db: Database.Database) {
  return {
    chatMeta: db.prepare<[ChatId], ChatMeta>(
      'SELECT status_changed_at AS statusChangedAtMs, created_at AS createdAtMs FROM chats WHERE id = ?',
    ),
    profileMeta: db.prepare<[ChatId], ProfileMeta>(
      'SELECT reason, updated_at_ms AS updatedAtMs FROM client_profiles WHERE chat_id = ?',
    ),
    handoffs: db.prepare<[ChatId, number], HandoffRow>(
      `SELECT id, reason, level, opened_at_ms AS openedAtMs, resolved_at_ms AS resolvedAtMs
       FROM handoffs WHERE chat_id = ? ORDER BY opened_at_ms DESC, id DESC LIMIT ?`,
    ),
    rejected: db
      .prepare<[ChatId], number>('SELECT count(*) FROM rejected_drafts WHERE chat_id = ?')
      .pluck(),
    notifications: db.prepare<
      { status: ManagerNotificationStatus | null } & PageQuery,
      NotificationRow
    >(LIST_NOTIFICATIONS),
    countNotifications: db
      .prepare<{ status: ManagerNotificationStatus | null }, number>(
        'SELECT count(*) FROM manager_notifications WHERE (@status IS NULL OR status = @status)',
      )
      .pluck(),
    links: db.prepare<{ companyId: number | null; limit: number }, LinkRow>(COMPANY_LINKS),
    apiCalls: db
      .prepare<[string, number], number>(
        'SELECT count FROM api_usage WHERE day = ? AND chat_id = ?',
      )
      .pluck(),
    pairing: db
      .prepare<[number], number>('SELECT count(*) FROM pairing_attempts WHERE at_ms > ?')
      .pluck(),
  };
}

function toHandoff(row: HandoffRow): HandoffHistoryRow {
  return {
    id: row.id,
    reason: oneOf(HANDOFF_REASONS, row.reason, 'В handoffs неизвестная причина передачи'),
    level: oneOf(LEVELS, row.level, 'В handoffs неизвестный уровень интереса'),
    openedAtMs: row.openedAtMs,
    resolvedAtMs: row.resolvedAtMs,
  };
}

function toNotification(row: NotificationRow): NotificationWithChat {
  return {
    id: row.id,
    kind: oneOf(KINDS, row.kind, 'В manager_notifications неизвестный вид уведомления'),
    chatId: row.chatId as ChatId | null,
    text: row.text,
    status: oneOf(NOTIFICATION_STATUSES, row.status, 'В manager_notifications неизвестный статус'),
    attempts: row.attempts,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    chatName: row.chatName,
  };
}

function toLink(row: LinkRow): CompanyLinkRow {
  return {
    chatId: row.chatId as ChatId,
    companyId: row.companyId,
    pushName: row.pushName,
    pnJid: row.pnJid as Jid | null,
    status: oneOf(STATUSES, row.status, 'В chats недопустимый статус чата'),
    level: oneOf(LEVELS, row.level, 'В chats неизвестный уровень интереса'),
    confirmedAtMs: row.confirmedAtMs,
    firstClientMessageAtMs: row.firstClientMessageAtMs,
    lastMessageAtMs: row.lastMessageAtMs,
  };
}
