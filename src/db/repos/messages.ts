import type Database from 'better-sqlite3';
import type { MessagesRepo } from '../../domain/ports.js';
import type { NewMessage } from '../../domain/types.js';
import { notImplemented } from '../../shared/todo.js';
import { assertTimeMs } from '../time.js';

/**
 * История сообщений в SQLite. Только подготовленные запросы.
 * insertIfNew опирается на UNIQUE(chat_id, wa_id): дубль => false. ON CONFLICT, а не INSERT OR IGNORE:
 * тот молча проглотил бы и нарушение CHECK или NOT NULL.
 * TODO(этап 3): isUnansweredInbound и markAnswered: ответ бота уходит только на неотвеченное входящее.
 * TODO(этап 3): recent отдаёт последние сообщения по времени (с видом и автором) для промпта и панели.
 */
export function createMessagesRepo(db: Database.Database): MessagesRepo {
  const insert = db.prepare<NewMessage>(
    `INSERT INTO messages (chat_id, wa_id, author, kind, text, ts_ms)
     VALUES (@chatId, @waId, @author, @kind, @text, @tsMs)
     ON CONFLICT (chat_id, wa_id) DO NOTHING`,
  );
  return {
    insertIfNew(message: NewMessage): boolean {
      assertTimeMs(message.tsMs, 'tsMs');
      return insert.run(message).changes === 1;
    },
    recent: () => notImplemented('этап 3', 'db/repos/messages.recent'),
    isUnansweredInbound: () => notImplemented('этап 3', 'db/repos/messages.isUnansweredInbound'),
    markAnswered: () => notImplemented('этап 3', 'db/repos/messages.markAnswered'),
  };
}
