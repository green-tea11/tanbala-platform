import type Database from 'better-sqlite3';
import type { OutboundIdsRepo, OutboundRecord } from '../../domain/ports.js';
import type { ChatId, Jid, SendOrigin, WaMessageId } from '../../domain/types.js';
import { assertTimeMs } from '../time.js';

/** Строка find: адрес, источник и текст исходящего. */
interface FoundRow {
  readonly jid: string;
  readonly origin: string;
  readonly text: string;
}

/** Колонки register. */
interface RegisterRow {
  readonly waId: WaMessageId;
  readonly chatId: ChatId | null;
  readonly jid: Jid;
  readonly origin: SendOrigin;
  readonly text: string;
  readonly createdAt: number;
}

const ORIGINS: readonly SendOrigin[] = [
  'bot_reply',
  'handoff_notice',
  'voice_notice',
  'manager_notify',
  'panel',
];

/**
 * ID исходящих сообщений в SQLite (раздел плана «Технические правила», «Свои сообщения»). Только подготовленные запросы.
 * register вызывается ДО отправки: запись со статусом pending, иначе эхо от WhatsApp придёт раньше записи и бот примет
 * себя за человека. Повтор ID => ошибка базы: ID выдаёт шлюз, совпадение значит ошибку в коде.
 * setResult ставит 'sent' или 'failed'; неизвестный ID => явная ошибка.
 * find отдаёт jid, origin и текст при любом статусе: эхо неудачной по нашим данным отправки всё равно своё.
 * Сверку jid для getMessage делает вызывающий: текст отдаётся только при совпадении чата.
 */
export function createOutboundIdsRepo(db: Database.Database): OutboundIdsRepo {
  const insert = db.prepare<RegisterRow>(
    `INSERT INTO outbound_ids (wa_id, chat_id, jid, origin, text, status, created_at)
     VALUES (@waId, @chatId, @jid, @origin, @text, 'pending', @createdAt)`,
  );
  const updateStatus = db.prepare<{ waId: WaMessageId; result: 'sent' | 'failed' }>(
    'UPDATE outbound_ids SET status = @result WHERE wa_id = @waId',
  );
  const select = db.prepare<[WaMessageId], FoundRow>(
    'SELECT jid, origin, text FROM outbound_ids WHERE wa_id = ?',
  );
  return {
    register(record: OutboundRecord): void {
      assertTimeMs(record.nowMs, 'nowMs');
      const { waId, chatId, jid, origin, text } = record;
      insert.run({ waId, chatId, jid, origin, text, createdAt: record.nowMs });
    },
    setResult(waId: WaMessageId, result: 'sent' | 'failed'): void {
      if (updateStatus.run({ waId, result }).changes === 0) {
        throw new Error('Неизвестный ID исходящего: записи в outbound_ids нет');
      }
    },
    find(waId: WaMessageId): Pick<OutboundRecord, 'jid' | 'origin' | 'text'> | null {
      const row = select.get(waId);
      return row === undefined
        ? null
        : { jid: row.jid as Jid, origin: toOrigin(row.origin), text: row.text };
    },
  };
}

function toOrigin(value: string): SendOrigin {
  const origin = ORIGINS.find((candidate) => candidate === value);
  if (origin === undefined) {
    throw new Error('В outbound_ids неизвестный источник исходящего: строка испорчена');
  }
  return origin;
}
