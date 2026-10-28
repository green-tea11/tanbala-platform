import type Database from 'better-sqlite3';
import type { ChatIdentity, InterestLevel } from '../../domain/types.js';
import { LEVELS, oneOf } from '../values.js';

/** Колонки чата без id: их пишет upsertByIdentity. */
export interface ChatColumns {
  readonly reply_jid: string;
  readonly lid_jid: string | null;
  readonly pn_jid: string | null;
  readonly phone: string | null;
  readonly push_name: string | null;
  readonly status: string;
  readonly status_by: string | null;
  readonly status_changed_at: number | null;
  readonly interest_level: string;
  readonly last_inbound_at: number | null;
  readonly created_at: number;
}

/** Строка таблицы chats. */
export interface ChatRow extends ChatColumns {
  readonly id: number;
}

/** Старший (остаётся) и младший (сливается) чаты. */
interface ChatPair {
  readonly survivor: number;
  readonly absorbed: number;
}

/** Номер из адреса с номером: цифры до «@» без суффикса устройства «:N». В адресе @lid номера нет. */
const PN_JID = /^(\d+)(?::\d+)?@(?:s\.whatsapp\.net|hosted)$/;

/** Поля выжимки в client_profiles, порядок как в ClientProfile. */
const PROFILE_FIELDS = [
  'business',
  'area',
  'scope',
  'item_count',
  'has_1c',
  'problem',
  'specifics',
] as const;

/**
 * Слияние выжимок. Берётся более свежая оценка, а поля, которых в ней нет (NULL), из другой; при равном времени
 * побеждает оставшийся чат. reason идёт от более свежей оценки, updated_at_ms остаётся самым поздним. Запрос
 * собирается из списка полей один раз при загрузке модуля, значения в него попадают только параметрами.
 */
function mergeProfileSql(): string {
  const newer = 'excluded.updated_at_ms > client_profiles.updated_at_ms';
  const columns = PROFILE_FIELDS.join(', ');
  const fields = PROFILE_FIELDS.map(
    (field) => `${field} = CASE WHEN ${newer}
        THEN coalesce(excluded.${field}, client_profiles.${field})
        ELSE coalesce(client_profiles.${field}, excluded.${field}) END`,
  );
  return `INSERT INTO client_profiles (chat_id, ${columns}, reason, updated_at_ms)
    SELECT @survivor, ${columns}, reason, updated_at_ms FROM client_profiles WHERE chat_id = @absorbed
    ON CONFLICT (chat_id) DO UPDATE SET
      ${fields.join(',\n      ')},
      reason = CASE WHEN ${newer} THEN excluded.reason ELSE client_profiles.reason END,
      updated_at_ms = max(client_profiles.updated_at_ms, excluded.updated_at_ms)`;
}

/**
 * Две открытые передачи не уживутся (частичный уникальный индекс): остаётся ранняя по времени открытия (при равном
 * времени записанная раньше), остальные закрываются временем слияния, но не раньше открытия.
 */
const CLOSE_DUPLICATE_HANDOFF = `UPDATE handoffs SET resolved_at_ms = max(@nowMs, opened_at_ms)
  WHERE resolved_at_ms IS NULL AND chat_id IN (@survivor, @absorbed)
    AND id <> (SELECT id FROM handoffs WHERE resolved_at_ms IS NULL AND chat_id IN (@survivor, @absorbed)
               ORDER BY opened_at_ms, id LIMIT 1)`;

/**
 * Отметка простоя: более позднее время; чат ждёт уведомления, если ждала хоть одна из отметок.
 */
const MERGE_BACKLOG = `INSERT INTO backlog_chats (chat_id, marked_at_ms, notified_at_ms)
  SELECT @survivor, marked_at_ms, notified_at_ms FROM backlog_chats WHERE chat_id = @absorbed
  ON CONFLICT (chat_id) DO UPDATE SET
    marked_at_ms = max(backlog_chats.marked_at_ms, excluded.marked_at_ms),
    notified_at_ms = CASE
      WHEN backlog_chats.notified_at_ms IS NULL OR excluded.notified_at_ms IS NULL THEN NULL
      ELSE max(backlog_chats.notified_at_ms, excluded.notified_at_ms)
    END`;

/** Дневные счётчики вызовов API складываются по дням: лимит чата учитывает вызовы обоих адресов. */
const MERGE_USAGE = `INSERT INTO api_usage (day, chat_id, count)
  SELECT day, @survivor, count FROM api_usage WHERE chat_id = @absorbed
  ON CONFLICT (day, chat_id) DO UPDATE SET count = api_usage.count + excluded.count`;

/**
 * Состояние определения компании: остаётся запись с более поздним временем записи (в ней последний ответ клиента,
 * например подтверждённая компания), при равном времени запись оставшегося чата. Сначала удаляется более старая
 * запись оставшегося чата, затем запись слитого переходит к нему (OR IGNORE: если своя запись осталась, конфликт по
 * первичному ключу chat_id пропускает перенос, а запись слитого удаляется ниже). ID чата в самом JSON нет, поэтому
 * после переноса запись читается уже как запись оставшегося чата.
 */
const DROP_OLDER_COMPANY_STATE = `DELETE FROM chat_companies WHERE chat_id = @survivor
  AND updated_at < (SELECT updated_at FROM chat_companies WHERE chat_id = @absorbed)`;

const MOVE_COMPANY_STATE =
  'UPDATE OR IGNORE chat_companies SET chat_id = @survivor WHERE chat_id = @absorbed';

/**
 * Что делать с каждой таблицей, где есть слитый чат, по порядку: слить или перенести строки, затем удалить остаток.
 * Сообщение с тем же wa_id уже есть в оставшемся чате: строка остаётся на месте и удаляется ниже (OR IGNORE).
 */
const ABSORB_STEPS: readonly string[] = [
  MERGE_BACKLOG,
  'DELETE FROM backlog_chats WHERE chat_id = @absorbed',
  'UPDATE outbound_ids SET chat_id = @survivor WHERE chat_id = @absorbed',
  MERGE_USAGE,
  'DELETE FROM api_usage WHERE chat_id = @absorbed',
  mergeProfileSql(),
  'DELETE FROM client_profiles WHERE chat_id = @absorbed',
  CLOSE_DUPLICATE_HANDOFF,
  'UPDATE handoffs SET chat_id = @survivor WHERE chat_id = @absorbed',
  'UPDATE manager_notifications SET chat_id = @survivor WHERE chat_id = @absorbed',
  DROP_OLDER_COMPANY_STATE,
  MOVE_COMPANY_STATE,
  'DELETE FROM chat_companies WHERE chat_id = @absorbed',
  'UPDATE OR IGNORE messages SET chat_id = @survivor WHERE chat_id = @absorbed',
  'DELETE FROM messages WHERE chat_id = @absorbed',
  'DELETE FROM chats WHERE id = @absorbed',
];

/**
 * Готовит слияние чатов: возвращает функцию, которая переносит в оставшийся чат отметку простоя, исходящие, счётчики
 * вызовов API, выжимку, передачи, уведомления менеджеру, состояние определения компании и историю слитого чата и
 * удаляет его строку. Вызывается внутри транзакции upsertByIdentity: иначе внешний ключ не даст удалить чат, а перенос
 * остался бы неполным. nowMs нужен, чтобы закрыть лишнюю открытую передачу.
 */
export function createChatAbsorber(
  db: Database.Database,
): (survivor: number, absorbed: number, nowMs: number) => void {
  const steps = ABSORB_STEPS.map((sql) => db.prepare<ChatPair & { readonly nowMs: number }>(sql));
  return (survivor, absorbed, nowMs) => {
    for (const step of steps) step.run({ survivor, absorbed, nowMs });
  };
}

/**
 * Колонки чата после записи. rows: найденные по адресам строки, старшая первой; пусто => новый чат.
 * Статус менеджера важнее статуса бота: иначе после слияния бот ответил бы поверх человека.
 */
export function mergeColumns(
  rows: readonly ChatRow[],
  identity: ChatIdentity,
  pushName: string | null,
  nowMs: number,
): ChatColumns {
  const pnJid = identity.pnJid ?? firstKnown(rows.map((row) => row.pn_jid));
  const control = rows.find((row) => row.status === 'manager') ?? rows[0];
  return {
    reply_jid: identity.replyJid,
    lid_jid: identity.lidJid ?? firstKnown(rows.map((row) => row.lid_jid)),
    pn_jid: pnJid,
    phone: pnJid === null ? null : (PN_JID.exec(pnJid)?.[1] ?? null),
    push_name: pushName ?? firstKnown(rows.map((row) => row.push_name)),
    status: control?.status ?? 'bot',
    status_by: control?.status_by ?? null,
    status_changed_at: control?.status_changed_at ?? null,
    interest_level: hottestLevel(rows),
    last_inbound_at: Math.max(nowMs, ...rows.map((row) => row.last_inbound_at ?? 0)),
    created_at: rows.length === 0 ? nowMs : Math.min(...rows.map((row) => row.created_at)),
  };
}

function firstKnown(values: readonly (string | null)[]): string | null {
  return values.find((value) => value !== null) ?? null;
}

/** Уровни интереса от холодного к горячему: при слиянии остаётся самый горячий. */
function hottestLevel(rows: readonly ChatRow[]): InterestLevel {
  return rows.reduce<InterestLevel>((hottest, row) => {
    const level = oneOf(LEVELS, row.interest_level, 'В chats неизвестный уровень интереса');
    return LEVELS.indexOf(level) > LEVELS.indexOf(hottest) ? level : hottest;
  }, 'cold');
}
