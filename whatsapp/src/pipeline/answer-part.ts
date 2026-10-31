import type { StoredMessage } from '../domain/types.js';

/** Признак вопроса в словах клиента: знак вопроса, вопросительное слово или просьба рассказать. */
const ASKS =
  /\?|(?<!\p{L})(?:как|какой|какая|какое|какие|каким|что|сколько|где|когда|зачем|почему|можно|ли|расскаж\p{L}*|подскаж\p{L}*|объясн\p{L}*)(?!\p{L})/iu;

/**
 * Спрашивает ли клиент что-то в сообщениях после последней реплики бота или менеджера: тогда ответ на это из черновика
 * остаётся в сообщении передачи, которую делает код. Без вопроса клиенту уходит только фраза передачи.
 */
export function clientAsksNow(history: readonly StoredMessage[]): boolean {
  const sorted = [...history].sort((a, b) => a.tsMs - b.tsMs || a.id - b.id);
  const lastOther = sorted.findLastIndex((message) => message.author !== 'client');
  return sorted
    .slice(lastOther + 1)
    .some((message) => message.text !== null && ASKS.test(message.text));
}

/** Предложение черновика, которое в сообщение передачи не идёт: вопрос, фраза об ориентире или цене, фраза передачи. */
const NOT_AN_ANSWER =
  /\?|ориентир|уточню у коллеги|цена сильно зависит|^понятно(?!\p{L})(?!\s+ли(?!\p{L}))/iu;

/**
 * Ответ из черновика answer для сообщения передачи, которую делает код: его утверждения без вопросов, фразы об ориентире и
 * фраз передачи. Ничего не осталось => null (клиенту уйдёт только фраза передачи).
 */
export function answerPartOf(text: string): string | null {
  const kept = text
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '' && !NOT_AN_ANSWER.test(sentence));
  return kept.length === 0 ? null : kept.join(' ');
}
