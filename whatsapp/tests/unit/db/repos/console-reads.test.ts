import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { BOT_SILENT_AFTER_MS } from '../../../../src/db/repos/console-chat-list.js';
import { createConsoleReads } from '../../../../src/db/repos/console-details.js';
import type { ConsoleChatFilter, ConsoleReads } from '../../../../src/domain/console.js';
import type { Author, ChatId, Jid } from '../../../../src/domain/types.js';
import { insertChat, LID_B, PN_A, useMemoryDb, useMigratedDb } from '../fixture.js';

// Выборки консоли на настоящей SQLite в памяти со схемой текущей версии.

const NOW = Date.UTC(2026, 9, 30, 10, 0);
const MIN = 60_000;
const PN_C = '77000000003@s.whatsapp.net' as Jid;
const PN_D = '77000000004@s.whatsapp.net' as Jid;
const LID_E = '100000000000005@lid' as Jid;
const PAGE = { limit: 30, offset: 0 };

interface Setup {
  readonly db: Database.Database;
  readonly reads: ConsoleReads;
}

function setup(): Setup {
  const db = useMigratedDb();
  return { db, reads: createConsoleReads(db) };
}

function chat(
  db: Database.Database,
  replyJid: Jid,
  fields: {
    name?: string | null;
    status?: 'bot' | 'manager';
    by?: string | null;
    level?: string;
  } = {},
): ChatId {
  const pn = replyJid.endsWith('@lid') ? null : replyJid;
  const id = insertChat(db, {
    replyJid,
    pnJid: pn,
    phone: pn === null ? null : pn.split('@')[0],
    pushName: fields.name ?? null,
  });
  const status = fields.status ?? 'bot';
  const by = fields.by ?? (status === 'manager' ? 'bot' : null);
  db.prepare(
    `UPDATE chats SET status = ?, status_by = ?, status_changed_at = ?, interest_level = ? WHERE id = ?`,
  ).run(status, by, by === null ? null : NOW - 30 * MIN, fields.level ?? 'cold', id);
  return id;
}

let waSeq = 0;
function message(
  db: Database.Database,
  chatId: ChatId,
  author: Author,
  tsMs: number,
  options: { text?: string | null; kind?: string; notice?: boolean } = {},
): void {
  waSeq += 1;
  const waId = `WA-${String(waSeq)}`;
  db.prepare(
    'INSERT INTO messages (chat_id, wa_id, author, kind, text, ts_ms) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    chatId,
    waId,
    author,
    options.kind ?? 'text',
    options.text === undefined ? `текст ${waId}` : options.text,
    tsMs,
  );
  if (author === 'bot' || author === 'human_panel') {
    const origin =
      options.notice === true ? 'handoff_notice' : author === 'bot' ? 'bot_reply' : 'panel';
    db.prepare(
      `INSERT INTO outbound_ids (wa_id, chat_id, jid, origin, text, status, created_at)
       VALUES (?, ?, 'x@s.whatsapp.net', ?, 'т', 'sent', ?)`,
    ).run(waId, chatId, origin, tsMs);
  }
}

function handoff(
  db: Database.Database,
  chatId: ChatId,
  reason: string,
  openedAtMs: number,
  resolvedAtMs: number | null = null,
): number {
  const result = db
    .prepare(
      `INSERT INTO handoffs (chat_id, reason, level, snapshot, opened_at_ms, resolved_at_ms)
       VALUES (?, ?, 'warm', '{}', ?, ?)`,
    )
    .run(chatId, reason, openedAtMs, resolvedAtMs);
  return Number(result.lastInsertRowid);
}

function notification(
  db: Database.Database,
  chatId: ChatId | null,
  fields: { kind?: string; status?: string; atMs?: number; attempts?: number; text?: string } = {},
): void {
  db.prepare(
    `INSERT INTO manager_notifications (kind, chat_id, text, status, attempts, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fields.kind ?? (chatId === null ? 'backlog' : 'handoff'),
    chatId,
    fields.text ?? 'Уведомление',
    fields.status ?? 'sent',
    fields.attempts ?? 1,
    fields.atMs ?? NOW,
    (fields.atMs ?? NOW) + MIN,
  );
}

function companyState(db: Database.Database, chatId: ChatId, state: string): void {
  db.prepare('INSERT INTO chat_companies (chat_id, state, updated_at) VALUES (?, ?, ?)').run(
    chatId,
    state,
    NOW,
  );
}

function filter(overrides: Partial<ConsoleChatFilter> = {}): ConsoleChatFilter {
  return { nowMs: NOW, ...overrides };
}

describe('выборки консоли: список чатов', () => {
  it('сортировка как у старой панели, последнее сообщение, открытая передача', () => {
    const { db, reads } = setup();
    const a = chat(db, PN_A, { name: 'Алия', status: 'manager', level: 'hot' });
    const b = chat(db, LID_B, { name: 'Бауыржан' });
    const c = chat(db, PN_C, { name: 'Без сообщений' });
    message(db, a, 'client', NOW - 10 * MIN);
    message(db, a, 'bot', NOW - 9 * MIN, { text: 'Ответ бота' });
    message(db, b, 'client', NOW - 5 * MIN, { kind: 'voice', text: null });
    handoff(db, a, 'hot', NOW - 9 * MIN);
    handoff(db, a, 'asked_human', NOW - 60 * MIN, NOW - 50 * MIN);

    const rows = reads.listChats(filter(), PAGE);

    expect(rows.map((row) => row.id)).toEqual([b, a, c]);
    expect(rows[0]).toMatchObject({
      pushName: 'Бауыржан',
      pnJid: null,
      control: { status: 'bot', by: null },
      lastMessage: { author: 'client', kind: 'voice', text: null },
      openHandoff: null,
      company: null,
    });
    expect(rows[1]).toMatchObject({
      pnJid: PN_A,
      control: { status: 'manager', by: 'bot' },
      level: 'hot',
      lastMessageAtMs: NOW - 9 * MIN,
      lastMessage: { author: 'bot', kind: 'text', text: 'Ответ бота' },
      openHandoff: { reason: 'hot', level: 'warm', openedAtMs: NOW - 9 * MIN },
    });
    expect(rows[2]).toMatchObject({
      lastMessageAtMs: null,
      lastMessage: null,
      waitingSinceMs: null,
    });
    expect(reads.countChats(filter())).toBe(3);
    expect(reads.listChats(filter(), { limit: 1, offset: 1 }).map((row) => row.id)).toEqual([a]);
  });

  it('фильтры статуса, уровня и компании; испорченный JSON — без компании', () => {
    const { db, reads } = setup();
    const confirmed = chat(db, PN_A, { status: 'manager', level: 'warm' });
    const candidate = chat(db, LID_B, { level: 'hot' });
    const broken = chat(db, PN_C);
    chat(db, PN_D);
    companyState(
      db,
      confirmed,
      JSON.stringify({ confirmed: { id: 42, name: 'ТОО Склад' }, candidate: { id: 7 } }),
    );
    companyState(
      db,
      candidate,
      JSON.stringify({ confirmed: null, candidate: { id: 7, name: 'ИП Кандидат' } }),
    );
    companyState(db, broken, '{не json');

    expect(
      reads.listChats(filter({ company: 'confirmed' }), PAGE).map((r) => [r.id, r.company]),
    ).toEqual([[confirmed, { state: 'confirmed', id: 42, name: 'ТОО Склад' }]]);
    expect(reads.listChats(filter({ company: 'candidate' }), PAGE)[0]?.company).toEqual({
      state: 'candidate',
      id: 7,
      name: 'ИП Кандидат',
    });
    expect(reads.countChats(filter({ company: 'none' }))).toBe(2);
    expect(reads.countChats(filter({ status: 'manager' }))).toBe(1);
    expect(reads.countChats(filter({ level: 'hot' }))).toBe(1);
    expect(reads.countChats(filter({ status: 'bot', level: 'cold' }))).toBe(2);
  });

  it('поиск по имени с любым регистром кириллицы и по цифрам номера', () => {
    const { db, reads } = setup();
    const aliya = chat(db, PN_A, { name: 'Алия Сарсенова' });
    chat(db, LID_B, { name: 'Бауыржан' });
    const byPhone = chat(db, PN_C, { name: null });
    const search = (variants: string[], digits: string | null = null) =>
      reads
        .listChats(filter({ search: { nameVariants: variants, digits } }), PAGE)
        .map((r) => r.id);

    expect(search(['алия', 'алия', 'АЛИЯ', 'Алия'])).toEqual([aliya]);
    expect(search(['сарсенова', 'сарсенова', 'САРСЕНОВА', 'Сарсенова'])).toEqual([aliya]);
    expect(search(['нет такого'])).toEqual([]);
    expect(search(['zzz'], '0000003')).toEqual([byPhone]);
    expect(search([''], '000000')).toHaveLength(2);
    expect(reads.countChats(filter({ search: { nameVariants: ['Бауыржан'], digits: null } }))).toBe(
      1,
    );
  });

  it('пустой поиск не фильтрует', () => {
    const { db, reads } = setup();
    chat(db, PN_A, { name: 'Алия' });
    chat(db, LID_B);

    expect(reads.countChats(filter({ search: { nameVariants: [], digits: null } }))).toBe(2);
  });
});

describe('выборки консоли: ждут ответа', () => {
  it('у менеджера: клиент написал после последнего ответа; фраза о передаче ответом не считается', () => {
    const { db, reads } = setup();
    const id = chat(db, PN_A, { status: 'manager' });
    message(db, id, 'client', NOW - 30 * MIN);
    message(db, id, 'bot', NOW - 29 * MIN);
    message(db, id, 'client', NOW - 20 * MIN);
    message(db, id, 'bot', NOW - 19 * MIN, { notice: true });
    message(db, id, 'client', NOW - MIN);

    const [row] = reads.listChats(filter(), PAGE);
    const [waiting] = reads.waitingChats(NOW, 10);

    expect(row?.waitingSinceMs).toBe(NOW - 20 * MIN);
    expect(waiting).toEqual({
      chatId: id,
      pushName: null,
      pnJid: PN_A,
      status: 'manager',
      group: 'manager',
      waitingSinceMs: NOW - 20 * MIN,
      lastClientAtMs: NOW - MIN,
      complaint: false,
    });
  });

  it('у менеджера: человек ответил после клиента => не ждёт', () => {
    const { db, reads } = setup();
    const id = chat(db, PN_A, { status: 'manager', by: 'panel' });
    message(db, id, 'client', NOW - 10 * MIN);
    message(db, id, 'human_panel', NOW - 9 * MIN);
    message(db, id, 'client', NOW - 8 * MIN);
    message(db, id, 'human_phone', NOW - 7 * MIN);

    expect(reads.waitingChats(NOW, 10)).toEqual([]);
    expect(reads.countChats(filter({ waitingOnly: true }))).toBe(0);
  });

  it('у бота: ждёт только дольше 5 минут', () => {
    const { db, reads } = setup();
    const silent = chat(db, PN_A);
    const fresh = chat(db, LID_B);
    const answered = chat(db, PN_C);
    message(db, silent, 'client', NOW - BOT_SILENT_AFTER_MS);
    message(db, silent, 'client', NOW - MIN);
    message(db, fresh, 'client', NOW - BOT_SILENT_AFTER_MS + 1);
    message(db, answered, 'client', NOW - 30 * MIN);
    message(db, answered, 'bot', NOW - 29 * MIN);

    const waiting = reads.waitingChats(NOW, 10);

    expect(waiting.map((row) => [row.chatId, row.group, row.waitingSinceMs])).toEqual([
      [silent, 'bot', NOW - BOT_SILENT_AFTER_MS],
    ]);
    expect(reads.listChats(filter({ waitingOnly: true }), PAGE).map((row) => row.id)).toEqual([
      silent,
    ]);
  });

  it('последняя передача жалоба: пометка complaint; дольше всех ждущие первыми', () => {
    const { db, reads } = setup();
    const later = chat(db, PN_A, { status: 'manager' });
    const earlier = chat(db, LID_B, { status: 'manager' });
    message(db, later, 'client', NOW - 3 * MIN);
    message(db, earlier, 'client', NOW - 40 * MIN);
    handoff(db, earlier, 'hot', NOW - 50 * MIN, NOW - 45 * MIN);
    handoff(db, earlier, 'complaint', NOW - 39 * MIN);

    const waiting = reads.waitingChats(NOW, 10);

    expect(waiting.map((row) => [row.chatId, row.complaint])).toEqual([
      [earlier, true],
      [later, false],
    ]);
    expect(reads.waitingChats(NOW, 1)).toHaveLength(1);
  });
});

describe('выборки консоли: «Требует внимания»', () => {
  it('открытые передачи без перехвата человеком, с первым уведомлением после открытия', () => {
    const { db, reads } = setup();
    const a = chat(db, PN_A, { name: 'Алия', status: 'manager' });
    const b = chat(db, LID_B, { status: 'manager', by: 'panel' });
    const c = chat(db, PN_C, { status: 'manager' });
    const opened = handoff(db, a, 'asked_human', NOW - 10 * MIN);
    handoff(db, b, 'human_took_over', NOW - 5 * MIN);
    handoff(db, c, 'limit', NOW - MIN);
    notification(db, a, { atMs: NOW - 20 * MIN, status: 'sent' });
    notification(db, a, { atMs: NOW - 10 * MIN, status: 'failed', attempts: 3 });
    notification(db, a, { atMs: NOW - 9 * MIN, status: 'sent' });

    const rows = reads.openHandoffs(10);

    expect(rows.map((row) => row.chatId)).toEqual([c, a]);
    expect(rows[1]).toEqual({
      id: opened,
      chatId: a,
      pushName: 'Алия',
      pnJid: PN_A,
      reason: 'asked_human',
      level: 'warm',
      openedAtMs: NOW - 10 * MIN,
      notification: { status: 'failed', attempts: 3 },
    });
    expect(rows[0]?.notification).toBeNull();
  });

  it('горячие клиенты с причиной уровня; простой без уведомления', () => {
    const { db, reads } = setup();
    const hot = chat(db, PN_A, { level: 'hot', status: 'manager' });
    chat(db, LID_B, { level: 'warm' });
    const hotWithout = chat(db, PN_C, { level: 'hot' });
    message(db, hot, 'client', NOW - MIN);
    db.prepare('INSERT INTO client_profiles (chat_id, reason, updated_at_ms) VALUES (?, ?, ?)').run(
      hot,
      'Спросил цену',
      NOW - 2 * MIN,
    );
    db.prepare(
      'INSERT INTO backlog_chats (chat_id, marked_at_ms, notified_at_ms) VALUES (?, ?, ?), (?, ?, NULL)',
    ).run(hot, NOW, NOW, hotWithout, NOW);

    expect(reads.hotChats(10)).toEqual([
      {
        chatId: hot,
        pushName: null,
        pnJid: PN_A,
        status: 'manager',
        levelReason: 'Спросил цену',
        levelUpdatedAtMs: NOW - 2 * MIN,
        lastMessageAtMs: NOW - MIN,
      },
      expect.objectContaining({ chatId: hotWithout, levelReason: null, lastMessageAtMs: null }),
    ]);
    expect(reads.pendingBacklogCount()).toBe(1);
  });
});

describe('выборки консоли: карточка, уведомления, связи, счётчики', () => {
  it('время статуса и создания, выжимка, история передач, число отклонённых черновиков', () => {
    const { db, reads } = setup();
    const id = chat(db, PN_A, { status: 'manager' });
    const first = handoff(db, id, 'hot', NOW - 60 * MIN, NOW - 50 * MIN);
    const second = handoff(db, id, 'complaint', NOW - 10 * MIN);
    db.prepare('INSERT INTO client_profiles (chat_id, reason, updated_at_ms) VALUES (?, ?, ?)').run(
      id,
      'Тёплый',
      NOW,
    );
    for (const atMs of [NOW, NOW - MIN, NOW - 2 * MIN]) {
      db.prepare(
        `INSERT INTO rejected_drafts (chat_id, attempt, source, draft, remarks, at_ms) VALUES (?, 1, 'code', 'ч', '[]', ?)`,
      ).run(id, atMs);
    }

    expect(reads.chatMeta(id)).toEqual({ statusChangedAtMs: NOW - 30 * MIN, createdAtMs: 0 });
    expect(reads.chatMeta(999 as ChatId)).toBeNull();
    expect(reads.profileMeta(id)).toEqual({ reason: 'Тёплый', updatedAtMs: NOW });
    expect(reads.profileMeta(999 as ChatId)).toBeNull();
    expect(reads.handoffHistory(id, 10)).toEqual([
      {
        id: second,
        reason: 'complaint',
        level: 'warm',
        openedAtMs: NOW - 10 * MIN,
        resolvedAtMs: null,
      },
      {
        id: first,
        reason: 'hot',
        level: 'warm',
        openedAtMs: NOW - 60 * MIN,
        resolvedAtMs: NOW - 50 * MIN,
      },
    ]);
    expect(reads.handoffHistory(id, 1)).toHaveLength(1);
    expect(reads.countRejected(id)).toBe(3);
  });

  it('уведомления с именем клиента и фильтром по статусу, новые сверху', () => {
    const { db, reads } = setup();
    const a = chat(db, PN_A, { name: 'Алия' });
    notification(db, a, { atMs: NOW - 2 * MIN, status: 'failed', attempts: 5, text: 'Текст 1' });
    notification(db, null, { atMs: NOW - MIN, status: 'no_manager' });
    notification(db, a, { atMs: NOW, status: 'failed' });

    const all = reads.listNotifications({ limit: 10, offset: 0 });
    const failed = reads.listNotifications({ status: 'failed', limit: 1, offset: 1 });

    expect(all.map((item) => [item.kind, item.chatName])).toEqual([
      ['handoff', 'Алия'],
      ['backlog', null],
      ['handoff', 'Алия'],
    ]);
    expect(failed).toEqual([
      {
        id: expect.any(Number) as number,
        kind: 'handoff',
        chatId: a,
        text: 'Текст 1',
        status: 'failed',
        attempts: 5,
        createdAtMs: NOW - 2 * MIN,
        updatedAtMs: NOW - MIN,
        chatName: 'Алия',
      },
    ]);
    expect(reads.countNotifications({})).toBe(3);
    expect(reads.countNotifications({ status: 'failed' })).toBe(2);
    expect(reads.countNotifications({ status: 'pending' })).toBe(0);
  });

  it('подтверждённые связи чат → компания: кандидат и испорченный JSON не в счёт', () => {
    const { db, reads } = setup();
    const a = chat(db, PN_A, { name: 'Алия', level: 'hot' });
    const b = chat(db, LID_B);
    const c = chat(db, PN_C);
    const d = chat(db, LID_E);
    companyState(
      db,
      a,
      JSON.stringify({ confirmed: { id: 42, name: 'X', confirmedAtMs: NOW - MIN } }),
    );
    companyState(db, b, JSON.stringify({ confirmed: { id: 42, confirmedAtMs: 'вчера' } }));
    companyState(db, c, JSON.stringify({ confirmed: null, candidate: { id: 42 } }));
    companyState(db, d, '[1, 2');
    message(db, a, 'client', NOW - 5 * MIN);
    message(db, a, 'bot', NOW - 4 * MIN);

    expect(reads.companyLinks({ limit: 10 })).toEqual([
      {
        chatId: a,
        companyId: 42,
        pushName: 'Алия',
        pnJid: PN_A,
        status: 'bot',
        level: 'hot',
        confirmedAtMs: NOW - MIN,
        firstClientMessageAtMs: NOW - 5 * MIN,
        lastMessageAtMs: NOW - 4 * MIN,
      },
      expect.objectContaining({
        chatId: b,
        companyId: 42,
        confirmedAtMs: null,
        firstClientMessageAtMs: null,
      }),
    ]);
    expect(reads.companyLinks({ companyId: 43, limit: 10 })).toEqual([]);
    expect(reads.companyLinks({ companyId: 42, limit: 1 })).toHaveLength(1);
  });

  it('вызовы API за сутки по общему счётчику и попытки привязки за окно', () => {
    const { db, reads } = setup();
    const id = chat(db, PN_A);
    db.prepare(
      'INSERT INTO api_usage (day, chat_id, count) VALUES (?, 0, 12), (?, ?, 5), (?, 0, 3)',
    ).run('2026-10-30', '2026-10-30', id, '2026-10-29');
    db.prepare('INSERT INTO pairing_attempts (at_ms) VALUES (?), (?)').run(
      NOW - 30 * 60 * MIN,
      NOW - MIN,
    );

    expect(reads.apiCallsOn('2026-10-30')).toBe(12);
    expect(reads.apiCallsOn('2026-10-28')).toBe(0);
    expect(reads.pairingAttemptsSince(NOW - 24 * 60 * MIN)).toBe(1);
    expect(() => reads.apiCallsOn('30.10.2026')).toThrow(RangeError);
    expect(() => reads.pairingAttemptsSince(-1)).toThrow(RangeError);
  });

  it('неверные limit и offset: RangeError до SQL', () => {
    const { reads } = setup();

    expect(() => reads.listChats(filter(), { limit: -1, offset: 0 })).toThrow(RangeError);
    expect(() => reads.openHandoffs(Number.NaN)).toThrow(RangeError);
    expect(() => reads.listNotifications({ limit: 1, offset: -1 })).toThrow(RangeError);
    expect(() => reads.companyLinks({ limit: 1.5 })).toThrow(RangeError);
    expect(() => reads.waitingChats(-1, 1)).toThrow(RangeError);
  });

  it('запросы готовятся при первом обращении: создание на базе без схемы ничего не делает', () => {
    const db = useMemoryDb();

    const reads = createConsoleReads(db);

    expect(() => reads.pendingBacklogCount()).toThrow();
  });

  it('только чтение: выборки не меняют базу', () => {
    const { db, reads } = setup();
    const id = chat(db, PN_A, { status: 'manager' });
    message(db, id, 'client', NOW - 10 * MIN);
    const before = db.prepare('SELECT total_changes() AS n').get() as { n: number };

    reads.listChats(filter({ waitingOnly: true }), PAGE);
    reads.countChats(filter());
    reads.waitingChats(NOW, 10);
    reads.openHandoffs(10);
    reads.hotChats(10);
    reads.chatMeta(id);
    reads.handoffHistory(id, 10);
    reads.listNotifications({ limit: 10, offset: 0 });
    reads.companyLinks({ limit: 10 });

    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });
});
