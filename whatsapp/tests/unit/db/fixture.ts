import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { onTestFinished } from 'vitest';
import { openDatabase } from '../../../src/db/connection.js';
import { runMigrations } from '../../../src/db/migrations.js';
import type { ChatId, ClientProfile, Jid } from '../../../src/domain/types.js';

// Адреса только фиктивные: номера вида 7700000000N и @lid без реальных людей.
export const PN_A = '77000000001@s.whatsapp.net' as Jid;
export const LID_A = '100000000000001@lid' as Jid;
export const PN_B = '77000000002@s.whatsapp.net' as Jid;
export const LID_B = '100000000000002@lid' as Jid;

/** Выжимка, в которой ничего не выяснили. */
export const EMPTY_PROFILE: ClientProfile = {
  business: null,
  area: null,
  scope: null,
  itemCount: null,
  has1C: null,
  oneCName: null,
  problem: null,
  specifics: null,
  problemAgreed: false,
};

/** Заполненная выжимка; overrides меняют отдельные поля. */
export function profileOf(overrides: Partial<ClientProfile> = {}): ClientProfile {
  return {
    business: 'Магазин одежды',
    area: '300 м²',
    scope: 'где лежит каждая вещь',
    itemCount: 'около 5000 вещей',
    has1C: true,
    oneCName: '1С:Управление торговлей',
    problem: 'пересорт при приёмке',
    specifics: 'два склада',
    problemAgreed: true,
    ...overrides,
  };
}

/** Временная папка в os.tmpdir(): после теста выполняет отложенную очистку и удаляет себя. */
export interface TempDir {
  readonly path: string;
  /** Запоминает базу, чтобы закрыть её до удаления папки: на Windows открытый файл не удалить. */
  track(db: Database.Database): Database.Database;
  /** Очистка после теста до удаления папки, в обратном порядке: снять замок, завершить процесс. */
  defer(cleanup: () => void): void;
}

export function useTempDir(): TempDir {
  const path = mkdtempSync(join(tmpdir(), 'tanbala-db-test-'));
  const cleanups: (() => void)[] = [];
  onTestFinished(() => {
    try {
      for (const cleanup of cleanups.toReversed()) cleanup();
    } finally {
      // Повторы: Windows отпускает файл завершённого процесса не мгновенно.
      rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
  const defer = (cleanup: () => void): void => {
    cleanups.push(cleanup);
  };
  return {
    path,
    track(db) {
      defer(() => {
        if (db.open) db.close();
      });
      return db;
    },
    defer,
  };
}

/** База в памяти без схемы; закрывается после теста. */
export function useMemoryDb(): Database.Database {
  const db = openDatabase(':memory:');
  onTestFinished(() => {
    if (db.open) db.close();
  });
  return db;
}

/** База в памяти со схемой текущей версии: у каждого теста своя. */
export function useMigratedDb(): Database.Database {
  const db = useMemoryDb();
  runMigrations(db);
  return db;
}

/** Чат для тестов, которым нужен только chat_id, имя и номер. */
export interface ChatSeed {
  readonly replyJid: Jid;
  readonly lidJid?: Jid | null;
  readonly pnJid?: Jid | null;
  readonly phone?: string | null;
  readonly pushName?: string | null;
}

/** Создаёт чат напрямую через SQL, в обход репозитория чатов. */
export function insertChat(db: Database.Database, seed: ChatSeed): ChatId {
  const row = db
    .prepare<[string, string | null, string | null, string | null, string | null], { id: number }>(
      `INSERT INTO chats (reply_jid, lid_jid, pn_jid, phone, push_name, created_at)
       VALUES (?, ?, ?, ?, ?, 0) RETURNING id`,
    )
    .get(
      seed.replyJid,
      seed.lidJid ?? null,
      seed.pnJid ?? null,
      seed.phone ?? null,
      seed.pushName ?? null,
    );
  if (row === undefined) throw new Error('Чат не создан');
  return row.id as ChatId;
}

/** Ошибка, которой упала функция; undefined, если не упала. */
export function errorOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}
