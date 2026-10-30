import type Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../../src/db/connection.js';
import { runMigrations } from '../../../../src/db/migrations.js';
import { createConsoleReads } from '../../../../src/db/repos/console-details.js';
import type { ConsoleChatFilter, ConsoleReads } from '../../../../src/domain/console.js';

// Скорость выборок консоли на базе в памяти: 500 чатов по 50 сообщений. Число и страница списка чатов и «Требует
// внимания» укладываются в 100 мс каждая; замер пишется в вывод теста, чтобы видеть запас.

const NOW = Date.UTC(2026, 9, 30, 10, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const CHATS = 500;
const MESSAGES_PER_CHAT = 50;
const BUDGET_MS = 100;
const PAGE = { limit: 30, offset: 0 };
const ATTENTION_LIMIT = 200;

interface Statements {
  chat: Database.Statement<[string, string, string, string, string, string | null, number | null]>;
  message: Database.Statement<[number, string, string, string, number]>;
  outbound: Database.Statement<[string, number, string, number]>;
  handoff: Database.Statement<[number, number]>;
  hot: Database.Statement<[number, number]>;
  company: Database.Statement<[number, string, number]>;
}

function statementsOf(db: Database.Database): Statements {
  return {
    chat: db.prepare(
      `INSERT INTO chats (reply_jid, pn_jid, phone, push_name, status, status_by, status_changed_at,
         interest_level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'cold', 0)`,
    ),
    message: db.prepare(
      `INSERT INTO messages (chat_id, wa_id, author, kind, text, ts_ms) VALUES (?, ?, ?, 'text', ?, ?)`,
    ),
    outbound: db.prepare(
      `INSERT INTO outbound_ids (wa_id, chat_id, jid, origin, text, status, created_at)
       VALUES (?, ?, 'x@s.whatsapp.net', ?, 'т', 'sent', ?)`,
    ),
    handoff: db.prepare(
      `INSERT INTO handoffs (chat_id, reason, level, snapshot, opened_at_ms) VALUES (?, 'hot', 'warm', '{}', ?)`,
    ),
    hot: db.prepare(
      `INSERT INTO client_profiles (chat_id, reason, updated_at_ms) VALUES (?, 'Спросил цену', ?)`,
    ),
    company: db.prepare('INSERT INTO chat_companies (chat_id, state, updated_at) VALUES (?, ?, ?)'),
  };
}

/** Чат i: последнее сообщение за i * 3 часа до сейчас (после 240-го старше 30 дней), у чётных последним пишет клиент. */
function seedChat(db: Database.Database, s: Statements, i: number): void {
  const phone = `7700${String(i).padStart(7, '0')}`;
  const manager = i % 3 === 0;
  s.chat.run(
    `${phone}@s.whatsapp.net`,
    `${phone}@s.whatsapp.net`,
    phone,
    i % 2 === 0 ? `Клиент Номер ${String(i)}` : `АЛИЯ ${String(i)}`,
    manager ? 'manager' : 'bot',
    manager ? 'bot' : null,
    manager ? NOW - HOUR : null,
  );
  const lastMs = NOW - i * 3 * HOUR;
  for (let k = 0; k < MESSAGES_PER_CHAT; k += 1) {
    const tsMs = lastMs - (MESSAGES_PER_CHAT - 1 - k) * MIN;
    const author = (k + (i % 2 === 0 ? 1 : 0)) % 2 === 0 ? 'client' : 'bot';
    const waId = `W${String(i)}-${String(k)}`;
    s.message.run(i, waId, author, `сообщение ${String(k)}`, tsMs);
    if (author === 'bot') {
      s.outbound.run(waId, i, k === 1 && manager ? 'handoff_notice' : 'bot_reply', tsMs);
    }
  }
  if (manager) s.handoff.run(i, NOW - HOUR);
  if (i % 10 === 0) {
    db.prepare(`UPDATE chats SET interest_level = 'hot' WHERE id = ?`).run(i);
    s.hot.run(i, NOW);
  }
  if (i % 4 === 0) {
    s.company.run(i, JSON.stringify({ confirmed: { id: i, name: `ТОО ${String(i)}` } }), NOW);
  }
}

function seed(db: Database.Database): void {
  const statements = statementsOf(db);
  db.transaction(() => {
    for (let i = 1; i <= CHATS; i += 1) seedChat(db, statements, i);
  })();
}

/** Замер в вывод теста (видно с --silent=false): сколько запаса до 100 мс. */
function report(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Время работы в мс: лучшее из трёх запусков; первый ещё и готовит запросы. */
function timeOf(work: () => unknown): number {
  const times = [0, 1, 2].map(() => {
    const started = performance.now();
    work();
    return performance.now() - started;
  });
  return Math.round(Math.min(...times) * 100) / 100;
}

/** Как маршрут списка чатов: число и страница одной транзакцией. */
function chatPage(reads: ConsoleReads, filter: ConsoleChatFilter) {
  return reads.readTransaction(() => ({
    total: reads.countChats(filter),
    rows: reads.listChats(filter, PAGE),
  }));
}

/** Как маршрут «Требует внимания»: все списки и числа одной транзакцией. */
function attention(reads: ConsoleReads) {
  return reads.readTransaction(() => ({
    handoffs: reads.openHandoffs(ATTENTION_LIMIT),
    hot: reads.hotChats(ATTENTION_LIMIT),
    waiting: reads.waitingChats(NOW, ATTENTION_LIMIT),
    backlog: reads.pendingBacklogCount(),
    counts: reads.attentionCounts(NOW),
  }));
}

describe('выборки консоли: скорость на 500 чатах по 50 сообщений', () => {
  // Одна база на весь файл: стенд заполняется один раз.
  const db = openDatabase(':memory:');
  runMigrations(db);
  seed(db);
  const reads = createConsoleReads(db);
  afterAll(() => {
    db.close();
  });
  const filters: Readonly<Record<string, ConsoleChatFilter>> = {
    список: { nowMs: NOW },
    'ждут ответа': { nowMs: NOW, waitingOnly: true },
    'поиск по имени': { nowMs: NOW, search: { nameVariants: ['алия 1'], digits: null } },
    компания: { nowMs: NOW, company: 'confirmed' },
    'чаты у бота': { nowMs: NOW, status: 'bot' },
  };

  it('данные стенда: 500 чатов, 25 000 сообщений, ждущие и старше 30 дней', () => {
    const page = chatPage(reads, { nowMs: NOW });
    const data = attention(reads);

    expect(page.total).toBe(CHATS);
    expect(page.rows).toHaveLength(PAGE.limit);
    expect(db.prepare('SELECT count(*) FROM messages').pluck().get()).toBe(
      CHATS * MESSAGES_PER_CHAT,
    );
    expect(data.counts.waiting).toBeGreaterThan(0);
    expect(data.counts.staleWaiting).toBeGreaterThan(0);
    expect(data.waiting).toHaveLength(data.counts.waiting);
    expect(data.hot).toHaveLength(CHATS / 10);
  });

  it.each(Object.entries(filters))(
    'список чатов «%s»: число и страница быстрее 100 мс',
    (name, filter) => {
      const ms = timeOf(() => chatPage(reads, filter));

      report(`Список чатов «${name}»: ${String(ms)} мс`);
      expect(ms).toBeLessThan(BUDGET_MS);
    },
  );

  it('«Требует внимания»: все списки и числа быстрее 100 мс', () => {
    const ms = timeOf(() => attention(reads));

    report(`«Требует внимания»: ${String(ms)} мс`);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});
