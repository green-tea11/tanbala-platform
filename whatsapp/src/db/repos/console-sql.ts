// SQL выборок консоли для списка чатов и «Требует внимания» (db/repos/console-chat-list.ts). Только SELECT.
// Дорогие поля (кто ждёт ответа, последнее сообщение, передача, компания) считаются только для строк страницы, а для
// всех чатов — только когда по ним фильтруют: CASE и OR в SQLite вычисляются по порядку и не трогают лишнее.
// MATERIALIZED не даёт SQLite подставить подзапрос в каждое место, где упомянут его столбец.

/** Функция соединения: имя содержит хотя бы один вариант поиска (без регистра и невидимых символов). */
export const NAME_MATCH_FUNCTION = 'console_name_has';

/** Последний ответ клиенту в чате: человек или бот, кроме фразы о передаче (outbound_ids.origin handoff_notice). */
function lastAnswerOf(chatId: string): string {
  return `(SELECT max(m.ts_ms) FROM messages AS m WHERE m.chat_id = ${chatId}
    AND (m.author IN ('human_phone', 'human_panel')
      OR (m.author = 'bot' AND NOT EXISTS (
        SELECT 1 FROM outbound_ids AS o
        WHERE o.wa_id = m.wa_id AND o.chat_id = m.chat_id AND o.origin = 'handoff_notice'))))`;
}

/** Последнее сообщение не клиента: бот, человек с телефона или из панели. */
function lastOutOf(chatId: string): string {
  return `(SELECT max(m.ts_ms) FROM messages AS m WHERE m.chat_id = ${chatId} AND m.author <> 'client')`;
}

/** Первое сообщение клиента позже порога; порога нет (NULL) — первое сообщение клиента вообще. */
function firstClientAfter(chatId: string, threshold: string): string {
  return `(SELECT min(m.ts_ms) FROM messages AS m WHERE m.chat_id = ${chatId} AND m.author = 'client'
    AND m.ts_ms > coalesce(${threshold}, -1))`;
}

/** С какого сообщения клиент ждёт: у менеджера — после последнего ответа, у бота — после любого исходящего. */
function pendingSinceOf(chatId: string, status: string): string {
  return `CASE WHEN ${status} = 'manager' THEN ${firstClientAfter(chatId, lastAnswerOf(chatId))}
    ELSE ${firstClientAfter(chatId, lastOutOf(chatId))} END`;
}

/** «Ждёт с» из уже посчитанного столбца pending: у менеджера сразу, у бота только старше 5 минут. */
function waitingSinceOf(status: string, pending: string): string {
  return `CASE WHEN ${status} = 'manager' THEN ${pending}
    WHEN ${pending} <= @silentBeforeMs THEN ${pending} END`;
}

/**
 * Клиент ждёт ответа (для фильтра по всем чатам): каждая ветка считает свой подзапрос один раз. У бота NULL <= x даёт
 * NULL, и чат не проходит.
 */
const IS_WAITING = `CASE WHEN c.status = 'manager' THEN ${firstClientAfter('c.id', lastAnswerOf('c.id'))} IS NOT NULL
  ELSE ${firstClientAfter('c.id', lastOutOf('c.id'))} <= @silentBeforeMs END`;

/**
 * Связь с компанией по JSON записи бота: $.confirmed.id, иначе $.candidate.id. CASE, а не AND: json_type на тексте не
 * JSON бросает ошибку, а CASE вычисляется по порядку.
 */
const COMPANY_STATE = `CASE WHEN json_valid(cc.state) THEN
  CASE WHEN json_type(cc.state, '$.confirmed.id') = 'integer' THEN 'confirmed'
       WHEN json_type(cc.state, '$.candidate.id') = 'integer' THEN 'candidate' END END`;

function companyField(field: 'id' | 'name'): string {
  return `CASE WHEN json_valid(cc.state) THEN
  CASE WHEN json_type(cc.state, '$.confirmed.id') = 'integer' THEN json_extract(cc.state, '$.confirmed.${field}')
       WHEN json_type(cc.state, '$.candidate.id') = 'integer' THEN json_extract(cc.state, '$.candidate.${field}') END END`;
}

/** Условия фильтра списка по chats AS c и chat_companies AS cc: параметр NULL (или 0 у флагов) не фильтрует. */
const FILTER = `
  (@status IS NULL OR c.status = @status)
  AND (@level IS NULL OR c.interest_level = @level)
  AND (@searching = 0
    OR ${NAME_MATCH_FUNCTION}(c.push_name, @q1, @q2, @q3, @q4) = 1
    OR (@digits IS NOT NULL AND instr(coalesce(c.phone, ''), @digits) > 0))
  AND (@company IS NULL OR coalesce(${COMPANY_STATE}, 'none') = @company)
  AND (@waitingOnly = 0 OR ${IS_WAITING})`;

/**
 * Страница списка. Сортировка как у старой панели: свежее последнее сообщение сверху, затем id; чаты без сообщений в
 * конце. Сначала только id и время последнего сообщения (индекс messages_chat_ts), затем для 30 строк страницы всё
 * остальное. Открытая передача одна на чат (частичный уникальный индекс), строки не размножаются.
 */
export const LIST_CHATS = `WITH page AS MATERIALIZED (
  SELECT c.id, (SELECT max(m.ts_ms) FROM messages AS m WHERE m.chat_id = c.id) AS last_message_at_ms
  FROM chats AS c LEFT JOIN chat_companies AS cc ON cc.chat_id = c.id
  WHERE ${FILTER}
  ORDER BY last_message_at_ms DESC, c.id DESC
  LIMIT @limit OFFSET @offset
),
pending AS MATERIALIZED (
  SELECT p.id, p.last_message_at_ms, ${pendingSinceOf('p.id', 'c.status')} AS pending_since_ms
  FROM page AS p JOIN chats AS c ON c.id = p.id
)
SELECT c.id, c.push_name AS pushName, c.pn_jid AS pnJid, c.status, c.status_by AS statusBy,
  c.interest_level AS level, d.last_message_at_ms AS lastMessageAtMs,
  ${waitingSinceOf('c.status', 'd.pending_since_ms')} AS waitingSinceMs,
  ${COMPANY_STATE} AS companyState, ${companyField('id')} AS companyId, ${companyField('name')} AS companyName,
  h.reason AS handoffReason, h.level AS handoffLevel, h.opened_at_ms AS handoffOpenedAtMs,
  lm.author AS lastAuthor, lm.kind AS lastKind, lm.text AS lastText
FROM pending AS d JOIN chats AS c ON c.id = d.id
LEFT JOIN chat_companies AS cc ON cc.chat_id = c.id
LEFT JOIN handoffs AS h ON h.chat_id = c.id AND h.resolved_at_ms IS NULL
LEFT JOIN messages AS lm ON lm.id = (
  SELECT m.id FROM messages AS m WHERE m.chat_id = c.id ORDER BY m.ts_ms DESC, m.id DESC LIMIT 1)
ORDER BY d.last_message_at_ms DESC, d.id DESC`;

export const COUNT_CHATS = `SELECT count(*)
FROM chats AS c LEFT JOIN chat_companies AS cc ON cc.chat_id = c.id
WHERE ${FILTER}`;

/**
 * Чаты, где клиент писал не раньше @clientSinceMs, и с какого сообщения он ждёт ответа (waiting_since_ms NULL — не
 * ждёт). Сначала время последнего сообщения клиента (отсекает старые чаты), потом остальное только для оставшихся.
 */
const WAITING_CTE = `clients AS MATERIALIZED (
  SELECT c.id, c.status,
    (SELECT max(m.ts_ms) FROM messages AS m WHERE m.chat_id = c.id AND m.author = 'client') AS last_client_ms
  FROM chats AS c
),
pending AS MATERIALIZED (
  SELECT k.id, k.status, k.last_client_ms, ${pendingSinceOf('k.id', 'k.status')} AS pending_since_ms
  FROM clients AS k WHERE k.last_client_ms >= @clientSinceMs
),
waiting AS (
  SELECT p.id, p.status, p.last_client_ms,
    ${waitingSinceOf('p.status', 'p.pending_since_ms')} AS waiting_since_ms
  FROM pending AS p
)`;

/** Ждут ответа: дольше всех ждущие первыми; последняя передача жалоба => пометка. */
export const WAITING_CHATS = `WITH ${WAITING_CTE}
SELECT w.id AS chatId, c.push_name AS pushName, c.pn_jid AS pnJid, w.status,
  w.waiting_since_ms AS waitingSinceMs, w.last_client_ms AS lastClientAtMs,
  coalesce((SELECT h.reason FROM handoffs AS h WHERE h.chat_id = w.id
    ORDER BY h.opened_at_ms DESC, h.id DESC LIMIT 1) = 'complaint', 0) AS complaint
FROM waiting AS w JOIN chats AS c ON c.id = w.id
WHERE w.waiting_since_ms IS NOT NULL
ORDER BY w.waiting_since_ms, w.id
LIMIT @limit`;

/** Сколько ждут ответа: клиент писал не раньше @freshSinceMs (в списке) и раньше (окно отбросило). */
export const WAITING_COUNTS = `WITH ${WAITING_CTE}
SELECT count(CASE WHEN w.last_client_ms >= @freshSinceMs THEN 1 END) AS fresh,
  count(CASE WHEN w.last_client_ms < @freshSinceMs THEN 1 END) AS stale
FROM waiting AS w
WHERE w.waiting_since_ms IS NOT NULL`;

/** Число открытых передач (кроме перехвата человеком) и горячих чатов без предела списка. */
export const ATTENTION_COUNTS = `SELECT
  (SELECT count(*) FROM handoffs WHERE resolved_at_ms IS NULL AND reason <> 'human_took_over') AS handoffs,
  (SELECT count(*) FROM chats WHERE interest_level = 'hot') AS hot`;

/** Открытые передачи, кроме перехвата человеком, и первое уведомление менеджеру после открытия (handoff или limit). */
export const OPEN_HANDOFFS = `SELECT h.id, h.chat_id AS chatId, h.reason, h.level, h.opened_at_ms AS openedAtMs,
  c.push_name AS pushName, c.pn_jid AS pnJid, n.status AS notifyStatus, n.attempts AS notifyAttempts
FROM handoffs AS h JOIN chats AS c ON c.id = h.chat_id
LEFT JOIN manager_notifications AS n ON n.id = (
  SELECT n2.id FROM manager_notifications AS n2
  WHERE n2.chat_id = h.chat_id AND n2.kind IN ('handoff', 'limit') AND n2.created_at_ms >= h.opened_at_ms
  ORDER BY n2.created_at_ms, n2.id LIMIT 1)
WHERE h.resolved_at_ms IS NULL AND h.reason <> 'human_took_over'
ORDER BY h.opened_at_ms DESC, h.id DESC
LIMIT ?`;

export const HOT_CHATS = `SELECT c.id AS chatId, c.push_name AS pushName, c.pn_jid AS pnJid, c.status,
  p.reason AS levelReason, p.updated_at_ms AS levelUpdatedAtMs,
  (SELECT max(m.ts_ms) FROM messages AS m WHERE m.chat_id = c.id) AS lastMessageAtMs
FROM chats AS c LEFT JOIN client_profiles AS p ON p.chat_id = c.id
WHERE c.interest_level = 'hot'
ORDER BY lastMessageAtMs DESC, c.id DESC
LIMIT ?`;

/** Скрытые символы (управляющие, форматирующие, разделители строк и абзацев): в поиске по имени не учитываются. */
const HIDDEN_IN_NAME = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Имя или вариант поиска в одном виде: без скрытых символов, строчными (кириллица тоже). */
export function foldName(text: string): string {
  return text.replace(HIDDEN_IN_NAME, '').toLowerCase();
}
