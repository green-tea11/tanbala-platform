import type { ConversationContext } from '../agent/agent.js';
import type { StoredMessage } from '../domain/types.js';
import { MINIMUM_HANDOFF_TEXT } from '../handoff/minimum.js';
import { HOT_PRICE_HANDOFF_TEXT } from '../messaging/outbox.js';
import type { PriceSituation } from './price-gate.js';

/**
 * Почему ход кончается передачей hot, хотя клиент не спрашивал цену (решение владельца 29.10.2026 вечером): минимум для
 * передачи собран, а чат ещё ни разу не передавался менеджеру.
 */
export type AutoHandoff = 'minimum';

/**
 * Передача без вопроса цены, если она положена в этом ходе: только пока чат ни разу не передавался (по любой причине,
 * ChatProgress.handedOff). После возврата боту, с заметкой или без, действуют прежние правила: передача по цене, просьба о
 * человеке, отказ отвечать, жалоба, четвёртый вопрос цены. Минимум по выжимке из оценки этого хода (PriceSituation).
 */
export function autoHandoffOf(
  context: ConversationContext,
  price: PriceSituation,
): AutoHandoff | null {
  // Заметка для бота бывает только после возврата чата: значит, чат уже передавался.
  if (context.progress?.handedOff === true || context.note != null) return null;
  return price.minimum.missing.length === 0 ? 'minimum' : null;
}

/** Фраза передачи: при вопросе цены фраза о цене, иначе «Спасибо, этого хватит, чтобы коллега назвал ориентир...». */
export function autoHandoffPhrase(_kind: AutoHandoff, priceTurn: boolean): string {
  return priceTurn ? HOT_PRICE_HANDOFF_TEXT : MINIMUM_HANDOFF_TEXT;
}

/** Признак вопроса в словах клиента: знак вопроса, вопросительное слово или просьба рассказать. */
const ASKS =
  /\?|(?<!\p{L})(?:как|какой|какая|какое|какие|каким|что|сколько|где|когда|зачем|почему|можно|ли|расскаж\p{L}*|подскаж\p{L}*|объясн\p{L}*)(?!\p{L})/iu;

/**
 * Спрашивает ли клиент что-то в сообщениях после последней реплики бота или менеджера: тогда ответ на это из черновика
 * остаётся в сообщении передачи. Без вопроса клиенту уходит только фраза передачи.
 */
export function clientAsksNow(history: readonly StoredMessage[]): boolean {
  const sorted = [...history].sort((a, b) => a.tsMs - b.tsMs || a.id - b.id);
  const lastOther = sorted.findLastIndex((message) => message.author !== 'client');
  return sorted
    .slice(lastOther + 1)
    .some((message) => message.text !== null && ASKS.test(message.text));
}

/** Предложение черновика, которое в сообщение передачи не идёт: вопрос, фраза об ориентире или цене, фраза передачи. */
const NOT_AN_ANSWER = /\?|ориентир|уточню у коллеги|цена сильно зависит/iu;

/**
 * Ответ из черновика answer для сообщения передачи: его утверждения без вопросов, фразы об ориентире и фраз передачи.
 * Ничего не осталось => null (клиенту уйдёт только фраза передачи).
 */
export function answerPartOf(text: string): string | null {
  const kept = text
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '' && !NOT_AN_ANSWER.test(sentence));
  return kept.length === 0 ? null : kept.join(' ');
}
