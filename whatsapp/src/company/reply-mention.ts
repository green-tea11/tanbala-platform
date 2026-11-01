import { shortCompanyName } from './name-match.js';
import { normalizeName } from './normalize-name.js';

/**
 * Как отправленный текст бота говорит о кандидате: none (названия нет), mentioned (название есть, но не в вопросе
 * о компании) или asked (вопрос «Вы из компании X?»).
 */
export type ReplyMention = 'none' | 'mentioned' | 'asked';

/**
 * Граница предложений: пробел после знака конца (. ! ? …) и, возможно, закрывающих кавычек или скобок. Точка внутри
 * слова («А.Б») границей не считается.
 */
const SENTENCE_BREAK = /(?<=[.!?…]["'»“”)\]]*)\s+/u;

/** Предложение-вопрос: после последнего «?» нет ни букв, ни цифр (только кавычки, скобки и знаки). */
const ENDS_WITH_QUESTION = /\?[^\p{L}\p{N}]*$/u;

/** Слова вопроса-подтверждения («Вы из компании X, правильно?», «X, Алматы, верно?») после нормализации. */
const CONFIRM_WORDS: readonly string[] = ['правильно', 'верно', 'вы из'];

/** В нормализованном тексте есть слова wanted целиком (wanted уже нормализован и не пуст). */
function hasWords(normalizedText: string, wanted: string): boolean {
  return ` ${normalizedText} `.includes(` ${wanted} `);
}

/**
 * Предложение спрашивает о кандидате: кончается вопросом и содержит его название. Название из одного слова («Склад»,
 * «RFID») бот говорит и о другом («Как вы ведёте учёт без RFID?»), поэтому для него в вопросе нужно ещё слово
 * подтверждения: иначе «да» на чужой вопрос подтвердило бы компанию.
 */
function asksAbout(sentence: string, normalized: string, wanted: string): boolean {
  if (!ENDS_WITH_QUESTION.test(sentence)) return false;
  if (wanted.includes(' ')) return true;
  return CONFIRM_WORDS.some((word) => hasWords(normalized, word));
}

/**
 * Название кандидата в отправленном тексте ищется по предложениям, целыми словами, без регистра, кавычек и форм
 * собственности, без хвоста карточки 2ГИС после запятой: так бот его и называет (shortCompanyName, пункт 5 задания
 * 01.11.2026). Название в предложении-вопросе: asked; в любом другом месте: mentioned. Название из одних форм
 * собственности или пустое ни с чем не совпадает.
 */
export function candidateInReply(text: string, name: string): ReplyMention {
  const wanted = normalizeName(shortCompanyName(name));
  if (wanted === '') return 'none';
  const withName = text
    .trim()
    .split(SENTENCE_BREAK)
    .map((sentence) => ({ sentence, normalized: normalizeName(sentence) }))
    .filter(({ normalized }) => hasWords(normalized, wanted));
  if (withName.length === 0) return 'none';
  const asked = withName.some(({ sentence, normalized }) =>
    asksAbout(sentence, normalized, wanted),
  );
  return asked ? 'asked' : 'mentioned';
}
