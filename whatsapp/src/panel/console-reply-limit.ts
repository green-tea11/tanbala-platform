import type { Clock } from '../domain/ports.js';
import type { ChatId } from '../domain/types.js';

// Предел ответов клиентам из API консоли (старая панель его не касается): скользящий час в памяти процесса.
// Считаются только ушедшие ответы: место занимается до отправки и освобождается, если ответ не ушёл.

/** Ответов из консоли в один чат за скользящий час. */
export const CONSOLE_REPLIES_PER_CHAT_PER_HOUR = 20;
/** Ответов из консоли во все чаты за скользящий час. */
export const CONSOLE_REPLIES_PER_HOUR = 100;
const HOUR_MS = 60 * 60_000;

export const REPLY_LIMIT_TEXTS = {
  chat: `Из консоли в этот чат уже отправлено ${CONSOLE_REPLIES_PER_CHAT_PER_HOUR} ответов за последний час: подождите или ответьте с телефона.`,
  total: `Из консоли уже отправлено ${CONSOLE_REPLIES_PER_HOUR} ответов за последний час: подождите или ответьте с телефона.`,
} as const;

/** Занятое место: снять, если ответ не ушёл. */
export interface ReplySlot {
  release(): void;
}

/** Место занято или причина отказа (текст для менеджера). */
export type ReplySlotResult =
  | { readonly kind: 'taken'; readonly slot: ReplySlot }
  | { readonly kind: 'limited'; readonly message: string };

export interface ReplyRateLimit {
  /** Занимает место для ответа в чат сейчас; предел исчерпан => limited, ничего не занято. */
  take(chatId: ChatId): ReplySlotResult;
}

interface Entry {
  readonly chatId: ChatId;
  readonly atMs: number;
}

/**
 * Скользящее окно в памяти: CONSOLE_REPLIES_PER_CHAT_PER_HOUR в один чат и CONSOLE_REPLIES_PER_HOUR во все. Записей не
 * больше общего предела, старше часа отбрасываются при каждом обращении. take синхронный: из одновременных запросов
 * сверх предела не проходит ни один. После перезапуска бота счёт начинается заново.
 */
export function createReplyRateLimit(clock: Pick<Clock, 'now'>): ReplyRateLimit {
  let entries: readonly Entry[] = [];
  return {
    take(chatId: ChatId): ReplySlotResult {
      const nowMs = clock.now();
      entries = entries.filter((entry) => nowMs - entry.atMs < HOUR_MS);
      if (entries.length >= CONSOLE_REPLIES_PER_HOUR) {
        return { kind: 'limited', message: REPLY_LIMIT_TEXTS.total };
      }
      const inChat = entries.filter((entry) => entry.chatId === chatId).length;
      if (inChat >= CONSOLE_REPLIES_PER_CHAT_PER_HOUR) {
        return { kind: 'limited', message: REPLY_LIMIT_TEXTS.chat };
      }
      const taken: Entry = { chatId, atMs: nowMs };
      entries = [...entries, taken];
      return {
        kind: 'taken',
        slot: {
          release: () => {
            entries = entries.filter((entry) => entry !== taken);
          },
        },
      };
    },
  };
}
