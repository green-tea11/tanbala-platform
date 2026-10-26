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
 * Версия 2 (этап 3). messages.answered: входящее клиента отвечено (1) или ждёт ответа (0); старая переписка этапа 2
 * остаётся неотвеченной: бот на неё не отвечал.
 * outbound_ids: исходящие с номера бота, запись создаётся ДО отправки (pending), затем sent или failed. По wa_id своё
 * эхо отличают от человека с телефона, text нужен Baileys для повторной отправки (getMessage). chat_id: чат клиента;
 * у уведомления менеджеру его нет, у остальных он обязателен.
 * api_usage: вызовы API (Anthropic и OpenRouter) за сутки по Алматы (day ГГГГ-ММ-ДД): chat_id 0 общий счётчик бота,
 * иначе ID чата (без внешнего ключа: строка 0 не чат); дневной предохранитель db/repos/call-budget.ts.
 */
const SCHEMA_V2 = `
ALTER TABLE messages ADD COLUMN answered INTEGER NOT NULL DEFAULT 0 CHECK (answered IN (0, 1));

CREATE TABLE outbound_ids (
  wa_id TEXT PRIMARY KEY NOT NULL,
  chat_id INTEGER REFERENCES chats (id),
  jid TEXT NOT NULL,
  origin TEXT NOT NULL
    CHECK (origin IN ('bot_reply', 'handoff_notice', 'voice_notice', 'manager_notify', 'panel')),
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  created_at INTEGER NOT NULL,
  CHECK ((chat_id IS NULL) = (origin = 'manager_notify'))
) STRICT;

CREATE INDEX outbound_ids_chat ON outbound_ids (chat_id);

CREATE TABLE api_usage (
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  chat_id INTEGER NOT NULL CHECK (chat_id >= 0),
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (day, chat_id)
) STRICT;
`;

/**
 * Миграции по порядку: элемент i переводит схему с версии i на i + 1.
 * Выпущенную миграцию не править: изменения схемы только новой версией в конце списка.
 */
const MIGRATIONS: readonly string[] = [SCHEMA_V1, SCHEMA_V2];

/**
 * Применяет миграции схемы по номеру версии в PRAGMA user_version: идемпотентно, все недостающие версии
 * одной транзакцией (сбой откатывает и таблицы, и номер версии). Схема новее кода => явная ошибка.
 * targetVersion: до какой версии поднимать (по умолчанию до последней); нужен тестам перехода со старой схемы.
 * TODO(этап 4): client_profiles 1:1 с chats (бизнес, площадь, что учитывать, число вещей, есть ли 1С, задача, особенности, готовый текст выжимки).
 * TODO(этап 5): handoffs (причина, уровень, снимок выжимки, статус и ID уведомления); частичный уникальный индекс: не больше одной открытой передачи на чат.
 */
export function runMigrations(
  db: Database.Database,
  targetVersion: number = MIGRATIONS.length,
): void {
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 0) {
    throw new RangeError('targetVersion: ожидается целое число не меньше нуля');
  }
  if (targetVersion > MIGRATIONS.length) {
    throw new RangeError(`targetVersion: код знает схему только до версии ${MIGRATIONS.length}`);
  }
  db.transaction(() => {
    const current = Number(db.pragma('user_version', { simple: true }));
    if (current > MIGRATIONS.length) {
      throw new Error(
        `Схема базы новее кода: версия ${current}, код знает до ${MIGRATIONS.length}. Нужна новая версия кода`,
      );
    }
    MIGRATIONS.slice(current, targetVersion).forEach((sql, index) => {
      db.exec(sql);
      db.pragma(`user_version = ${current + index + 1}`);
    });
  }).immediate();
}
