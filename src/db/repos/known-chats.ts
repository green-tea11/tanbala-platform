import type Database from 'better-sqlite3';
import type { KnownChatSource, KnownChatsRepo } from '../../domain/ports.js';
import type { Jid } from '../../domain/types.js';
import { assertTimeMs } from '../time.js';

/**
 * Известные чаты рабочего номера в SQLite (таблица known_chats): JID, время последней активности и её источник.
 * Без текста и имён (правило этапа 8 из CLAUDE.md). Только подготовленные запросы.
 */
export function createKnownChatsRepo(db: Database.Database): KnownChatsRepo {
  const upsert = db.prepare<{ jid: Jid; atMs: number; source: KnownChatSource }>(
    `INSERT INTO known_chats (jid, last_activity_ms, source) VALUES (@jid, @atMs, @source)
     ON CONFLICT (jid) DO UPDATE SET
       last_activity_ms = excluded.last_activity_ms,
       source = excluded.source
     WHERE excluded.last_activity_ms > known_chats.last_activity_ms`,
  );
  const countAll = db.prepare<[], number>('SELECT count(*) FROM known_chats').pluck();
  return {
    touch(jid: Jid, atMs: number, source: KnownChatSource): void {
      assertTimeMs(atMs, 'atMs');
      upsert.run({ jid, atMs, source });
    },
    count(): number {
      return countAll.get() ?? 0;
    },
  };
}
