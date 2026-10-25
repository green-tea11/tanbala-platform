import type Database from 'better-sqlite3';
import type { ChatsRepo } from '../../domain/ports.js';
import type {
  Chat,
  ChatControl,
  ChatId,
  ChatIdentity,
  ClientProfile,
  InterestLevel,
  Jid,
} from '../../domain/types.js';
import { notImplemented } from '../../shared/todo.js';
import { assertTimeMs } from '../time.js';

/** Колонки чата без id: их пишет upsertByIdentity. */
interface ChatColumns {
  readonly reply_jid: string;
  readonly lid_jid: string | null;
  readonly pn_jid: string | null;
  readonly phone: string | null;
  readonly push_name: string | null;
  readonly status: string;
  readonly status_by: string | null;
  readonly status_changed_at: number | null;
  readonly interest_level: string;
  readonly last_inbound_at: number | null;
  readonly created_at: number;
}

/** Строка таблицы chats. */
interface ChatRow extends ChatColumns {
  readonly id: number;
}

const SELECT_CHAT = `SELECT id, reply_jid, lid_jid, pn_jid, phone, push_name, status, status_by,
  status_changed_at, interest_level, last_inbound_at, created_at FROM chats`;

/** Уровни интереса от холодного к горячему: при слиянии остаётся самый горячий. */
const LEVELS: readonly InterestLevel[] = ['cold', 'warm', 'hot'];

/** Кто может передать чат менеджеру (StatusChange со статусом manager). */
const MANAGER_AUTHORS = ['bot', 'phone', 'panel'] as const;

/** Номер из адреса с номером: цифры до «@» без суффикса устройства «:N». В адресе @lid номера нет. */
const PN_JID = /^(\d+)(?::\d+)?@(?:s\.whatsapp\.net|hosted)$/;

/** Выжимки до этапа 4 нет: все поля «не выяснили». */
const EMPTY_PROFILE: ClientProfile = Object.freeze({
  business: null,
  area: null,
  scope: null,
  itemCount: null,
  has1C: null,
  problem: null,
  specifics: null,
});

/**
 * Чаты и выжимки клиентов в SQLite. Здесь числовой id из базы приводится к ChatId.
 * Только подготовленные запросы с параметрами.
 * upsertByIdentity ищет чат по всем адресам (reply_jid, lid_jid, pn_jid). Нашлось несколько (для @lid стал известен
 * номер или наоборот) => сливает их в старший: история и отметка простоя переезжают, статус менеджера и более
 * горячий интерес не теряются. Новые адреса и имя важнее старых, имя null известное не стирает; reply_jid всегда
 * адрес последнего сообщения. phone: цифры из pn_jid для уведомления менеджеру.
 * findByJid ищет по тем же трём адресам и не создаёт чат. Chat.control собирается из статуса и status_by
 * (status_by пуст => { status: 'bot', by: null }). Выжимки до этапа 4 нет: profile пустой.
 * TODO(этап 6): сортировку для панели брать из белого списка колонок.
 * TODO(этап 3): setStatus хранит StatusChange (статус, кто, когда).
 * TODO(этап 4): saveAssessment обновляет уровень интереса и client_profiles в одной транзакции.
 * TODO(этап 4): при слиянии чатов (absorb) переносить и client_profiles, на этапе 5 так же handoffs: иначе внешний ключ не даст удалить слитый чат.
 * TODO(этап 6): listForPanel с пагинацией (limit, offset).
 */
export function createChatsRepo(db: Database.Database): ChatsRepo {
  const statements = prepareStatements(db);
  const upsert = db.transaction(
    (identity: ChatIdentity, pushName: string | null, nowMs: number): Chat => {
      const rows = statements.byIdentity.all({
        reply: identity.replyJid,
        lid: identity.lidJid,
        pn: identity.pnJid,
      });
      const columns = mergeColumns(rows, identity, pushName, nowMs);
      const [survivor, ...absorbed] = rows;
      if (survivor === undefined) {
        const id = Number(statements.insert.run(columns).lastInsertRowid);
        return toChat({ ...columns, id });
      }
      for (const row of absorbed) absorb(statements, survivor.id, row.id);
      statements.update.run({ ...columns, id: survivor.id });
      return toChat({ ...columns, id: survivor.id });
    },
  );
  return {
    upsertByIdentity(identity: ChatIdentity, pushName: string | null, nowMs: number): Chat {
      assertTimeMs(nowMs, 'nowMs');
      return upsert.immediate(identity, pushName, nowMs);
    },
    findByJid(jid: Jid): Chat | null {
      const row = statements.byJid.get({ jid });
      return row === undefined ? null : toChat(row);
    },
    getById(id: ChatId): Chat | null {
      const row = statements.byId.get(id);
      return row === undefined ? null : toChat(row);
    },
    setStatus: () => notImplemented('этап 3', 'db/repos/chats.setStatus'),
    saveAssessment: () => notImplemented('этап 4', 'db/repos/chats.saveAssessment'),
    listForPanel: () => notImplemented('этап 6', 'db/repos/chats.listForPanel'),
  };
}

function prepareStatements(db: Database.Database) {
  return {
    byIdentity: db.prepare<{ reply: Jid; lid: Jid | null; pn: Jid | null }, ChatRow>(
      `${SELECT_CHAT}
       WHERE reply_jid IN (@reply, @lid, @pn) OR lid_jid IN (@reply, @lid, @pn) OR pn_jid IN (@reply, @lid, @pn)
       ORDER BY id`,
    ),
    byJid: db.prepare<{ jid: Jid }, ChatRow>(
      `${SELECT_CHAT} WHERE reply_jid = @jid OR lid_jid = @jid OR pn_jid = @jid ORDER BY id LIMIT 1`,
    ),
    byId: db.prepare<[number], ChatRow>(`${SELECT_CHAT} WHERE id = ?`),
    insert: db.prepare<ChatColumns>(
      `INSERT INTO chats (reply_jid, lid_jid, pn_jid, phone, push_name, status, status_by,
         status_changed_at, interest_level, last_inbound_at, created_at)
       VALUES (@reply_jid, @lid_jid, @pn_jid, @phone, @push_name, @status, @status_by,
         @status_changed_at, @interest_level, @last_inbound_at, @created_at)`,
    ),
    update: db.prepare<ChatRow>(
      `UPDATE chats SET reply_jid = @reply_jid, lid_jid = @lid_jid, pn_jid = @pn_jid, phone = @phone,
         push_name = @push_name, status = @status, status_by = @status_by,
         status_changed_at = @status_changed_at, interest_level = @interest_level,
         last_inbound_at = @last_inbound_at, created_at = @created_at
       WHERE id = @id`,
    ),
    // Отметка простоя: более позднее время; чат ждёт уведомления, если ждала хоть одна из отметок.
    mergeBacklog: db.prepare<{ survivor: number; absorbed: number }>(
      `INSERT INTO backlog_chats (chat_id, marked_at_ms, notified_at_ms)
       SELECT @survivor, marked_at_ms, notified_at_ms FROM backlog_chats WHERE chat_id = @absorbed
       ON CONFLICT (chat_id) DO UPDATE SET
         marked_at_ms = max(backlog_chats.marked_at_ms, excluded.marked_at_ms),
         notified_at_ms = CASE
           WHEN backlog_chats.notified_at_ms IS NULL OR excluded.notified_at_ms IS NULL THEN NULL
           ELSE max(backlog_chats.notified_at_ms, excluded.notified_at_ms)
         END`,
    ),
    dropBacklog: db.prepare<[number]>('DELETE FROM backlog_chats WHERE chat_id = ?'),
    // Сообщение с тем же wa_id уже есть в оставшемся чате: строка остаётся на месте и удаляется ниже.
    moveMessages: db.prepare<{ survivor: number; absorbed: number }>(
      'UPDATE OR IGNORE messages SET chat_id = @survivor WHERE chat_id = @absorbed',
    ),
    dropMessages: db.prepare<[number]>('DELETE FROM messages WHERE chat_id = ?'),
    dropChat: db.prepare<[number]>('DELETE FROM chats WHERE id = ?'),
  };
}

type Statements = ReturnType<typeof prepareStatements>;

/** Переносит в оставшийся чат историю и отметку простоя слитого чата и удаляет его строку. */
function absorb(statements: Statements, survivor: number, absorbed: number): void {
  statements.mergeBacklog.run({ survivor, absorbed });
  statements.dropBacklog.run(absorbed);
  statements.moveMessages.run({ survivor, absorbed });
  statements.dropMessages.run(absorbed);
  statements.dropChat.run(absorbed);
}

/**
 * Колонки чата после записи. rows: найденные по адресам строки, старшая первой; пусто => новый чат.
 * Статус менеджера важнее статуса бота: иначе после слияния бот ответил бы поверх человека.
 */
function mergeColumns(
  rows: readonly ChatRow[],
  identity: ChatIdentity,
  pushName: string | null,
  nowMs: number,
): ChatColumns {
  const pnJid = identity.pnJid ?? firstKnown(rows.map((row) => row.pn_jid));
  const control = rows.find((row) => row.status === 'manager') ?? rows[0];
  return {
    reply_jid: identity.replyJid,
    lid_jid: identity.lidJid ?? firstKnown(rows.map((row) => row.lid_jid)),
    pn_jid: pnJid,
    phone: pnJid === null ? null : (PN_JID.exec(pnJid)?.[1] ?? null),
    push_name: pushName ?? firstKnown(rows.map((row) => row.push_name)),
    status: control?.status ?? 'bot',
    status_by: control?.status_by ?? null,
    status_changed_at: control?.status_changed_at ?? null,
    interest_level: hottestLevel(rows),
    last_inbound_at: Math.max(nowMs, ...rows.map((row) => row.last_inbound_at ?? 0)),
    created_at: rows.length === 0 ? nowMs : Math.min(...rows.map((row) => row.created_at)),
  };
}

function firstKnown(values: readonly (string | null)[]): string | null {
  return values.find((value) => value !== null) ?? null;
}

function hottestLevel(rows: readonly ChatRow[]): InterestLevel {
  return rows.reduce<InterestLevel>((hottest, row) => {
    const level = toLevel(row.interest_level);
    return LEVELS.indexOf(level) > LEVELS.indexOf(hottest) ? level : hottest;
  }, 'cold');
}

function toChat(row: ChatRow): Chat {
  return {
    id: row.id as ChatId,
    identity: {
      replyJid: row.reply_jid as Jid,
      lidJid: row.lid_jid as Jid | null,
      pnJid: row.pn_jid as Jid | null,
    },
    pushName: row.push_name,
    control: toControl(row.status, row.status_by),
    level: toLevel(row.interest_level),
    profile: EMPTY_PROFILE,
  };
}

function toControl(status: string, by: string | null): ChatControl {
  if (status === 'bot' && (by === null || by === 'panel')) return { status, by };
  const managerBy = MANAGER_AUTHORS.find((author) => author === by);
  if (status === 'manager' && managerBy !== undefined) return { status, by: managerBy };
  throw new Error('В chats недопустимый статус чата: строка испорчена');
}

function toLevel(value: string): InterestLevel {
  const level = LEVELS.find((candidate) => candidate === value);
  if (level === undefined)
    throw new Error('В chats неизвестный уровень интереса: строка испорчена');
  return level;
}
