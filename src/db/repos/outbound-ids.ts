import type Database from 'better-sqlite3';
import type { OutboundIdsRepo } from '../../domain/ports.js';
import { notImplemented } from '../../shared/todo.js';

/**
 * ID исходящих сообщений в SQLite (раздел плана «Технические правила», «Свои сообщения»).
 * TODO(этап 3): register вызывается ДО отправки со статусом pending; setResult ставит 'sent' или 'failed'.
 * TODO(этап 3): find отдаёт jid, origin и текст: по ID отличают эхо бота от человека; текст нужен getMessage в Baileys, и отдаётся он только при совпадении jid.
 * TODO(этап 3): только подготовленные запросы.
 */
export function createOutboundIdsRepo(db: Database.Database): OutboundIdsRepo {
  return notImplemented('этап 3', 'db/repos/outbound-ids.createOutboundIdsRepo');
}
