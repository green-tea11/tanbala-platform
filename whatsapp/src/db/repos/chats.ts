import type Database from 'better-sqlite3';
import type { ChatsRepo } from '../../domain/ports.js';
import {
  PROFILE_FACTS,
  type BotNote,
  type Chat,
  type ChatControl,
  type ChatId,
  type ChatIdentity,
  type ChatProgress,
  type ChatStatus,
  type ClientProfile,
  type InterestAssessment,
  type InterestLevel,
  type Jid,
  type OpenHandoff,
  type PanelChatRow,
  type ProfileFact,
  type StatusChange,
  type TurnSignals,
} from '../../domain/types.js';
import { assertTimeMs } from '../time.js';
import { assertCount, HANDOFF_REASONS, LEVELS, oneOf } from '../values.js';
import { createChatAbsorber, mergeColumns, type ChatColumns, type ChatRow } from './chat-merge.js';

/** Колонки выжимки из client_profiles (LEFT JOIN): у чата без оценки все NULL. */
interface ProfileColumns {
  readonly business: string | null;
  readonly items: string | null;
  readonly packaging: string | null;
  readonly material: string | null;
  readonly city: string | null;
  readonly premises: string | null;
  readonly area: string | null;
  readonly scope: string | null;
  readonly item_count: string | null;
  readonly turnover: string | null;
  readonly current_tracking: string | null;
  readonly has_1c: number | null;
  readonly one_c_name: string | null;
  readonly problem: string | null;
  readonly specifics: string | null;
  /** NULL у чата без оценки (LEFT JOIN): выжимки нет, согласие не выяснено. */
  readonly problem_agreed: number | null;
  /** JSON-массив полей с пометкой «вероятно»; NULL у чата без оценки. */
  readonly inferred: string | null;
}

/** Ход разговора о цене в chats. */
interface ProgressRow {
  readonly price_asks: number;
  readonly refused_answers: number;
}

/** Заметка для бота в chats: текст и время есть или нет вместе (CHECK). */
interface NoteRow {
  readonly bot_note: string | null;
  readonly bot_note_at_ms: number | null;
}

/** Чат вместе с выжимкой: то, что читают getById, findByJid и панель. */
interface ChatWithProfileRow extends ChatRow, ProfileColumns {}

/** Строка списка панели: чат, время его последнего сообщения и открытая передача (все NULL, если её нет). */
interface PanelRow extends ChatWithProfileRow {
  readonly last_message_at_ms: number | null;
  readonly handoff_reason: string | null;
  readonly handoff_level: string | null;
  readonly handoff_opened_at_ms: number | null;
}

/** Параметры записи оценки интереса и выжимки. */
interface AssessmentParams {
  readonly chatId: ChatId;
  readonly business: string | null;
  readonly items: string | null;
  readonly packaging: string | null;
  readonly material: string | null;
  readonly city: string | null;
  readonly premises: string | null;
  readonly area: string | null;
  readonly scope: string | null;
  readonly itemCount: string | null;
  readonly turnover: string | null;
  readonly currentTracking: string | null;
  readonly has1c: 0 | 1 | null;
  readonly oneCName: string | null;
  readonly problem: string | null;
  readonly specifics: string | null;
  readonly problemAgreed: 0 | 1;
  readonly inferred: string;
  readonly reason: string;
  readonly nowMs: number;
}

/** Запрос списка панели (ChatsRepo.listForPanel). */
interface PanelQuery {
  readonly status?: ChatStatus;
  readonly limit: number;
  readonly offset: number;
}

const CHAT_STATUSES: readonly ChatStatus[] = ['bot', 'manager'];

/** Кто может передать чат менеджеру (StatusChange со статусом manager). */
const MANAGER_AUTHORS = ['bot', 'phone', 'panel'] as const;

const CHAT_COLUMNS = `c.id, c.reply_jid, c.lid_jid, c.pn_jid, c.phone, c.push_name, c.status,
    c.status_by, c.status_changed_at, c.interest_level, c.last_inbound_at, c.created_at,
    p.business, p.items, p.packaging, p.material, p.city, p.premises, p.area, p.scope, p.item_count,
    p.turnover, p.current_tracking, p.has_1c, p.one_c_name, p.problem, p.specifics, p.problem_agreed,
    p.inferred`;

const FROM_CHAT = 'FROM chats AS c LEFT JOIN client_profiles AS p ON p.chat_id = c.id';

const SELECT_CHAT = `SELECT ${CHAT_COLUMNS} ${FROM_CHAT}`;

/**
 * Список панели. Сортировка зашита в запрос (белый список из одного варианта: по свежести последнего сообщения, затем
 * по id, чтобы страницы не гуляли), а имя колонки от вызывающего в SQL не попадает. Чаты без сообщений в конце:
 * NULL при DESC идёт последним. Открытая передача одна на чат (частичный уникальный индекс), строки не размножаются.
 */
const SELECT_PANEL = `SELECT ${CHAT_COLUMNS},
    (SELECT max(m.ts_ms) FROM messages AS m WHERE m.chat_id = c.id) AS last_message_at_ms,
    h.reason AS handoff_reason, h.level AS handoff_level, h.opened_at_ms AS handoff_opened_at_ms
  ${FROM_CHAT}
  LEFT JOIN handoffs AS h ON h.chat_id = c.id AND h.resolved_at_ms IS NULL
  WHERE (@status IS NULL OR c.status = @status)
  ORDER BY last_message_at_ms DESC, c.id DESC
  LIMIT @limit OFFSET @offset`;

/**
 * Оценка интереса: уровень в chats и выжимка в client_profiles. Выжимку агент присылает целиком, поэтому она
 * заменяется, а не дополняется.
 */
const UPSERT_PROFILE = `INSERT INTO client_profiles
    (chat_id, business, items, packaging, material, city, premises, area, scope, item_count, turnover,
     current_tracking, has_1c, one_c_name, problem, specifics, problem_agreed, inferred, reason, updated_at_ms)
  VALUES (@chatId, @business, @items, @packaging, @material, @city, @premises, @area, @scope, @itemCount,
    @turnover, @currentTracking, @has1c, @oneCName, @problem, @specifics, @problemAgreed, @inferred, @reason,
    @nowMs)
  ON CONFLICT (chat_id) DO UPDATE SET
    business = excluded.business, items = excluded.items, packaging = excluded.packaging,
    material = excluded.material, city = excluded.city, premises = excluded.premises,
    area = excluded.area, scope = excluded.scope, item_count = excluded.item_count,
    turnover = excluded.turnover, current_tracking = excluded.current_tracking,
    has_1c = excluded.has_1c, one_c_name = excluded.one_c_name,
    problem = excluded.problem, specifics = excluded.specifics,
    problem_agreed = excluded.problem_agreed, inferred = excluded.inferred, reason = excluded.reason,
    updated_at_ms = excluded.updated_at_ms`;

/**
 * Чаты и выжимки клиентов в SQLite. Здесь числовой id из базы приводится к ChatId.
 * Только подготовленные запросы с параметрами.
 * upsertByIdentity ищет чат по всем адресам (reply_jid, lid_jid, pn_jid). Нашлось несколько (для @lid стал известен
 * номер или наоборот) => сливает их в старший (chat-merge.ts): история, отметка простоя, исходящие, дневные счётчики
 * вызовов API, выжимка, передачи менеджеру и его уведомления переезжают, статус менеджера и более горячий интерес не
 * теряются; состояние определения компании переходит к старшему чату, если у него своего нет, иначе остаётся своё.
 * Новые адреса и имя важнее старых, имя null известное не стирает; reply_jid всегда адрес последнего
 * сообщения. phone: цифры из pn_jid для уведомления менеджеру. Ответ собирается чтением из базы после записи, поэтому
 * выжимка в нём настоящая.
 * findByJid ищет по тем же трём адресам и не создаёт чат. Chat.control собирается из статуса и status_by
 * (status_by пуст => { status: 'bot', by: null }). Chat.profile читается из client_profiles; нет строки => все поля null.
 * setStatus хранит StatusChange: статус, кто и когда (nowMs); неизвестный чат => явная ошибка.
 * saveAssessment пишет уровень интереса и выжимку одной транзакцией (при сбое не меняется ни то, ни другое);
 * неизвестный чат => явная ошибка.
 * listForPanel и countForPanel: чаты для панели с фильтром по статусу и страницами; limit и offset проверяются
 * (отрицательный LIMIT в SQLite значит «без лимита»), статус только bot или manager.
 * getProgress, recordTurn и resetProgress: ход разговора о цене в колонках chats (price_asks, refused_answers);
 * getNote и setNote: заметка для бота (bot_note, bot_note_at_ms). Неизвестный чат => явная ошибка.
 */
export function createChatsRepo(db: Database.Database): ChatsRepo {
  const statements = prepareStatements(db);
  const upsert = createUpsert(db, statements);
  const saveAssessment = createSaveAssessment(db, statements);
  return {
    upsertByIdentity(identity: ChatIdentity, pushName: string | null, nowMs: number): Chat {
      assertTimeMs(nowMs, 'nowMs');
      return upsert.immediate(identity, pushName, nowMs);
    },
    findByJid(jid: Jid): Chat | null {
      const row = statements.byJid.get({ jid });
      return row === undefined ? null : toChat(row);
    },
    getById(id: ChatId): Chat | null {
      const row = statements.byId.get(id);
      return row === undefined ? null : toChat(row);
    },
    setStatus(id: ChatId, change: StatusChange, nowMs: number): void {
      assertTimeMs(nowMs, 'nowMs');
      const result = statements.setStatus.run({ id, ...change, nowMs });
      if (result.changes === 0) throw new Error(`Чат #${id} не найден: статус не изменён`);
    },
    saveAssessment(id: ChatId, assessment: InterestAssessment, nowMs: number): void {
      assertTimeMs(nowMs, 'nowMs');
      saveAssessment.immediate(id, assessment, nowMs);
    },
    listForPanel(query: PanelQuery): readonly PanelChatRow[] {
      assertCount(query.limit, 'limit');
      assertCount(query.offset, 'offset');
      const status = statusFilter(query.status);
      return statements.listPanel
        .all({ status, limit: query.limit, offset: query.offset })
        .map(toPanelRow);
    },
    countForPanel(query: { readonly status?: ChatStatus }): number {
      return statements.countPanel.get({ status: statusFilter(query.status) }) ?? 0;
    },
    getProgress(id: ChatId): ChatProgress {
      const row = statements.progress.get(id);
      if (row === undefined) throw new Error(`Чат #${id} не найден: хода разговора нет`);
      return toProgress(row);
    },
    recordTurn(id: ChatId, signals: TurnSignals): void {
      const params = { id, priceAsked: flag(signals.priceAsked), refused: flag(signals.refused) };
      if (statements.recordTurn.run(params).changes === 0) {
        throw new Error(`Чат #${id} не найден: ход разговора не записан`);
      }
    },
    resetProgress(id: ChatId): void {
      if (statements.resetProgress.run(id).changes === 0) {
        throw new Error(`Чат #${id} не найден: ход разговора не сброшен`);
      }
    },
    getNote(id: ChatId): BotNote | null {
      const row = statements.note.get(id);
      if (row === undefined) throw new Error(`Чат #${id} не найден: заметки нет`);
      return toNote(row);
    },
    setNote(id: ChatId, note: BotNote | null): void {
      if (note !== null) assertTimeMs(note.atMs, 'note.atMs');
      const params = { id, text: note?.text ?? null, atMs: note?.atMs ?? null };
      if (statements.setNote.run(params).changes === 0) {
        throw new Error(`Чат #${id} не найден: заметка не записана`);
      }
    },
  };
}

function flag(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

/** Запись чата по адресам со слиянием найденных чатов в старший; ответ читается из базы после записи. */
function createUpsert(db: Database.Database, statements: Statements) {
  const absorb = createChatAbsorber(db);
  return db.transaction((identity: ChatIdentity, pushName: string | null, nowMs: number): Chat => {
    const rows = statements.byIdentity.all({
      reply: identity.replyJid,
      lid: identity.lidJid,
      pn: identity.pnJid,
    });
    const columns = mergeColumns(rows, identity, pushName, nowMs);
    const [survivor, ...absorbed] = rows;
    if (survivor === undefined) {
      return readChat(statements, Number(statements.insert.run(columns).lastInsertRowid));
    }
    for (const row of absorbed) absorb(survivor.id, row.id, nowMs);
    statements.update.run({ ...columns, id: survivor.id });
    return readChat(statements, survivor.id);
  });
}

/** Уровень интереса и выжимка одной транзакцией: при сбое не меняется ни то, ни другое. */
function createSaveAssessment(db: Database.Database, statements: Statements) {
  return db.transaction((id: ChatId, assessment: InterestAssessment, nowMs: number): void => {
    if (statements.setLevel.run({ id, level: assessment.level }).changes === 0) {
      throw new Error(`Чат #${id} не найден: оценка не сохранена`);
    }
    statements.upsertProfile.run(toAssessmentParams(id, assessment, nowMs));
  });
}

function prepareStatements(db: Database.Database) {
  return {
    byIdentity: db.prepare<{ reply: Jid; lid: Jid | null; pn: Jid | null }, ChatWithProfileRow>(
      `${SELECT_CHAT}
       WHERE c.reply_jid IN (@reply, @lid, @pn) OR c.lid_jid IN (@reply, @lid, @pn)
         OR c.pn_jid IN (@reply, @lid, @pn)
       ORDER BY c.id`,
    ),
    byJid: db.prepare<{ jid: Jid }, ChatWithProfileRow>(
      `${SELECT_CHAT} WHERE c.reply_jid = @jid OR c.lid_jid = @jid OR c.pn_jid = @jid
       ORDER BY c.id LIMIT 1`,
    ),
    byId: db.prepare<[number], ChatWithProfileRow>(`${SELECT_CHAT} WHERE c.id = ?`),
    insert: db.prepare<ChatColumns>(
      `INSERT INTO chats (reply_jid, lid_jid, pn_jid, phone, push_name, status, status_by,
         status_changed_at, interest_level, last_inbound_at, created_at)
       VALUES (@reply_jid, @lid_jid, @pn_jid, @phone, @push_name, @status, @status_by,
         @status_changed_at, @interest_level, @last_inbound_at, @created_at)`,
    ),
    update: db.prepare<ChatRow>(
      `UPDATE chats SET reply_jid = @reply_jid, lid_jid = @lid_jid, pn_jid = @pn_jid, phone = @phone,
         push_name = @push_name, status = @status, status_by = @status_by,
         status_changed_at = @status_changed_at, interest_level = @interest_level,
         last_inbound_at = @last_inbound_at, created_at = @created_at
       WHERE id = @id`,
    ),
    setStatus: db.prepare<{ id: ChatId; status: ChatStatus; by: string; nowMs: number }>(
      'UPDATE chats SET status = @status, status_by = @by, status_changed_at = @nowMs WHERE id = @id',
    ),
    setLevel: db.prepare<{ id: ChatId; level: InterestLevel }>(
      'UPDATE chats SET interest_level = @level WHERE id = @id',
    ),
    upsertProfile: db.prepare<AssessmentParams>(UPSERT_PROFILE),
    listPanel: db.prepare<{ status: ChatStatus | null; limit: number; offset: number }, PanelRow>(
      SELECT_PANEL,
    ),
    countPanel: db
      .prepare<{ status: ChatStatus | null }, number>(
        'SELECT count(*) FROM chats WHERE (@status IS NULL OR status = @status)',
      )
      .pluck(),
    progress: db.prepare<[number], ProgressRow>(
      'SELECT price_asks, refused_answers FROM chats WHERE id = ?',
    ),
    recordTurn: db.prepare<{ id: ChatId; priceAsked: 0 | 1; refused: 0 | 1 }>(
      `UPDATE chats SET price_asks = price_asks + @priceAsked,
         refused_answers = max(refused_answers, @refused)
       WHERE id = @id`,
    ),
    resetProgress: db.prepare<[number]>(
      'UPDATE chats SET price_asks = 0, refused_answers = 0 WHERE id = ?',
    ),
    note: db.prepare<[number], NoteRow>('SELECT bot_note, bot_note_at_ms FROM chats WHERE id = ?'),
    setNote: db.prepare<{ id: ChatId; text: string | null; atMs: number | null }>(
      'UPDATE chats SET bot_note = @text, bot_note_at_ms = @atMs WHERE id = @id',
    ),
  };
}

type Statements = ReturnType<typeof prepareStatements>;

/** Чат после записи, прочитанный из базы: вместе с выжимкой и с учётом слияния. */
function readChat(statements: Statements, id: number): Chat {
  const row = statements.byId.get(id);
  if (row === undefined) throw new Error(`Чат #${id} пропал сразу после записи`);
  return toChat(row);
}

/** Фильтр списка по статусу: undefined => все чаты (NULL в запросе), иное только из белого списка. */
function statusFilter(status: ChatStatus | undefined): ChatStatus | null {
  if (status === undefined) return null;
  if (!CHAT_STATUSES.includes(status)) throw new RangeError('status: ожидается bot или manager');
  return status;
}

function toAssessmentParams(
  chatId: ChatId,
  { profile, reason }: InterestAssessment,
  nowMs: number,
): AssessmentParams {
  return {
    chatId,
    business: profile.business,
    items: profile.items,
    packaging: profile.packaging,
    material: profile.material,
    city: profile.city,
    premises: profile.premises,
    area: profile.area,
    scope: profile.scope,
    itemCount: profile.itemCount,
    turnover: profile.turnover,
    currentTracking: profile.currentTracking,
    has1c: profile.has1C === null ? null : profile.has1C ? 1 : 0,
    oneCName: profile.oneCName,
    problem: profile.problem,
    specifics: profile.specifics,
    problemAgreed: flag(profile.problemAgreed),
    inferred: JSON.stringify(profile.inferred),
    reason,
    nowMs,
  };
}

function toChat(row: ChatWithProfileRow): Chat {
  return {
    id: row.id as ChatId,
    identity: {
      replyJid: row.reply_jid as Jid,
      lidJid: row.lid_jid as Jid | null,
      pnJid: row.pn_jid as Jid | null,
    },
    pushName: row.push_name,
    control: toControl(row.status, row.status_by),
    level: toLevel(row.interest_level),
    profile: toProfile(row),
  };
}

function toPanelRow(row: PanelRow): PanelChatRow {
  return {
    chat: toChat(row),
    lastMessageAtMs: row.last_message_at_ms,
    openHandoff: toOpenHandoff(row),
  };
}

/** Открытая передача из строки списка: колонки handoffs NULL (их NOT NULL в схеме) => открытой передачи нет. */
function toOpenHandoff(row: PanelRow): OpenHandoff | null {
  const { handoff_reason: reason, handoff_level: level, handoff_opened_at_ms: openedAtMs } = row;
  if (reason === null || level === null || openedAtMs === null) return null;
  return {
    reason: oneOf(HANDOFF_REASONS, reason, 'В handoffs неизвестная причина передачи'),
    level: oneOf(LEVELS, level, 'В handoffs неизвестный уровень интереса'),
    openedAtMs,
  };
}

function toProfile(row: ProfileColumns): ClientProfile {
  return {
    business: row.business,
    items: row.items,
    packaging: row.packaging,
    material: row.material,
    city: row.city,
    premises: row.premises,
    area: row.area,
    scope: row.scope,
    itemCount: row.item_count,
    turnover: row.turnover,
    currentTracking: row.current_tracking,
    has1C: toHas1C(row.has_1c),
    oneCName: row.one_c_name,
    problem: row.problem,
    specifics: row.specifics,
    problemAgreed: row.problem_agreed === 1,
    inferred: inferredOf(row.inferred),
  };
}

/** Пометки «вероятно» из JSON: только известные поля, по порядку PROFILE_FACTS; испорченное значение => пометок нет. */
function inferredOf(json: string | null): readonly ProfileFact[] {
  if (json === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const marked = new Set<unknown>(value);
  return PROFILE_FACTS.filter((field) => marked.has(field));
}

function toNote(row: NoteRow): BotNote | null {
  const { bot_note: text, bot_note_at_ms: atMs } = row;
  return text === null || atMs === null ? null : { text, atMs };
}

function toProgress(row: ProgressRow): ChatProgress {
  if (row.refused_answers !== 0 && row.refused_answers !== 1) {
    throw new Error('В chats недопустимое значение отказа отвечать: строка испорчена');
  }
  return { priceAsks: row.price_asks, refused: row.refused_answers === 1 };
}

function toHas1C(value: number | null): boolean | null {
  if (value === null) return null;
  if (value === 1) return true;
  if (value === 0) return false;
  throw new Error('В client_profiles недопустимое значение «есть ли 1С»: строка испорчена');
}

function toControl(status: string, by: string | null): ChatControl {
  if (status === 'bot' && (by === null || by === 'panel')) return { status, by };
  const managerBy = MANAGER_AUTHORS.find((author) => author === by);
  if (status === 'manager' && managerBy !== undefined) return { status, by: managerBy };
  throw new Error('В chats недопустимый статус чата: строка испорчена');
}

function toLevel(value: string): InterestLevel {
  return oneOf(LEVELS, value, 'В chats неизвестный уровень интереса');
}
