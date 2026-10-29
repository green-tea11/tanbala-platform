import type Database from 'better-sqlite3';
import type { AppStateRepo } from '../../domain/ports.js';
import { assertTimeMs } from '../time.js';

/** Ключ момента привязки номера в app_state. */
const LINKED_AT_KEY = 'linked_at_ms';

/** Ключ флага «список чатов первой синхронизации не сохранился»: значение = момент первого сбоя. */
const HISTORY_INCOMPLETE_KEY = 'history_incomplete_at_ms';

/** Ключ границы рабочего режима (этап 8): момент последнего перехода TEST_MODE true => false. */
const WORKING_SINCE_KEY = 'working_since_ms';

/** Значение app_state: только цифры, без знака, точки и экспоненты. */
const DECIMAL_DIGITS = /^\d+$/;

/**
 * Состояние приложения в SQLite (таблица app_state, значения текстом): момент привязки номера, флаг неполной
 * истории и граница рабочего режима. Бот работает только с сообщениями, отправленными после привязки (решение
 * владельца). setLinkedAtMs пишет с перезаписью (INSERT ... ON CONFLICT DO UPDATE). Когда писать, решает
 * whatsapp/connection.ts: первая привязка и каждая новая (isNewLogin). markHistoryIncomplete сохраняет момент первого
 * сбоя (ON CONFLICT DO NOTHING). Границу рабочего режима пишет и снимает pipeline/working-mode.ts: setWorkingSinceMs
 * с перезаписью, clearWorkingSince удаляет строку. Испорченное значение в базе => явная ошибка: граница или флаг
 * неизвестны.
 */
export function createAppStateRepo(db: Database.Database): AppStateRepo {
  const selectValue = db
    .prepare<[string], string>('SELECT value FROM app_state WHERE key = ?')
    .pluck();
  const upsertValue = db.prepare<[string, string]>(
    `INSERT INTO app_state (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  );
  const insertIfAbsent = db.prepare<[string, string]>(
    'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING',
  );
  const deleteValue = db.prepare<[string]>('DELETE FROM app_state WHERE key = ?');
  const readMs = (key: string): number | null => {
    const stored = selectValue.get(key);
    return stored === undefined ? null : parseStoredMs(key, stored);
  };
  const writeMs = (key: string, ms: number): void => {
    assertTimeMs(ms, key);
    upsertValue.run(key, String(ms));
  };
  return {
    getLinkedAtMs: () => readMs(LINKED_AT_KEY),
    setLinkedAtMs(ms: number): void {
      writeMs(LINKED_AT_KEY, ms);
    },
    getHistoryIncomplete: () => readMs(HISTORY_INCOMPLETE_KEY),
    markHistoryIncomplete(atMs: number): void {
      assertTimeMs(atMs, HISTORY_INCOMPLETE_KEY);
      insertIfAbsent.run(HISTORY_INCOMPLETE_KEY, String(atMs));
    },
    getWorkingSinceMs: () => readMs(WORKING_SINCE_KEY),
    setWorkingSinceMs(ms: number): void {
      writeMs(WORKING_SINCE_KEY, ms);
    },
    clearWorkingSince: () => deleteValue.run(WORKING_SINCE_KEY).changes > 0,
  };
}

function parseStoredMs(key: string, stored: string): number {
  const value = Number(stored);
  if (!DECIMAL_DIGITS.test(stored) || !Number.isSafeInteger(value)) {
    throw new Error(`В app_state испорчено значение ${key}`);
  }
  return value;
}
