import type { HandoffNotice, StoredMessage } from '../domain/types.js';
import { hotKindOf, type HotKind, type TurnSituation } from './handoff-gate.js';

/** Почему код передаёт чат: причины hot (pipeline/handoff-gate.ts) и исходы ответа, которые передают чат сразу. */
export type HandoffWhy = HotKind | 'asked_human' | 'complaint' | 'no_answer';

/** Причина своими словами (решение владельца 30.10.2026): её видят панель и уведомление менеджеру. */
const REASON_TEXT: Readonly<Record<HandoffWhy, string>> = {
  final: 'Всё для расчёта известно, клиент готов к расчёту.',
  price: 'Спрашивает цену, сроки или договор, задача понятна.',
  price_third: 'Третий раз спрашивает цену.',
  refused: 'Дважды подряд уходит от вопросов.',
  asked_human: 'Просит живого человека.',
  complaint: 'Жалуется.',
  no_answer: 'Ответа нет в документах.',
};

/**
 * Почему чат уходит коллеге, по поводу передачи: у hot причина хода (handoff-gate.hotKindOf; её нет только у раннего hot,
 * который чат не передаёт, тогда финал), просьба о человеке, жалоба и «нет ответа» как есть. Технические поводы
 * (check_failed, llm_error) => null: причину как раньше пишет оценка интереса.
 */
export function handoffWhyOf(
  reason: HandoffNotice['reason'],
  situation: TurnSituation,
): HandoffWhy | null {
  switch (reason) {
    case 'hot':
      // Ранний hot (причины нет) чат не передаёт и сюда не доходит; «финал» только запасной ответ на случай рассинхрона.
      return hotKindOf(situation) ?? 'final';
    case 'asked_human':
    case 'complaint':
    case 'no_answer':
      return reason;
    default:
      return null;
  }
}

/** Длина цитаты клиента в причине, в символах Unicode, с многоточием. */
export const QUOTE_MAX_LENGTH = 150;

const ELLIPSIS = '…';

/** Пробелы всех видов и переводы строк (в том числе NEL, U+2028 и U+2029). */
const SPACES = /[\s\u0085]+/gu;

/** Управляющие, невидимые (Cf: нулевая ширина, смена направления), одиночные суррогаты, неназначенные; угловые скобки. */
const UNSAFE = /[\p{C}<>]/gu;

/** Последний по времени текст клиента в окне истории; нет => null. */
function lastClientText(history: readonly StoredMessage[]): string | null {
  const sorted = [...history].sort((a, b) => a.tsMs - b.tsMs || a.id - b.id);
  return sorted.findLast((item) => item.author === 'client' && item.text !== null)?.text ?? null;
}

/** Обрезка до QUOTE_MAX_LENGTH символов по последнему пробелу (одно длинное слово режется по символам). */
function cutByWord(text: string): string {
  const symbols = [...text];
  if (symbols.length <= QUOTE_MAX_LENGTH) return text;
  const head = symbols.slice(0, QUOTE_MAX_LENGTH - 1).join('');
  const space = head.lastIndexOf(' ');
  const kept = space > 0 ? head.slice(0, space) : head;
  return `${kept.trimEnd()}${ELLIPSIS}`;
}

/**
 * Цитата последнего сообщения клиента: NFKC (полноширинные скобки становятся обычными), одна строка, без угловых
 * скобок, управляющих и невидимых символов, не длиннее QUOTE_MAX_LENGTH с обрезкой по слову. Текста нет или после
 * чистки пусто => null.
 */
export function clientQuote(history: readonly StoredMessage[]): string | null {
  const text = lastClientText(history);
  if (text === null) return null;
  const line = text
    .normalize('NFKC')
    .replace(SPACES, ' ')
    .replace(UNSAFE, '')
    .replace(/ {2,}/gu, ' ')
    .trim();
  return line === '' ? null : cutByWord(line);
}

/**
 * Причина передачи для панели и уведомления менеджеру: текст по причине и цитата последнего сообщения клиента
 * («Клиент: «…»»); цитаты нет => только текст. Технические причины (check_failed, llm_error, limit) сюда не идут.
 */
export function handoffReasonText(why: HandoffWhy, history: readonly StoredMessage[]): string {
  const quote = clientQuote(history);
  return quote === null ? REASON_TEXT[why] : `${REASON_TEXT[why]} Клиент: «${quote}»`;
}
