import { normalizeName } from './normalize-name.js';

// Сказал ли бот клиенту о нашем письме (решение владельца 30.10.2026: «Мы писали вам на почту» один раз). Признак по
// предложениям: «писали» рядом с «вам», «вас» или «почта», либо «письмо» рядом с «вам», «ваш», «наш», «почта» или
// «получили». Одно «письменно» или «пишут на почту» не в счёт.

/** Граница предложений: знаки конца предложения. */
const SENTENCE_END = /[.!?…]+/u;

/** «писал», «писали», «написали», «писала». */
const WROTE = /^(?:на)?писал[аи]?$/u;

/** «письмо» во всех падежах, но не «письменно». */
const LETTER = /^письм(?:о|а|е|ом|у|ами|ах)?$/u;

/** Кому писали: клиенту. */
const TO_CLIENT: ReadonlySet<string> = new Set(['вам', 'вас']);

/** Основы слов рядом с «письмо»: «ваше письмо», «наше письмо», «на почту», «получили письмо». */
const LETTER_CONTEXT: readonly string[] = ['ваш', 'наш', 'почт', 'получ'];

function aboutOurEmail(words: readonly string[]): boolean {
  const toClient = words.some((word) => TO_CLIENT.has(word));
  if (words.some((word) => WROTE.test(word))) {
    return toClient || words.some((word) => word.startsWith('почт'));
  }
  if (!words.some((word) => LETTER.test(word))) return false;
  return toClient || words.some((word) => LETTER_CONTEXT.some((stem) => word.startsWith(stem)));
}

/**
 * В отправленном тексте бот сказал о нашем письме клиенту: хотя бы в одном предложении есть признак (см. выше). Текст
 * сравнивается без регистра, «ё» и знаков (normalizeName).
 */
export function mentionsOurEmail(text: string): boolean {
  return text
    .split(SENTENCE_END)
    .map((sentence) => normalizeName(sentence).split(' '))
    .some(aboutOurEmail);
}
