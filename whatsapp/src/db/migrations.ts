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
 * Версия 3 (этап 4). client_profiles: выжимка о клиенте 1:1 с чатом (первичный ключ chat_id). Поля ClientProfile
 * только со слов клиента, NULL значит «не выяснили»; has_1c: 1 есть 1С, 0 нет, NULL не выяснили. reason: почему модель
 * выбрала уровень интереса, updated_at_ms: время последней оценки. Строки нет, пока клиента не оценивали.
 */
const SCHEMA_V3 = `
CREATE TABLE client_profiles (
  chat_id INTEGER PRIMARY KEY REFERENCES chats (id),
  business TEXT,
  area TEXT,
  scope TEXT,
  item_count TEXT,
  has_1c INTEGER CHECK (has_1c IN (0, 1)),
  problem TEXT,
  specifics TEXT,
  reason TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
`;

/**
 * Версия 4 (этап 5).
 * handoffs: передачи чатов менеджеру. reason и level закреплены CHECK; snapshot: снимок выжимки на момент передачи;
 * resolved_at_ms NULL, пока передача открыта; закрытие не раньше открытия. Частичный уникальный индекс: на чат не
 * больше одной открытой передачи, закрытых сколько угодно (история). Индекс по chat_id нужен слиянию чатов и внешнему ключу.
 * manager_notifications: уведомления менеджеру, текст целиком, пишутся ДО отправки со статусом pending.
 * status: sent доставлено, no_manager номер менеджера не задан, skipped_limit исчерпана часовая квота (оба только в
 * панели), failed сбой отправки (будет повтор). wa_id: ID отправленного сообщения; attempts: сколько раз пробовали.
 * chat_id пуст только у списка чатов простоя (backlog), остальные уведомления относятся к чату клиента.
 * Индексы: по чату (последнее уведомление в карточке клиента), по времени (список в панели без сортировки всей
 * таблицы) и повторов; последний частичный (только pending и failed): растущая история отправленных ему не мешает.
 */
const SCHEMA_V4 = `
CREATE TABLE handoffs (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats (id),
  reason TEXT NOT NULL CHECK (reason IN (
    'hot', 'no_answer', 'check_failed', 'asked_human', 'complaint', 'human_took_over', 'llm_error', 'limit'
  )),
  level TEXT NOT NULL CHECK (level IN ('cold', 'warm', 'hot')),
  snapshot TEXT NOT NULL,
  opened_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  CHECK (resolved_at_ms IS NULL OR resolved_at_ms >= opened_at_ms)
) STRICT;

CREATE INDEX handoffs_chat ON handoffs (chat_id);
CREATE UNIQUE INDEX handoffs_one_open_per_chat ON handoffs (chat_id) WHERE resolved_at_ms IS NULL;

CREATE TABLE manager_notifications (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('handoff', 'limit', 'backlog')),
  chat_id INTEGER REFERENCES chats (id),
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'no_manager', 'skipped_limit', 'failed')),
  wa_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK ((chat_id IS NULL) = (kind = 'backlog'))
) STRICT;

CREATE INDEX manager_notifications_chat ON manager_notifications (chat_id, created_at_ms);
CREATE INDEX manager_notifications_created ON manager_notifications (created_at_ms);
CREATE INDEX manager_notifications_retry ON manager_notifications (created_at_ms)
  WHERE status IN ('pending', 'failed');
`;

/**
 * Версия 5 (этап 6). Индекс сообщений по чату и времени: панель берёт время последнего сообщения каждого чата и
 * страницы переписки по времени без просмотра всех сообщений чата (UNIQUE по chat_id и wa_id время не покрывает).
 */
const SCHEMA_V5 = `
CREATE INDEX messages_chat_ts ON messages (chat_id, ts_ms);
`;

/**
 * Версия 6 (определение компании клиента). chat_companies: состояние определения компании, одна строка на чат.
 * state: JSON без ID чата (его хранит chat_id, поэтому при слиянии чатов строка просто переходит к другому чату);
 * форму JSON при чтении проверяет репозиторий (db/repos/chat-companies.ts), а не база. updated_at: время последней
 * записи, мс UTC. Удаление чата удаляет и его состояние (ON DELETE CASCADE).
 */
const SCHEMA_V6 = `
CREATE TABLE chat_companies (
  chat_id INTEGER PRIMARY KEY REFERENCES chats (id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`;

/**
 * Версия 7 (минимум для передачи по цене, решение владельца 29.10.2026). client_profiles: one_c_name (какая 1С, если
 * клиент назвал) и problem_agreed (клиент согласился, что трудность есть, или рассказал о задаче: 1 да, 0 ещё нет).
 * chats: price_asks (сколько раз клиент спрашивал цену в ходах, на которые бот ответил, с последнего возврата чата боту)
 * и refused_answers (отказывался отвечать на вопросы: 1 да). Только ADD COLUMN со значениями по умолчанию: живая база
 * версии 6 переходит без переписывания строк, CHECK проверяется и на старых строках.
 */
const SCHEMA_V7 = `
ALTER TABLE client_profiles ADD COLUMN one_c_name TEXT;
ALTER TABLE client_profiles ADD COLUMN problem_agreed INTEGER NOT NULL DEFAULT 0
  CHECK (problem_agreed IN (0, 1));
ALTER TABLE chats ADD COLUMN price_asks INTEGER NOT NULL DEFAULT 0 CHECK (price_asks >= 0);
ALTER TABLE chats ADD COLUMN refused_answers INTEGER NOT NULL DEFAULT 0
  CHECK (refused_answers IN (0, 1));
`;

/**
 * Версия 8 (заметка для бота при возврате чата, решение владельца 29.10.2026). chats.bot_note: текст менеджера из
 * панели, клиенту не виден, действует до следующей передачи; bot_note_at_ms: когда заметку оставили. Текст и время
 * есть или нет вместе (CHECK проверяется и на старых строках, у них оба NULL).
 */
const SCHEMA_V8 = `
ALTER TABLE chats ADD COLUMN bot_note TEXT;
ALTER TABLE chats ADD COLUMN bot_note_at_ms INTEGER
  CHECK ((bot_note IS NULL) = (bot_note_at_ms IS NULL));
`;

/**
 * Версия 9 (этап 8, переход в рабочий режим). known_chats.held_for_manager: 1, если правило перехода
 * (pipeline/working-mode.ts) отдало этот адрес менеджеру: чат, который впервые появится в базе с таким адресом,
 * начинает со статусом manager. Отметки ставит каждый переход TEST_MODE true => false, по умолчанию 0. Только
 * ADD COLUMN со значением по умолчанию: живая база версии 8 переходит без переписывания строк.
 */
const SCHEMA_V9 = `
ALTER TABLE known_chats ADD COLUMN held_for_manager INTEGER NOT NULL DEFAULT 0
  CHECK (held_for_manager IN (0, 1));
`;

/**
 * Версия 10 (пункт 7 задания 29.10.2026). rejected_drafts: отклонённые черновики ответа и замечания проверок для панели.
 * attempt: попытка 1 или 2; source: code (проверки кодом) или review (второй вызов); remarks: JSON-массив строк. Срок
 * хранения 30 дней (pipeline/services.ts); индекс по времени для чистки, по чату и времени для карточки. Новая таблица:
 * живая база версии 8 или 9 переходит без переписывания строк.
 */
const SCHEMA_V10 = `
CREATE TABLE rejected_drafts (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt IN (1, 2)),
  source TEXT NOT NULL CHECK (source IN ('code', 'review')),
  draft TEXT NOT NULL,
  remarks TEXT NOT NULL,
  at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX rejected_drafts_chat ON rejected_drafts (chat_id, at_ms);
CREATE INDEX rejected_drafts_at ON rejected_drafts (at_ms);
`;

/**
 * Версия 11 (пункт 5 задания 29.10.2026, шире квалификация). client_profiles: какие вещи (items), в чём (packaging),
 * материал (material), город (city), тип помещения (premises), как часто движутся (turnover), как учитывают сейчас
 * (current_tracking). Только ADD COLUMN без значения по умолчанию: старые строки получают NULL («не выяснили»).
 */
const SCHEMA_V11 = `
ALTER TABLE client_profiles ADD COLUMN items TEXT;
ALTER TABLE client_profiles ADD COLUMN packaging TEXT;
ALTER TABLE client_profiles ADD COLUMN material TEXT;
ALTER TABLE client_profiles ADD COLUMN city TEXT;
ALTER TABLE client_profiles ADD COLUMN premises TEXT;
ALTER TABLE client_profiles ADD COLUMN turnover TEXT;
ALTER TABLE client_profiles ADD COLUMN current_tracking TEXT;
`;

/**
 * Версия 12 (пункт 4 задания 29.10.2026, выводы с пометкой). client_profiles.inferred: JSON-массив полей выжимки,
 * значение которых выведено из слов клиента («вероятно»). Старые строки получают '[]': всё сказано прямо.
 */
const SCHEMA_V12 = `
ALTER TABLE client_profiles ADD COLUMN inferred TEXT NOT NULL DEFAULT '[]';
`;

/**
 * Версия 13 (поля для расчёта, решение владельца 30.10.2026). client_profiles: сколько нового товара приходит в месяц
 * (monthly_intake), сколько проходов учитывать (passages), нужен ли пересчёт полок ручным сканером (shelf_recount).
 * Только ADD COLUMN без значения по умолчанию: старые строки получают NULL («не выяснили»).
 */
const SCHEMA_V13 = `
ALTER TABLE client_profiles ADD COLUMN monthly_intake TEXT;
ALTER TABLE client_profiles ADD COLUMN passages TEXT;
ALTER TABLE client_profiles ADD COLUMN shelf_recount TEXT;
`;

/**
 * Миграции по порядку: элемент i переводит схему с версии i на i + 1.
 * Выпущенную миграцию не править: изменения схемы только новой версией в конце списка.
 */
const MIGRATIONS: readonly string[] = [
  SCHEMA_V1,
  SCHEMA_V2,
  SCHEMA_V3,
  SCHEMA_V4,
  SCHEMA_V5,
  SCHEMA_V6,
  SCHEMA_V7,
  SCHEMA_V8,
  SCHEMA_V9,
  SCHEMA_V10,
  SCHEMA_V11,
  SCHEMA_V12,
  SCHEMA_V13,
];

/**
 * Применяет миграции схемы по номеру версии в PRAGMA user_version: идемпотентно, все недостающие версии
 * одной транзакцией (сбой откатывает и таблицы, и номер версии). Схема новее кода => явная ошибка.
 * targetVersion: до какой версии поднимать (по умолчанию до последней); нужен тестам перехода со старой схемы.
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
