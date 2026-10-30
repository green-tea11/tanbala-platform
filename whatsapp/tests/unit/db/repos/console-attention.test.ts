import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  BOT_SILENT_AFTER_MS,
  WAITING_WINDOW_MS,
} from '../../../../src/db/repos/console-chat-list.js';
import { createConsoleReads } from '../../../../src/db/repos/console-details.js';
import type { ConsoleChatFilter } from '../../../../src/domain/console.js';
import type { Author, ChatId, Jid } from '../../../../src/domain/types.js';
import { insertChat, LID_B, PN_A, PN_B, useMigratedDb } from '../fixture.js';

// Выборки консоли после ревью: окно 30 дней и числа «Требует внимания», поиск по имени без учёта регистра кириллицы и
// невидимых символов, транзакция чтения.

const NOW = Date.UTC(2026, 9, 30, 10, 0);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const PN_C = '77000000003@s.whatsapp.net' as Jid;
const PN_D = '77000000004@s.whatsapp.net' as Jid;
const PAGE = { limit: 30, offset: 0 };
/** Невидимые символы кодами: в исходнике их не видно. */
const ZWSP = String.fromCodePoint(0x200b);
const SOFT_HYPHEN = String.fromCodePoint(0x00ad);
const RTL_OVERRIDE = String.fromCodePoint(0x202e);
const BOM = String.fromCodePoint(0xfeff);
const HIDDEN_NAME = `Ал${ZWSP}и${SOFT_HYPHEN}я${RTL_OVERRIDE}`;

function chat(
  db: Database.Database,
  replyJid: Jid,
  fields: { name?: string | null; status?: 'bot' | 'manager'; level?: string } = {},
): ChatId {
  const pn = replyJid.endsWith('@lid') ? null : replyJid;
  const id = insertChat(db, {
    replyJid,
    pnJid: pn,
    phone: pn === null ? null : pn.split('@')[0],
    pushName: fields.name ?? null,
  });
  const manager = fields.status === 'manager';
  db.prepare(
    `UPDATE chats SET status = ?, status_by = ?, status_changed_at = ?, interest_level = ? WHERE id = ?`,
  ).run(
    manager ? 'manager' : 'bot',
    manager ? 'bot' : null,
    manager ? NOW : null,
    fields.level ?? 'cold',
    id,
  );
  return id;
}

let waSeq = 0;
function message(db: Database.Database, chatId: ChatId, author: Author, tsMs: number): void {
  waSeq += 1;
  db.prepare(
    `INSERT INTO messages (chat_id, wa_id, author, kind, text, ts_ms) VALUES (?, ?, ?, 'text', 'т', ?)`,
  ).run(chatId, `WA-${String(waSeq)}`, author, tsMs);
}

function handoff(db: Database.Database, chatId: ChatId, reason: string): void {
  db.prepare(
    `INSERT INTO handoffs (chat_id, reason, level, snapshot, opened_at_ms) VALUES (?, ?, 'warm', '{}', ?)`,
  ).run(chatId, reason, NOW);
}

function names(db: Database.Database, variants: readonly string[], digits: string | null = null) {
  const filter: ConsoleChatFilter = { nowMs: NOW, search: { nameVariants: variants, digits } };
  return createConsoleReads(db)
    .listChats(filter, PAGE)
    .map((row) => row.pushName);
}

describe('выборки консоли: ждут ответа за 30 дней', () => {
  it('клиент писал раньше 30 дней: в списке нет, считается в staleWaiting', () => {
    const db = useMigratedDb();
    const reads = createConsoleReads(db);
    const fresh = chat(db, PN_A, { status: 'manager' });
    const edge = chat(db, LID_B);
    const stale = chat(db, PN_C, { status: 'manager' });
    const staleBot = chat(db, PN_D);
    message(db, fresh, 'client', NOW - 2 * DAY);
    message(db, edge, 'client', NOW - WAITING_WINDOW_MS);
    message(db, stale, 'client', NOW - WAITING_WINDOW_MS - 1);
    message(db, staleBot, 'client', NOW - 40 * DAY);
    message(db, staleBot, 'bot', NOW - 40 * DAY + MIN);

    const waiting = reads.waitingChats(NOW, 10);

    expect(waiting.map((row) => row.chatId)).toEqual([edge, fresh]);
    expect(reads.attentionCounts(NOW)).toEqual({
      handoffs: 0,
      hot: 0,
      waiting: 2,
      staleWaiting: 1,
    });
    // Список чатов окно не применяет: фильтр «ждут ответа» показывает и старые.
    expect(reads.countChats({ nowMs: NOW, waitingOnly: true })).toBe(3);
  });

  it('числа без предела списка: передачи без перехвата человеком, горячие, ждущие', () => {
    const db = useMigratedDb();
    const reads = createConsoleReads(db);
    const hot = chat(db, PN_A, { status: 'manager', level: 'hot' });
    const asked = chat(db, LID_B, { status: 'manager', level: 'hot' });
    const took = chat(db, PN_C, { status: 'manager', level: 'hot' });
    const warm = chat(db, PN_D, { status: 'manager', level: 'warm' });
    for (const id of [hot, asked, took, warm]) {
      message(db, id, 'client', NOW - BOT_SILENT_AFTER_MS);
    }
    handoff(db, hot, 'hot');
    handoff(db, asked, 'asked_human');
    handoff(db, took, 'human_took_over');

    expect(reads.attentionCounts(NOW)).toEqual({
      handoffs: 2,
      hot: 3,
      waiting: 4,
      staleWaiting: 0,
    });
    expect(reads.openHandoffs(1)).toHaveLength(1);
    expect(reads.hotChats(2)).toHaveLength(2);
    expect(reads.waitingChats(NOW, 3)).toHaveLength(3);
  });

  it('ждёт с первого неотвеченного сообщения клиента, а не с последнего', () => {
    const db = useMigratedDb();
    const reads = createConsoleReads(db);
    const id = chat(db, PN_A);
    message(db, id, 'client', NOW - 30 * MIN);
    message(db, id, 'bot', NOW - 29 * MIN);
    message(db, id, 'client', NOW - 20 * MIN);
    message(db, id, 'client', NOW - MIN);

    expect(reads.waitingChats(NOW, 10)).toEqual([
      expect.objectContaining({
        chatId: id,
        group: 'bot',
        waitingSinceMs: NOW - 20 * MIN,
        lastClientAtMs: NOW - MIN,
      }),
    ]);
  });

  it('пустая база: все числа ноль; неверное время — RangeError', () => {
    const reads = createConsoleReads(useMigratedDb());

    expect(reads.attentionCounts(NOW)).toEqual({
      handoffs: 0,
      hot: 0,
      waiting: 0,
      staleWaiting: 0,
    });
    expect(() => reads.attentionCounts(Number.NaN)).toThrow(RangeError);
  });
});

describe('выборки консоли: поиск по имени', () => {
  it('регистр кириллицы любой, в том числе смешанный', () => {
    const db = useMigratedDb();
    chat(db, PN_A, { name: 'АлИя Сарсенова' });
    chat(db, LID_B, { name: 'Бауыржан' });

    expect(names(db, ['аЛиЯ'])).toEqual(['АлИя Сарсенова']);
    expect(names(db, ['САРСЕН'])).toEqual(['АлИя Сарсенова']);
    expect(names(db, ['бАуЫрЖаН'])).toEqual(['Бауыржан']);
    expect(names(db, ['Ёж'])).toEqual([]);
  });

  it('невидимые символы в имени и в запросе не мешают', () => {
    const db = useMigratedDb();
    chat(db, PN_A, { name: HIDDEN_NAME });

    expect(names(db, ['алия'])).toEqual([HIDDEN_NAME]);
    expect(names(db, [`${BOM}АЛИЯ`])).toHaveLength(1);
  });

  it('цифры ищут по номеру; пустые и повторные варианты имени ничего не находят сами', () => {
    const db = useMigratedDb();
    chat(db, PN_A, { name: 'Алия' });
    chat(db, PN_B, { name: null });
    chat(db, LID_B, { name: '0000002' });

    expect(names(db, ['zzz'], '0000002')).toEqual([null]);
    expect(names(db, ['', ZWSP], '000000')).toEqual([null, 'Алия']);
    expect(names(db, ['алия', 'АЛИЯ', 'Алия', 'алия'])).toEqual(['Алия']);
    expect(names(db, ['', ''])).toHaveLength(3);
  });

  it('встроенная lower() SQLite не подменяется: функция поиска своя', () => {
    const db = useMigratedDb();
    chat(db, PN_A, { name: 'Алия' });
    names(db, ['алия']);

    expect(db.prepare("SELECT lower('АБВ ABC')").pluck().get()).toBe('АБВ abc');
  });
});

describe('выборки консоли: транзакция чтения', () => {
  it('work идёт внутри транзакции, результат возвращается, исключение всплывает', () => {
    const db = useMigratedDb();
    const reads = createConsoleReads(db);
    chat(db, PN_A, { name: 'Алия' });

    const result = reads.readTransaction(() => ({
      inside: db.inTransaction,
      total: reads.countChats({ nowMs: NOW }),
    }));

    expect(result).toEqual({ inside: true, total: 1 });
    expect(db.inTransaction).toBe(false);
    expect(() =>
      reads.readTransaction(() => {
        throw new RangeError('сбой');
      }),
    ).toThrow(RangeError);
    expect(db.inTransaction).toBe(false);
  });
});

describe('выборки консоли: связи чат → компания', () => {
  function link(db: Database.Database, chatId: ChatId, companyId: number, confirmedAtMs: number) {
    db.prepare('INSERT INTO chat_companies (chat_id, state, updated_at) VALUES (?, ?, ?)').run(
      chatId,
      JSON.stringify({ confirmed: { id: companyId, name: 'X', confirmedAtMs } }),
      NOW,
    );
  }

  it('свежие сверху: последнее сообщение, без сообщений — время подтверждения; предел отбрасывает старые', () => {
    const db = useMigratedDb();
    const reads = createConsoleReads(db);
    const old = chat(db, PN_A);
    const quiet = chat(db, LID_B);
    const fresh = chat(db, PN_C);
    const other = chat(db, PN_D);
    link(db, old, 1, NOW - 60 * MIN);
    link(db, quiet, 2, NOW - 5 * MIN);
    link(db, fresh, 3, NOW - 60 * MIN);
    link(db, other, 2, NOW - 90 * MIN);
    message(db, old, 'client', NOW - 10 * MIN);
    message(db, fresh, 'client', NOW - MIN);

    expect(reads.companyLinks({ limit: 10 }).map((row) => row.chatId)).toEqual([
      fresh,
      quiet,
      old,
      other,
    ]);
    expect(reads.companyLinks({ limit: 2 }).map((row) => row.chatId)).toEqual([fresh, quiet]);
    expect(reads.countCompanyLinks({})).toBe(4);
    expect(reads.countCompanyLinks({ companyId: 2 })).toBe(2);
    expect(reads.countCompanyLinks({ companyId: 9 })).toBe(0);
  });
});
