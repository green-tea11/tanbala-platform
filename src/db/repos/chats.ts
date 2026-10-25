import type Database from 'better-sqlite3';
import type { ChatsRepo } from '../../domain/ports.js';
import { notImplemented } from '../../shared/todo.js';

/**
 * Чаты и выжимки клиентов в SQLite. Здесь числовой id из базы приводится к ChatId.
 * TODO(этап 2): только подготовленные запросы с параметрами; сортировку для панели брать из белого списка колонок.
 * TODO(этап 2): upsertByIdentity сливает чат, когда для @lid стал известен номер (и наоборот), и обновляет push_name.
 * TODO(этап 3): findByJid ищет по reply_jid, lid_jid и pn_jid и не создаёт чат; setStatus хранит StatusChange (статус, кто, когда); Chat.control собирается из статуса и status_by (status_by пуст => { status: 'bot', by: null }).
 * TODO(этап 4): saveAssessment обновляет уровень интереса и client_profiles в одной транзакции.
 * TODO(этап 6): listForPanel с пагинацией (limit, offset).
 */
export function createChatsRepo(db: Database.Database): ChatsRepo {
  return notImplemented('этап 2', 'db/repos/chats.createChatsRepo');
}
