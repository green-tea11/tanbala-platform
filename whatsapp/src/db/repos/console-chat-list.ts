import type Database from 'better-sqlite3';
import type {
  AttentionCounts,
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
import {
  ATTENTION_COUNTS,
  COUNT_CHATS,
  foldName,
  HOT_CHATS,
  LIST_CHATS,
  NAME_MATCH_FUNCTION,
  OPEN_HANDOFFS,
  WAITING_CHATS,
  WAITING_COUNTS,
} from './console-sql.js';

/** Чат у бота считается «молчит», если клиент ждёт дольше этого (пачка до 15 с, ответ модели до минуты). */
export const BOT_SILENT_AFTER_MS = 5 * 60_000;
/** «Требует внимания» показывает ждущих ответа, только если клиент писал за это время: старые чаты не копятся. */
export const WAITING_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** Вариантов имени в поиске не больше этого (столько параметров у функции поиска в SQL). */
const NAME_VARIANTS_MAX = 4;

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

interface FilterParams {
  readonly status: string | null;
  readonly level: string | null;
  readonly company: string | null;
  readonly waitingOnly: 0 | 1;
  readonly searching: 0 | 1;
  readonly q1: string | null;
  readonly q2: string | null;
  readonly q3: string | null;
  readonly q4: string | null;
  readonly digits: string | null;
  readonly silentBeforeMs: number;
}

interface WaitingParams {
  readonly silentBeforeMs: number;
  readonly clientSinceMs: number;
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
  | 'listChats'
  | 'countChats'
  | 'openHandoffs'
  | 'hotChats'
  | 'waitingChats'
  | 'attentionCounts'
  | 'pendingBacklogCount'
>;

/**
 * Список чатов и «Требует внимания» для консоли в SQLite (SQL в console-sql.ts). Только SELECT и только подготовленные
 * запросы; запросы и функция поиска по имени готовятся при первом обращении, поэтому без консоли (нет
 * WA_CONSOLE_TOKEN) запуск бота их не касается. Значения фильтров приходят из src/panel уже проверенными, здесь их
 * проверяет ещё и CHECK-список (oneOf) на выходе.
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
      assertCount(limit, 'limit');
      const params = { ...waitingParams(nowMs, windowStartOf(nowMs)), limit };
      return statements().waiting.all(params).map(toWaitingRow);
    },
    attentionCounts(nowMs: number): AttentionCounts {
      const waiting = statements().waitingCounts.get({
        ...waitingParams(nowMs, 0),
        freshSinceMs: windowStartOf(nowMs),
      });
      const other = statements().counts.get();
      return {
        handoffs: other?.handoffs ?? 0,
        hot: other?.hot ?? 0,
        waiting: waiting?.fresh ?? 0,
        staleWaiting: waiting?.stale ?? 0,
      };
    },
    pendingBacklogCount(): number {
      return statements().backlog.get() ?? 0;
    },
  };
}

/** Регистрирует функцию поиска по имени на соединении (новое имя, встроенные функции SQLite не меняются). */
function registerNameMatch(db: Database.Database): void {
  db.function(
    NAME_MATCH_FUNCTION,
    { deterministic: true, varargs: true },
    (name: unknown, ...needles: unknown[]) => {
      if (typeof name !== 'string') return 0;
      const folded = foldName(name);
      return needles.some((needle) => typeof needle === 'string' && folded.includes(needle))
        ? 1
        : 0;
    },
  );
}

function prepareStatements(db: Database.Database) {
  registerNameMatch(db);
  return {
    list: db.prepare<FilterParams & PageQuery, ListRow>(LIST_CHATS),
    count: db.prepare<FilterParams, number>(COUNT_CHATS).pluck(),
    waiting: db.prepare<WaitingParams & { limit: number }, WaitingRow>(WAITING_CHATS),
    waitingCounts: db.prepare<
      WaitingParams & { freshSinceMs: number },
      { fresh: number; stale: number }
    >(WAITING_COUNTS),
    counts: db.prepare<[], { handoffs: number; hot: number }>(ATTENTION_COUNTS),
    openHandoffs: db.prepare<[number], HandoffRow>(OPEN_HANDOFFS),
    hot: db.prepare<[number], HotRow>(HOT_CHATS),
    backlog: db
      .prepare<[], number>('SELECT count(*) FROM backlog_chats WHERE notified_at_ms IS NULL')
      .pluck(),
  };
}

/** Начало окна «ждут ответа»: 30 дней назад, не раньше нуля. */
function windowStartOf(nowMs: number): number {
  return Math.max(0, nowMs - WAITING_WINDOW_MS);
}

/** Параметры «ждут ответа»: порог «бот молчит» и с какого времени клиент должен был писать. */
function waitingParams(nowMs: number, clientSinceMs: number): WaitingParams {
  assertTimeMs(nowMs, 'nowMs');
  return { silentBeforeMs: nowMs - BOT_SILENT_AFTER_MS, clientSinceMs };
}

/**
 * Варианты имени для поиска в одном виде с именем (foldName), без повторов и пустых: пустой вариант совпал бы с любым
 * именем. Нет вариантов => NULL, функция поиска их пропускает.
 */
function nameNeedles(variants: readonly string[]): readonly (string | null)[] {
  const needles = [...new Set(variants.map(foldName))].filter((needle) => needle !== '');
  return Array.from({ length: NAME_VARIANTS_MAX }, (_unused, index) => needles[index] ?? null);
}

/** Параметры фильтра для SQL: незаданное => NULL; поиск без вариантов имени и без цифр не фильтрует. */
function filterParams(filter: ConsoleChatFilter): FilterParams {
  assertTimeMs(filter.nowMs, 'nowMs');
  const [q1 = null, q2 = null, q3 = null, q4 = null] = nameNeedles(
    filter.search?.nameVariants ?? [],
  );
  const digits = filter.search?.digits ?? null;
  return {
    status: filter.status ?? null,
    level: filter.level ?? null,
    company: filter.company ?? null,
    waitingOnly: filter.waitingOnly === true ? 1 : 0,
    searching: q1 !== null || digits !== null ? 1 : 0,
    q1,
    q2,
    q3,
    q4,
    digits,
    silentBeforeMs: filter.nowMs - BOT_SILENT_AFTER_MS,
  };
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
