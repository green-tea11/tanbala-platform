import type Database from 'better-sqlite3';
import type { MessagesRepo } from '../../domain/ports.js';
import type {
  Author,
  ChatId,
  MessageKind,
  NewMessage,
  StoredMessage,
  UnansweredInbound,
  WaMessageId,
} from '../../domain/types.js';
import { assertTimeMs } from '../time.js';
import { assertCount, oneOf } from '../values.js';

/** Строка страницы переписки: имена колонок уже как в StoredMessage. */
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

/** Неотвеченное входящее: имена колонок уже как в UnansweredInbound. */
interface UnansweredRow {
  readonly waId: string;
  readonly kind: string;
  readonly text: string | null;
  readonly tsMs: number;
}

/** Параметры страницы переписки: beforeId null значит «с самых свежих». */
interface PageQuery {
  readonly chatId: ChatId;
  readonly limit: number;
  readonly beforeId: number | null;
}

const AUTHORS: readonly Author[] = ['client', 'bot', 'human_phone', 'human_panel'];
const KINDS: readonly MessageKind[] = ['text', 'voice', 'other'];

/**
 * История сообщений в SQLite. Только подготовленные запросы.
 * insertIfNew опирается на UNIQUE(chat_id, wa_id): дубль => false. ON CONFLICT, а не INSERT OR IGNORE:
 * тот молча проглотил бы и нарушение CHECK или NOT NULL.
 * recent и history читают одним запросом: до limit сообщений чата по времени сообщения (при равном времени по порядку
 * записи), старые первыми: так их ждут промпт и панель. history с beforeId отдаёт только сообщения строго раньше
 * сообщения beforeId в том же порядке (время, затем порядок записи), поэтому «показать раньше» листает без пропусков
 * и повторов, даже если сообщение с меньшим временем записано позже. beforeId чужого чата или неизвестный => пусто.
 * Ответ бота уходит только на неотвеченное входящее: isUnansweredInbound true, только если
 * waId в этом чате принадлежит входящему клиента без отметки answered. markAnswered отмечает входящие клиента чата,
 * записанные не позже upToWaId (по порядку записи: сообщения, пришедшие после пачки, ждут своего ответа);
 * неизвестный upToWaId ничего не отмечает. setTranscript пишет расшифровку только в голосовое без текста
 * (вид остаётся voice): уже записанный текст не перезаписывается.
 * unansweredAfterLastOutbound: входящие клиента без отметки answered, записанные после последнего сообщения не клиента
 * (по времени, при равном времени по порядку записи) и не раньше sinceMs; по времени.
 */
export function createMessagesRepo(db: Database.Database): MessagesRepo {
  const statements = prepareStatements(db);
  const page = (query: PageQuery): readonly StoredMessage[] => {
    assertCount(query.limit, 'limit');
    return statements.selectPage.all(query).map(toStoredMessage);
  };
  return {
    insertIfNew(message: NewMessage): boolean {
      assertTimeMs(message.tsMs, 'tsMs');
      return statements.insert.run(message).changes === 1;
    },
    recent(chatId: ChatId, limit: number): readonly StoredMessage[] {
      return page({ chatId, limit, beforeId: null });
    },
    isUnansweredInbound(chatId: ChatId, waId: WaMessageId): boolean {
      return statements.selectUnanswered.get({ chatId, waId }) !== undefined;
    },
    markAnswered(chatId: ChatId, upToWaId: WaMessageId): void {
      statements.updateAnswered.run({ chatId, waId: upToWaId });
    },
    setTranscript(chatId: ChatId, waId: WaMessageId, text: string): boolean {
      return statements.updateTranscript.run({ chatId, waId, text }).changes === 1;
    },
    unansweredAfterLastOutbound(chatId: ChatId, sinceMs: number): readonly UnansweredInbound[] {
      assertTimeMs(sinceMs, 'sinceMs');
      return statements.selectUnansweredTail.all({ chatId, sinceMs }).map(toUnanswered);
    },
    history(
      chatId: ChatId,
      query: { readonly limit: number; readonly beforeId?: number },
    ): readonly StoredMessage[] {
      const beforeId = query.beforeId ?? null;
      if (beforeId !== null) assertMessageId(beforeId);
      return page({ chatId, limit: query.limit, beforeId });
    },
  };
}

function prepareStatements(db: Database.Database) {
  return {
    insert: db.prepare<NewMessage>(
      `INSERT INTO messages (chat_id, wa_id, author, kind, text, ts_ms)
       VALUES (@chatId, @waId, @author, @kind, @text, @tsMs)
       ON CONFLICT (chat_id, wa_id) DO NOTHING`,
    ),
    selectPage: db.prepare<PageQuery, MessageRow>(
      `SELECT id, chatId, author, kind, text, tsMs FROM (
         SELECT id, chat_id AS chatId, author, kind, text, ts_ms AS tsMs FROM messages
         WHERE chat_id = @chatId
           AND (@beforeId IS NULL
             OR (ts_ms, id) < (SELECT ts_ms, id FROM messages WHERE chat_id = @chatId AND id = @beforeId))
         ORDER BY ts_ms DESC, id DESC LIMIT @limit
       ) ORDER BY tsMs, id`,
    ),
    selectUnanswered: db
      .prepare<MessageKey, number>(
        `SELECT 1 FROM messages
         WHERE chat_id = @chatId AND wa_id = @waId AND author = 'client' AND answered = 0`,
      )
      .pluck(),
    updateAnswered: db.prepare<MessageKey>(
      `UPDATE messages SET answered = 1
       WHERE chat_id = @chatId AND author = 'client' AND answered = 0
         AND id <= (SELECT id FROM messages WHERE chat_id = @chatId AND wa_id = @waId)`,
    ),
    selectUnansweredTail: db.prepare<{ chatId: ChatId; sinceMs: number }, UnansweredRow>(
      `WITH last_out AS (
         SELECT ts_ms, id FROM messages
         WHERE chat_id = @chatId AND author <> 'client'
         ORDER BY ts_ms DESC, id DESC LIMIT 1
       )
       SELECT m.wa_id AS waId, m.kind, m.text, m.ts_ms AS tsMs FROM messages AS m
       WHERE m.chat_id = @chatId AND m.author = 'client' AND m.answered = 0 AND m.ts_ms >= @sinceMs
         AND NOT EXISTS (SELECT 1 FROM last_out AS o WHERE (m.ts_ms, m.id) <= (o.ts_ms, o.id))
       ORDER BY m.ts_ms, m.id`,
    ),
    updateTranscript: db.prepare<Transcript>(
      `UPDATE messages SET text = @text
       WHERE chat_id = @chatId AND wa_id = @waId AND kind = 'voice' AND text IS NULL`,
    ),
  };
}

/** ID сообщения в базе начинаются с единицы: ноль, дробь и NaN в курсоре значат ошибку вызывающего. */
function assertMessageId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('beforeId: ожидается ID сообщения, целое число больше нуля');
  }
}

function toUnanswered(row: UnansweredRow): UnansweredInbound {
  return {
    waId: row.waId as WaMessageId,
    kind: oneOf(KINDS, row.kind, 'В messages неизвестный вид сообщения'),
    text: row.text,
    tsMs: row.tsMs,
  };
}

function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    chatId: row.chatId as ChatId,
    author: oneOf(AUTHORS, row.author, 'В messages неизвестный автор сообщения'),
    kind: oneOf(KINDS, row.kind, 'В messages неизвестный вид сообщения'),
    text: row.text,
    tsMs: row.tsMs,
  };
}
