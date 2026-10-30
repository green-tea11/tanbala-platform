import type Database from 'better-sqlite3';
import type {
  AttentionHandoffRow,
  ChatCompanyLink,
  ConsoleChatFilter,
  ConsoleChatRow,
  ConsoleReads,
  HotChatRow,
  LastMessage,
  PageQuery,
  WaitingChatRow,
} from '../../domain/console.js';
import type {
  Author,
  ChatControl,
  ChatId,
  ChatStatus,
  Jid,
  ManagerNotificationStatus,
  MessageKind,
  OpenHandoff,
} from '../../domain/types.js';
import { assertTimeMs } from '../time.js';
import { assertCount, HANDOFF_REASONS, LEVELS, oneOf } from '../values.js';

/** Чат у бота считается «молчит», если клиент ждёт дольше этого (пачка до 15 с, ответ модели до минуты). */
export const BOT_SILENT_AFTER_MS = 5 * 60_000;

const AUTHORS: readonly Author[] = ['client', 'bot', 'human_phone', 'human_panel'];
const KINDS: readonly MessageKind[] = ['text', 'voice', 'other'];
const STATUSES: readonly ChatStatus[] = ['bot', 'manager'];
const NOTIFICATION_STATUSES: readonly ManagerNotificationStatus[] = [
  'pending',
  'sent',
  'no_manager',
  'skipped_limit',
  'failed',
];
const MANAGER_AUTHORS = ['bot', 'phone', 'panel'] as const;

/**
 * Чаты с вычисленным: время последнего сообщения, последнего сообщения клиента, связь с компанией по JSON записи бота
 * и «ждёт с». Ответ (answer) — сообщение человека или бота, кроме фразы о передаче (outbound_ids.origin
 * handoff_notice): она клиенту не ответ. CASE, а не AND: json_type на тексте не JSON бросает ошибку, а CASE
 * вычисляется по порядку.
 */
const DERIVED = `
base AS (
  SELECT c.id, c.push_name, c.pn_jid, c.phone, c.status, c.status_by, c.interest_level,
    (SELECT max(m.ts_ms) FROM messages AS m WHERE m.chat_id = c.id) AS last_message_at_ms,
    (SELECT max(m.ts_ms) FROM messages AS m WHERE m.chat_id = c.id AND m.author = 'client') AS last_client_ms,
    (SELECT max(m.ts_ms) FROM messages AS m WHERE m.chat_id = c.id AND m.author <> 'client') AS last_out_ms,
    (SELECT max(m.ts_ms) FROM messages AS m WHERE m.chat_id = c.id
       AND (m.author IN ('human_phone', 'human_panel')
         OR (m.author = 'bot' AND NOT EXISTS (
           SELECT 1 FROM outbound_ids AS o
           WHERE o.wa_id = m.wa_id AND o.chat_id = m.chat_id AND o.origin = 'handoff_notice')))
    ) AS last_answer_ms,
    CASE WHEN json_valid(cc.state) THEN
      CASE WHEN json_type(cc.state, '$.confirmed.id') = 'integer' THEN 'confirmed'
           WHEN json_type(cc.state, '$.candidate.id') = 'integer' THEN 'candidate' END
    END AS company_state,
    CASE WHEN json_valid(cc.state) THEN
      CASE WHEN json_type(cc.state, '$.confirmed.id') = 'integer' THEN json_extract(cc.state, '$.confirmed.id')
           WHEN json_type(cc.state, '$.candidate.id') = 'integer' THEN json_extract(cc.state, '$.candidate.id') END
    END AS company_id,
    CASE WHEN json_valid(cc.state) THEN
      CASE WHEN json_type(cc.state, '$.confirmed.id') = 'integer' THEN json_extract(cc.state, '$.confirmed.name')
           WHEN json_type(cc.state, '$.candidate.id') = 'integer' THEN json_extract(cc.state, '$.candidate.name') END
    END AS company_name
  FROM chats AS c LEFT JOIN chat_companies AS cc ON cc.chat_id = c.id
),
pending AS (
  SELECT b.*,
    (SELECT min(m.ts_ms) FROM messages AS m WHERE m.chat_id = b.id AND m.author = 'client'
       AND m.ts_ms > coalesce(CASE WHEN b.status = 'manager' THEN b.last_answer_ms ELSE b.last_out_ms END, -1)
    ) AS pending_since_ms
  FROM base AS b
),
derived AS (
  SELECT p.*,
    CASE WHEN p.status = 'manager' THEN p.pending_since_ms
         WHEN p.pending_since_ms <= @silentBeforeMs THEN p.pending_since_ms END AS waiting_since_ms
  FROM pending AS p
)`;

/** Условия фильтра списка: параметр NULL (или 0 у флагов) не фильтрует. */
const FILTER = `
  (@status IS NULL OR d.status = @status)
  AND (@level IS NULL OR d.interest_level = @level)
  AND (@company IS NULL OR coalesce(d.company_state, 'none') = @company)
  AND (@waitingOnly = 0 OR d.waiting_since_ms IS NOT NULL)
  AND (@searching = 0
    OR instr(coalesce(d.push_name, ''), @q1) > 0 OR instr(coalesce(d.push_name, ''), @q2) > 0
    OR instr(coalesce(d.push_name, ''), @q3) > 0 OR instr(coalesce(d.push_name, ''), @q4) > 0
    OR (@digits IS NOT NULL AND instr(coalesce(d.phone, ''), @digits) > 0))`;

/**
 * Страница списка. Сортировка как у старой панели: свежее последнее сообщение сверху, затем id; чаты без сообщений
 * в конце. Открытая передача одна на чат (частичный уникальный индекс), строки не размножаются.
 */
const LIST_CHATS = `WITH ${DERIVED}
SELECT d.id, d.push_name AS pushName, d.pn_jid AS pnJid, d.status, d.status_by AS statusBy,
  d.interest_level AS level, d.last_message_at_ms AS lastMessageAtMs, d.waiting_since_ms AS waitingSinceMs,
  d.company_state AS companyState, d.company_id AS companyId, d.company_name AS companyName,
  h.reason AS handoffReason, h.level AS handoffLevel, h.opened_at_ms AS handoffOpenedAtMs,
  lm.author AS lastAuthor, lm.kind AS lastKind, lm.text AS lastText
FROM derived AS d
LEFT JOIN handoffs AS h ON h.chat_id = d.id AND h.resolved_at_ms IS NULL
LEFT JOIN messages AS lm ON lm.id = (
  SELECT m.id FROM messages AS m WHERE m.chat_id = d.id ORDER BY m.ts_ms DESC, m.id DESC LIMIT 1)
WHERE ${FILTER}
ORDER BY d.last_message_at_ms DESC, d.id DESC
LIMIT @limit OFFSET @offset`;

const COUNT_CHATS = `WITH ${DERIVED} SELECT count(*) FROM derived AS d WHERE ${FILTER}`;

/** Чаты, где ждут ответа: дольше всех ждущие первыми; последняя передача жалоба => пометка. */
const WAITING_CHATS = `WITH ${DERIVED}
SELECT d.id AS chatId, d.push_name AS pushName, d.pn_jid AS pnJid, d.status,
  d.waiting_since_ms AS waitingSinceMs, d.last_client_ms AS lastClientAtMs,
  coalesce((SELECT h.reason FROM handoffs AS h WHERE h.chat_id = d.id
    ORDER BY h.opened_at_ms DESC, h.id DESC LIMIT 1) = 'complaint', 0) AS complaint
FROM derived AS d
WHERE d.waiting_since_ms IS NOT NULL
ORDER BY d.waiting_since_ms, d.id
LIMIT @limit`;

/** Открытые передачи, кроме перехвата человеком, и первое уведомление менеджеру после открытия (handoff или limit). */
const OPEN_HANDOFFS = `SELECT h.id, h.chat_id AS chatId, h.reason, h.level, h.opened_at_ms AS openedAtMs,
  c.push_name AS pushName, c.pn_jid AS pnJid, n.status AS notifyStatus, n.attempts AS notifyAttempts
FROM handoffs AS h JOIN chats AS c ON c.id = h.chat_id
LEFT JOIN manager_notifications AS n ON n.id = (
  SELECT n2.id FROM manager_notifications AS n2
  WHERE n2.chat_id = h.chat_id AND n2.kind IN ('handoff', 'limit') AND n2.created_at_ms >= h.opened_at_ms
  ORDER BY n2.created_at_ms, n2.id LIMIT 1)
WHERE h.resolved_at_ms IS NULL AND h.reason <> 'human_took_over'
ORDER BY h.opened_at_ms DESC, h.id DESC
LIMIT ?`;

const HOT_CHATS = `SELECT c.id AS chatId, c.push_name AS pushName, c.pn_jid AS pnJid, c.status,
  p.reason AS levelReason, p.updated_at_ms AS levelUpdatedAtMs,
  (SELECT max(m.ts_ms) FROM messages AS m WHERE m.chat_id = c.id) AS lastMessageAtMs
FROM chats AS c LEFT JOIN client_profiles AS p ON p.chat_id = c.id
WHERE c.interest_level = 'hot'
ORDER BY lastMessageAtMs DESC, c.id DESC
LIMIT ?`;

interface FilterParams {
  readonly status: string | null;
  readonly level: string | null;
  readonly company: string | null;
  readonly waitingOnly: 0 | 1;
  readonly searching: 0 | 1;
  readonly q1: string;
  readonly q2: string;
  readonly q3: string;
  readonly q4: string;
  readonly digits: string | null;
  readonly silentBeforeMs: number;
}

interface ListRow {
  readonly id: number;
  readonly pushName: string | null;
  readonly pnJid: string | null;
  readonly status: string;
  readonly statusBy: string | null;
  readonly level: string;
  readonly lastMessageAtMs: number | null;
  readonly waitingSinceMs: number | null;
  readonly companyState: string | null;
  readonly companyId: number | null;
  readonly companyName: unknown;
  readonly handoffReason: string | null;
  readonly handoffLevel: string | null;
  readonly handoffOpenedAtMs: number | null;
  readonly lastAuthor: string | null;
  readonly lastKind: string | null;
  readonly lastText: string | null;
}

interface WaitingRow {
  readonly chatId: number;
  readonly pushName: string | null;
  readonly pnJid: string | null;
  readonly status: string;
  readonly waitingSinceMs: number;
  readonly lastClientAtMs: number;
  readonly complaint: number;
}

interface HandoffRow {
  readonly id: number;
  readonly chatId: number;
  readonly reason: string;
  readonly level: string;
  readonly openedAtMs: number;
  readonly pushName: string | null;
  readonly pnJid: string | null;
  readonly notifyStatus: string | null;
  readonly notifyAttempts: number | null;
}

interface HotRow {
  readonly chatId: number;
  readonly pushName: string | null;
  readonly pnJid: string | null;
  readonly status: string;
  readonly levelReason: string | null;
  readonly levelUpdatedAtMs: number | null;
  readonly lastMessageAtMs: number | null;
}

/** Чтение списка чатов и «Требует внимания» для консоли. */
export type ConsoleChatListReads = Pick<
  ConsoleReads,
  'listChats' | 'countChats' | 'openHandoffs' | 'hotChats' | 'waitingChats' | 'pendingBacklogCount'
>;

/**
 * Список чатов и «Требует внимания» для консоли в SQLite. Только SELECT и только подготовленные запросы; запросы
 * готовятся при первом обращении, поэтому без консоли (нет WA_CONSOLE_TOKEN) запуск бота их не касается. Значения
 * фильтров приходят из src/panel уже проверенными, здесь их проверяет ещё и CHECK-список (oneOf) на выходе.
 */
export function createConsoleChatListReads(db: Database.Database): ConsoleChatListReads {
  let prepared: ReturnType<typeof prepareStatements> | null = null;
  const statements = (): ReturnType<typeof prepareStatements> =>
    (prepared ??= prepareStatements(db));
  return {
    listChats(filter: ConsoleChatFilter, page: PageQuery): readonly ConsoleChatRow[] {
      assertCount(page.limit, 'limit');
      assertCount(page.offset, 'offset');
      const params = { ...filterParams(filter), limit: page.limit, offset: page.offset };
      return statements().list.all(params).map(toChatRow);
    },
    countChats(filter: ConsoleChatFilter): number {
      return statements().count.get(filterParams(filter)) ?? 0;
    },
    openHandoffs(limit: number): readonly AttentionHandoffRow[] {
      assertCount(limit, 'limit');
      return statements().openHandoffs.all(limit).map(toHandoffRow);
    },
    hotChats(limit: number): readonly HotChatRow[] {
      assertCount(limit, 'limit');
      return statements().hot.all(limit).map(toHotRow);
    },
    waitingChats(nowMs: number, limit: number): readonly WaitingChatRow[] {
      assertTimeMs(nowMs, 'nowMs');
      assertCount(limit, 'limit');
      const params = { silentBeforeMs: nowMs - BOT_SILENT_AFTER_MS, limit };
      return statements().waiting.all(params).map(toWaitingRow);
    },
    pendingBacklogCount(): number {
      return statements().backlog.get() ?? 0;
    },
  };
}

function prepareStatements(db: Database.Database) {
  return {
    list: db.prepare<FilterParams & PageQuery, ListRow>(LIST_CHATS),
    count: db.prepare<FilterParams, number>(COUNT_CHATS).pluck(),
    waiting: db.prepare<{ silentBeforeMs: number; limit: number }, WaitingRow>(WAITING_CHATS),
    openHandoffs: db.prepare<[number], HandoffRow>(OPEN_HANDOFFS),
    hot: db.prepare<[number], HotRow>(HOT_CHATS),
    backlog: db
      .prepare<[], number>('SELECT count(*) FROM backlog_chats WHERE notified_at_ms IS NULL')
      .pluck(),
  };
}

/** Параметры фильтра для SQL: незаданное => NULL; без поиска все варианты пусты и не участвуют. */
function filterParams(filter: ConsoleChatFilter): FilterParams {
  assertTimeMs(filter.nowMs, 'nowMs');
  const [q1 = '', q2 = q1, q3 = q1, q4 = q1] = filter.search?.nameVariants ?? [];
  const searching = filter.search !== undefined && (q1 !== '' || filter.search.digits !== null);
  return {
    status: filter.status ?? null,
    level: filter.level ?? null,
    company: filter.company ?? null,
    waitingOnly: filter.waitingOnly === true ? 1 : 0,
    searching: searching ? 1 : 0,
    // Пустой вариант совпал бы с любым именем (instr(x, '') = 1): заменяется заведомо несовпадающим.
    q1: nonEmpty(q1),
    q2: nonEmpty(q2),
    q3: nonEmpty(q3),
    q4: nonEmpty(q4),
    digits: filter.search?.digits ?? null,
    silentBeforeMs: filter.nowMs - BOT_SILENT_AFTER_MS,
  };
}

/** Символ, которого нет в именах (U+FFFF не символ Unicode): instr с ним всегда 0. */
const NEVER_MATCHES = '￿';

function nonEmpty(variant: string): string {
  return variant === '' ? NEVER_MATCHES : variant;
}

function toChatRow(row: ListRow): ConsoleChatRow {
  return {
    id: row.id as ChatId,
    pushName: row.pushName,
    pnJid: row.pnJid as Jid | null,
    control: controlOf(row.status, row.statusBy),
    level: oneOf(LEVELS, row.level, 'В chats неизвестный уровень интереса'),
    lastMessageAtMs: row.lastMessageAtMs,
    lastMessage: lastMessageOf(row),
    openHandoff: openHandoffOf(row),
    company: companyOf(row),
    waitingSinceMs: row.waitingSinceMs,
  };
}

function lastMessageOf(row: ListRow): LastMessage | null {
  if (row.lastAuthor === null || row.lastKind === null) return null;
  return {
    author: oneOf(AUTHORS, row.lastAuthor, 'В messages неизвестный автор сообщения'),
    kind: oneOf(KINDS, row.lastKind, 'В messages неизвестный вид сообщения'),
    text: row.lastText,
  };
}

function openHandoffOf(row: ListRow): OpenHandoff | null {
  const { handoffReason: reason, handoffLevel: level, handoffOpenedAtMs: openedAtMs } = row;
  if (reason === null || level === null || openedAtMs === null) return null;
  return {
    reason: oneOf(HANDOFF_REASONS, reason, 'В handoffs неизвестная причина передачи'),
    level: oneOf(LEVELS, level, 'В handoffs неизвестный уровень интереса'),
    openedAtMs,
  };
}

/** Компания из JSON записи бота: id только положительное целое, название только строка. */
function companyOf(row: ListRow): ChatCompanyLink | null {
  const { companyState: state, companyId: id, companyName: name } = row;
  if ((state !== 'confirmed' && state !== 'candidate') || id === null || id < 1) return null;
  return { state, id, name: typeof name === 'string' ? name : null };
}

/** Кто ведёт чат: те же правила, что CHECK таблицы chats и db/repos/chats.ts. */
function controlOf(status: string, by: string | null): ChatControl {
  if (status === 'bot' && (by === null || by === 'panel')) return { status, by };
  const managerBy = MANAGER_AUTHORS.find((author) => author === by);
  if (status === 'manager' && managerBy !== undefined) return { status, by: managerBy };
  throw new Error('В chats недопустимый статус чата: строка испорчена');
}

function statusOf(value: string): ChatStatus {
  return oneOf(STATUSES, value, 'В chats недопустимый статус чата');
}

function toWaitingRow(row: WaitingRow): WaitingChatRow {
  const status = statusOf(row.status);
  return {
    chatId: row.chatId as ChatId,
    pushName: row.pushName,
    pnJid: row.pnJid as Jid | null,
    status,
    group: status,
    waitingSinceMs: row.waitingSinceMs,
    lastClientAtMs: row.lastClientAtMs,
    complaint: row.complaint === 1,
  };
}

function toHandoffRow(row: HandoffRow): AttentionHandoffRow {
  const { notifyStatus, notifyAttempts } = row;
  return {
    id: row.id,
    chatId: row.chatId as ChatId,
    pushName: row.pushName,
    pnJid: row.pnJid as Jid | null,
    reason: oneOf(HANDOFF_REASONS, row.reason, 'В handoffs неизвестная причина передачи'),
    level: oneOf(LEVELS, row.level, 'В handoffs неизвестный уровень интереса'),
    openedAtMs: row.openedAtMs,
    notification:
      notifyStatus === null || notifyAttempts === null
        ? null
        : {
            status: oneOf(
              NOTIFICATION_STATUSES,
              notifyStatus,
              'В manager_notifications неизвестный статус',
            ),
            attempts: notifyAttempts,
          },
  };
}

function toHotRow(row: HotRow): HotChatRow {
  return {
    chatId: row.chatId as ChatId,
    pushName: row.pushName,
    pnJid: row.pnJid as Jid | null,
    status: statusOf(row.status),
    levelReason: row.levelReason,
    levelUpdatedAtMs: row.levelUpdatedAtMs,
    lastMessageAtMs: row.lastMessageAtMs,
  };
}
