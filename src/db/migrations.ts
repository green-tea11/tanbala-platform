import type Database from 'better-sqlite3';

/**
 * Версия 1 (этап 2). Таблицы STRICT: значение не того типа SQLite отклоняет сам; время INTEGER, мс UTC.
 * Перечисления закреплены CHECK. Сырые WAMessage не хранятся: по mediaKey и directPath можно расшифровать медиа.
 * chats: reply_jid (куда отвечать), lid_jid и pn_jid (другие адреса того же человека), phone (цифры из pn_jid),
 * push_name, статус bot или manager, кто и когда его сменил (status_by пуст: бот с самого начала), уровень интереса,
 * last_inbound_at (последнее входящее) и created_at.
 * messages: UNIQUE(chat_id, wa_id) против дублей при повторной доставке; у голосового text NULL до расшифровки.
 * backlog_chats: чат простоя; marked_at_ms: время последнего старого сообщения; notified_at_ms NULL, пока менеджеру
 * не сообщили. known_chats: JID и время последней активности чатов рабочего номера, без текста (правило этапа 8).
 */
const SCHEMA_V1 = `
CREATE TABLE app_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE pairing_attempts (
  id INTEGER PRIMARY KEY,
  at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE chats (
  id INTEGER PRIMARY KEY,
  reply_jid TEXT NOT NULL UNIQUE,
  lid_jid TEXT UNIQUE,
  pn_jid TEXT UNIQUE,
  phone TEXT,
  push_name TEXT,
  status TEXT NOT NULL DEFAULT 'bot' CHECK (status IN ('bot', 'manager')),
  status_by TEXT CHECK (status_by IN ('bot', 'phone', 'panel')),
  status_changed_at INTEGER,
  interest_level TEXT NOT NULL DEFAULT 'cold' CHECK (interest_level IN ('cold', 'warm', 'hot')),
  last_inbound_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK (
    (status = 'bot' AND (status_by IS NULL OR status_by = 'panel'))
    OR (status = 'manager' AND status_by IS NOT NULL)
  ),
  CHECK ((status_by IS NULL) = (status_changed_at IS NULL))
) STRICT;

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats (id),
  wa_id TEXT NOT NULL,
  author TEXT NOT NULL CHECK (author IN ('client', 'bot', 'human_phone', 'human_panel')),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'voice', 'other')),
  text TEXT,
  ts_ms INTEGER NOT NULL,
  UNIQUE (chat_id, wa_id)
) STRICT;

CREATE TABLE backlog_chats (
  chat_id INTEGER PRIMARY KEY REFERENCES chats (id),
  marked_at_ms INTEGER NOT NULL,
  notified_at_ms INTEGER
) STRICT;

CREATE TABLE known_chats (
  jid TEXT PRIMARY KEY NOT NULL,
  last_activity_ms INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('history', 'message'))
) STRICT;
`;

/**
 * Миграции по порядку: элемент i переводит схему с версии i на i + 1.
 * Выпущенную миграцию не править: изменения схемы только новой версией в конце списка.
 */
const MIGRATIONS: readonly string[] = [SCHEMA_V1];

/**
 * Применяет миграции схемы по номеру версии в PRAGMA user_version: идемпотентно, все недостающие версии
 * одной транзакцией (сбой откатывает и таблицы, и номер версии). Схема новее кода => явная ошибка.
 * TODO(этап 4): client_profiles 1:1 с chats (бизнес, площадь, что учитывать, число вещей, есть ли 1С, задача, особенности, готовый текст выжимки).
 * TODO(этап 3): outbound_ids (wa_id, jid, origin bot_reply, handoff_notice, voice_notice, manager_notify или panel, текст для getMessage, статус pending, sent или failed); запись создаётся ДО отправки.
 * TODO(этап 3): счётчики вызовов API по суткам (время Алматы): общий и по чатам, для дневного предохранителя.
 * TODO(этап 5): handoffs (причина, уровень, снимок выжимки, статус и ID уведомления); частичный уникальный индекс: не больше одной открытой передачи на чат.
 */
export function runMigrations(db: Database.Database): void {
  db.transaction(() => {
    const current = Number(db.pragma('user_version', { simple: true }));
    if (current > MIGRATIONS.length) {
      throw new Error(
        `Схема базы новее кода: версия ${current}, код знает до ${MIGRATIONS.length}. Нужна новая версия кода`,
      );
    }
    MIGRATIONS.slice(current).forEach((sql, index) => {
      db.exec(sql);
      db.pragma(`user_version = ${current + index + 1}`);
    });
  }).immediate();
}
