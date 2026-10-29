import type Database from 'better-sqlite3';
import type { KnownChat, SwitchChat, WorkingModeRepo } from '../../domain/ports.js';
import type { ChatId, ChatStatus, Jid } from '../../domain/types.js';
import { oneOf } from '../values.js';

/** Строка known_chats для правила перехода. */
interface KnownRow {
  readonly jid: string;
  readonly last_activity_ms: number;
}

/** Строка chats с временем последнего сообщения. */
interface ChatRow {
  readonly id: number;
  readonly reply_jid: string;
  readonly lid_jid: string | null;
  readonly pn_jid: string | null;
  readonly status: string;
  readonly last_message_at_ms: number | null;
}

const CHAT_STATUSES: readonly ChatStatus[] = ['bot', 'manager'];

/**
 * Переход в рабочий режим в SQLite: known_chats.held_for_manager (схема версии 9) и чтение chats. Список адресов
 * уходит в запрос одним параметром JSON (json_each): переход отмечает тысячи адресов без лимита переменных SQLite и
 * без SQL из строк. Только подготовленные запросы. holdForManager звать внутри UnitOfWork.run вместе с границей,
 * addHeldForManager после touch этих адресов в той же транзакции.
 */
export function createWorkingModeRepo(db: Database.Database): WorkingModeRepo {
  const known = db.prepare<[], KnownRow>(
    'SELECT jid, last_activity_ms FROM known_chats ORDER BY jid',
  );
  const chats = db.prepare<[], ChatRow>(
    `SELECT c.id, c.reply_jid, c.lid_jid, c.pn_jid, c.status,
       (SELECT max(m.ts_ms) FROM messages AS m WHERE m.chat_id = c.id) AS last_message_at_ms
     FROM chats AS c ORDER BY c.id`,
  );
  const hold = db.prepare<[string]>(
    'UPDATE known_chats SET held_for_manager = (jid IN (SELECT value FROM json_each(?)))',
  );
  const addHold = db.prepare<[string]>(
    'UPDATE known_chats SET held_for_manager = 1 WHERE jid IN (SELECT value FROM json_each(?))',
  );
  const anyHeld = db
    .prepare<[string], number>(
      `SELECT 1 FROM known_chats
       WHERE held_for_manager = 1 AND jid IN (SELECT value FROM json_each(?)) LIMIT 1`,
    )
    .pluck();
  return {
    listKnownChats: () => known.all().map(toKnownChat),
    listChats: () => chats.all().map(toSwitchChat),
    holdForManager(jids: readonly Jid[]): void {
      hold.run(JSON.stringify(jids));
    },
    addHeldForManager(jids: readonly Jid[]): void {
      if (jids.length > 0) addHold.run(JSON.stringify(jids));
    },
    isHeldForManager(jids: readonly Jid[]): boolean {
      return jids.length > 0 && anyHeld.get(JSON.stringify(jids)) !== undefined;
    },
  };
}

function toKnownChat(row: KnownRow): KnownChat {
  return { jid: row.jid as Jid, lastActivityMs: row.last_activity_ms };
}

function toSwitchChat(row: ChatRow): SwitchChat {
  return {
    id: row.id as ChatId,
    identity: {
      replyJid: row.reply_jid as Jid,
      lidJid: row.lid_jid as Jid | null,
      pnJid: row.pn_jid as Jid | null,
    },
    status: oneOf(CHAT_STATUSES, row.status, 'В chats неизвестный статус чата'),
    lastMessageAtMs: row.last_message_at_ms,
  };
}
