import type Database from 'better-sqlite3';
import type { MessagesRepo } from '../../domain/ports.js';
import type {
  Author,
  ChatId,
  MessageKind,
  NewMessage,
  StoredMessage,
  WaMessageId,
} from '../../domain/types.js';
import { assertTimeMs } from '../time.js';

/** Строка recent: имена колонок уже как в StoredMessage. */
interface MessageRow {
  readonly id: number;
  readonly chatId: number;
  readonly author: string;
  readonly kind: string;
  readonly text: string | null;
  readonly tsMs: number;
}

/** Адрес сообщения в чате. */
interface MessageKey {
  readonly chatId: ChatId;
  readonly waId: WaMessageId;
}

/** Расшифровка голосового по адресу сообщения. */
interface Transcript extends MessageKey {
  readonly text: string;
}

const AUTHORS: readonly Author[] = ['client', 'bot', 'human_phone', 'human_panel'];
const KINDS: readonly MessageKind[] = ['text', 'voice', 'other'];

/**
 * История сообщений в SQLite. Только подготовленные запросы.
 * insertIfNew опирается на UNIQUE(chat_id, wa_id): дубль => false. ON CONFLICT, а не INSERT OR IGNORE:
 * тот молча проглотил бы и нарушение CHECK или NOT NULL.
 * recent: последние limit сообщений чата по времени сообщения (при равном времени по порядку записи), старые первыми:
 * так их ждут промпт и панель. Ответ бота уходит только на неотвеченное входящее: isUnansweredInbound true, только если
 * waId в этом чате принадлежит входящему клиента без отметки answered. markAnswered отмечает входящие клиента чата,
 * записанные не позже upToWaId (по порядку записи: сообщения, пришедшие после пачки, ждут своего ответа);
 * неизвестный upToWaId ничего не отмечает. setTranscript пишет расшифровку только в голосовое без текста
 * (вид остаётся voice): уже записанный текст не перезаписывается.
 */
export function createMessagesRepo(db: Database.Database): MessagesRepo {
  const insert = db.prepare<NewMessage>(
    `INSERT INTO messages (chat_id, wa_id, author, kind, text, ts_ms)
     VALUES (@chatId, @waId, @author, @kind, @text, @tsMs)
     ON CONFLICT (chat_id, wa_id) DO NOTHING`,
  );
  const selectRecent = db.prepare<{ chatId: ChatId; limit: number }, MessageRow>(
    `SELECT id, chatId, author, kind, text, tsMs FROM (
       SELECT id, chat_id AS chatId, author, kind, text, ts_ms AS tsMs FROM messages
       WHERE chat_id = @chatId ORDER BY ts_ms DESC, id DESC LIMIT @limit
     ) ORDER BY tsMs, id`,
  );
  const selectUnanswered = db
    .prepare<MessageKey, number>(
      `SELECT 1 FROM messages
       WHERE chat_id = @chatId AND wa_id = @waId AND author = 'client' AND answered = 0`,
    )
    .pluck();
  const updateAnswered = db.prepare<MessageKey>(
    `UPDATE messages SET answered = 1
     WHERE chat_id = @chatId AND author = 'client' AND answered = 0
       AND id <= (SELECT id FROM messages WHERE chat_id = @chatId AND wa_id = @waId)`,
  );
  const updateTranscript = db.prepare<Transcript>(
    `UPDATE messages SET text = @text
     WHERE chat_id = @chatId AND wa_id = @waId AND kind = 'voice' AND text IS NULL`,
  );
  return {
    insertIfNew(message: NewMessage): boolean {
      assertTimeMs(message.tsMs, 'tsMs');
      return insert.run(message).changes === 1;
    },
    recent(chatId: ChatId, limit: number): readonly StoredMessage[] {
      if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new RangeError('limit: ожидается целое число сообщений не меньше нуля');
      }
      return selectRecent.all({ chatId, limit }).map(toStoredMessage);
    },
    isUnansweredInbound(chatId: ChatId, waId: WaMessageId): boolean {
      return selectUnanswered.get({ chatId, waId }) !== undefined;
    },
    markAnswered(chatId: ChatId, upToWaId: WaMessageId): void {
      updateAnswered.run({ chatId, waId: upToWaId });
    },
    setTranscript(chatId: ChatId, waId: WaMessageId, text: string): boolean {
      return updateTranscript.run({ chatId, waId, text }).changes === 1;
    },
  };
}

function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    chatId: row.chatId as ChatId,
    author: oneOf(AUTHORS, row.author, 'неизвестный автор'),
    kind: oneOf(KINDS, row.kind, 'неизвестный вид'),
    text: row.text,
    tsMs: row.tsMs,
  };
}

function oneOf<T extends string>(allowed: readonly T[], value: string, problem: string): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`В messages ${problem} сообщения: строка испорчена`);
  return found;
}
