import { createHash } from 'node:crypto';
import type { Clock } from '../domain/ports.js';
import type { ChatId } from '../domain/types.js';

/** Окно двойной отправки формы в мс: тот же текст в тот же чат в течение 10 секунд считается повтором (решение владельца). */
export const DUPLICATE_REPLY_WINDOW_MS = 10_000;

/** Недавние ответы из панели: защита клиента от двойной отправки формы. Всё в памяти процесса. */
export interface RecentReplies {
  /**
   * Занимает ответ. true: такого текста в этот чат за последние DUPLICATE_REPLY_WINDOW_MS не было, ответ
   * записан, и повторный вызов с тем же текстом вернёт false. false: повтор, отправлять нельзя.
   * Отказ окно не продлевает: отсчёт идёт от принятого ответа.
   */
  claim(chatId: ChatId, text: string): boolean;
  /** Снимает отметку ответа, который не ушёл из-за сбоя: менеджер может сразу повторить. Лишний вызов безвреден. */
  release(chatId: ChatId, text: string): void;
  /** Сколько отметок хранится сейчас (устаревшие убираются при обращениях): для тестов и диагностики. */
  size(): number;
}

/**
 * Ключ отметки: ID чата и SHA-256 текста, сам текст в памяти не лежит. Пробелы по краям не считаются: в чат
 * уходит обрезанный текст (messaging/outbox.ts), значит, с другими пробелами по краям это тот же ответ.
 */
function keyOf(chatId: ChatId, text: string): string {
  const digest = createHash('sha256').update(text.trim(), 'utf8').digest('hex');
  return `${String(chatId)}:${digest}`;
}

/**
 * Создаёт память о недавних ответах. Ничего не запускает: записи старше DUPLICATE_REPLY_WINDOW_MS убираются при
 * обращениях, поэтому память держит только ответы последних секунд. Время берётся из часов панели.
 */
export function createRecentReplies(clock: Pick<Clock, 'now'>): RecentReplies {
  // Ключ отметки и время принятого ответа, мс. Отметки не меняются на месте: каждое обращение собирает новую таблицу.
  let claimed: ReadonlyMap<string, number> = new Map();
  const fresh = (): ReadonlyMap<string, number> => {
    const oldestAliveMs = clock.now() - DUPLICATE_REPLY_WINDOW_MS;
    return new Map([...claimed].filter(([, atMs]) => atMs > oldestAliveMs));
  };

  return {
    claim(chatId: ChatId, text: string): boolean {
      const alive = fresh();
      const key = keyOf(chatId, text);
      if (alive.has(key)) {
        claimed = alive;
        return false;
      }
      claimed = new Map<string, number>([...alive, [key, clock.now()]]);
      return true;
    },
    release(chatId: ChatId, text: string): void {
      const key = keyOf(chatId, text);
      claimed = new Map([...fresh()].filter(([claimedKey]) => claimedKey !== key));
    },
    size(): number {
      return claimed.size;
    },
  };
}
