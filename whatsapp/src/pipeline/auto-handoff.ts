import type { ConversationContext } from '../agent/agent.js';
import type { StoredMessage } from '../domain/types.js';
import {
  CAP_HANDOFF_TEXT,
  CLIENT_MESSAGES_FOR_HANDOFF,
  MINIMUM_HANDOFF_TEXT,
} from '../handoff/minimum.js';
import { HOT_PRICE_HANDOFF_TEXT } from '../messaging/outbox.js';
import type { PriceSituation } from './price-gate.js';

/**
 * Почему ход кончается передачей hot, хотя клиент не спрашивал цену (решение владельца 29.10.2026 вечером), пока чат
 * ни разу не передавался менеджеру: minimum, если минимум для передачи собран; message_cap, если минимума нет, а клиент
 * написал уже пятое сообщение (больше пяти сообщений до передачи клиент писать не должен).
 */
export type AutoHandoff = 'minimum' | 'message_cap';

/** Сколько сообщений клиента в переписке (окно истории): с начала чата, передач в нём ещё не было. */
export function clientMessageCount(history: readonly StoredMessage[]): number {
  return history.filter((message) => message.author === 'client').length;
}

/**
 * Передача без вопроса цены, если она положена в этом ходе: только пока чат ни разу не передавался (по любой причине,
 * ChatProgress.handedOff). После возврата боту, с заметкой или без, действуют прежние правила: передача по цене, просьба о
 * человеке, отказ отвечать, жалоба, четвёртый вопрос цены. Минимум по выжимке из оценки этого хода (PriceSituation);
 * собранный минимум главнее предела сообщений. Сообщения клиента считаются в окне истории, в нём и текущая пачка.
 */
export function autoHandoffOf(
  context: ConversationContext,
  price: PriceSituation,
): AutoHandoff | null {
  // Заметка для бота бывает только после возврата чата: значит, чат уже передавался.
  if (context.progress?.handedOff === true || context.note != null) return null;
  if (price.minimum.missing.length === 0) return 'minimum';
  return clientMessageCount(context.history) >= CLIENT_MESSAGES_FOR_HANDOFF ? 'message_cap' : null;
}

/**
 * Фраза передачи: по минимуму всегда «Спасибо, этого хватит, чтобы коллега назвал ориентир...» (она же отвечает на вопрос
 * цены: живой прогон 29.10.2026 показал, что «Цена сильно зависит от объёма» перед ней звучит дважды); по пределу
 * сообщений при вопросе цены фраза о цене, иначе «Спасибо! Уточню у коллеги и вернусь к вам.».
 */
export function autoHandoffPhrase(kind: AutoHandoff, priceTurn: boolean): string {
  if (kind === 'minimum') return MINIMUM_HANDOFF_TEXT;
  return priceTurn ? HOT_PRICE_HANDOFF_TEXT : CAP_HANDOFF_TEXT;
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
const NOT_AN_ANSWER =
  /\?|ориентир|уточню у коллеги|цена сильно зависит|^понятно(?!\p{L})(?!\s+ли(?!\p{L}))/iu;

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
