import type { NormalizedText, PhoneDigits } from '../domain/types.js';
import {
  AI_MENTION_PATTERNS,
  ALLOWED_CAPS,
  ALLOWED_LINK_HOSTS,
  BRACKET_PATTERN,
  CAPS_PATTERN,
  COMBINING_MARK_PATTERN,
  CONTEXT_CHARS,
  CYRILLIC_LETTER,
  DASH_PATTERNS,
  EMAIL_PATTERN,
  EMOJI_PATTERN,
  EXCLAMATIONS_PATTERN,
  FOREIGN_DIGIT_PATTERN,
  FOREIGN_LETTER_PATTERN,
  INVISIBLE_EXCEPT_NEWLINE,
  INVISIBLE_PATTERN,
  JARGON_ALWAYS_PATTERNS,
  JARGON_TERM_PATTERNS,
  LATIN_LETTER,
  LETTER_RUN_PATTERN,
  LINK_PATTERN,
  LINK_TAIL,
  LIST_PATTERN,
  MARKUP_PATTERNS,
  MAX_CHARS,
  MAX_FRAGMENT_CHARS,
  MAX_SENTENCES,
  PHONE_COMPARE_DIGITS,
  PHONE_PATTERN,
  PRICE_PATTERNS,
  SENTENCE_END,
  STOP_PATTERNS,
  VOICE_PATTERNS,
} from './rules.js';

// Бесплатные проверки ответа кодом (шаг 4 плана). Перенос docs/reference/checks.py (B-web-email):
// тире, цены, стоп-слова, ссылки, скобки, жаргон, стиль, контакты. Длина письма 5–8 предложений,
// подпись и тема письма не перенесены: в чате не больше трёх коротких предложений.

/** Вид нарушения: попадает в развилку решений и в замечания модели при повторе. */
export type CheckCode =
  | 'dash'
  | 'price'
  | 'stop_word'
  | 'link'
  | 'brackets'
  | 'jargon'
  | 'emoji'
  | 'exclamations'
  | 'caps'
  | 'ai_mention'
  | 'markup'
  | 'list'
  | 'contact'
  | 'too_long'
  | 'empty'
  | 'homoglyph'
  | 'voice';

/** Одно нарушение: код и понятное описание с фрагментом текста. */
export interface CheckFinding {
  readonly code: CheckCode;
  readonly detail: string;
}

/** Что нужно проверкам, кроме самого ответа. */
export interface CheckOptions {
  /** Наш номер WhatsApp: любой другой номер в ответе запрещён. */
  readonly ownPhone: PhoneDigits;
  /** Текст сообщений клиента: технические термины, которые он написал сам, разрешены. */
  readonly clientText: string;
  /**
   * Название компании клиента (кандидат или подтверждённая, из блока о компании): в нём тире, ссылка, капслок и
   * прочий стиль, подмена букв и чужие цифры не нарушение, как термины клиента в проверке жаргона, если название стоит
   * отдельно, а не внутри адреса, почты или другого слова (maskCompanyName). Цены, стоп-слова, жаргон, скобки,
   * разметка, контакты и длина проверяются по всему тексту. Нет поля или null: названия нет.
   */
  readonly companyName?: string | null;
}

/** Чем заменяется название компании клиента перед проверками формы: слово без тире, ссылки, капслока и латиницы. */
const COMPANY_PLACEHOLDER = 'Компания';

/** Знаки синтаксиса регулярных выражений: в названии экранируются, оно ищется как текст. */
const REGEX_SYNTAX = /[\\^$.*+?()[\]{}|/]/gu;

/** Что может стоять вплотную перед названием компании: открывающие кавычки и скобка. */
const NAME_OPENERS = '«"\'(';

/** Без флага g: только для test(). */
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

// Половинка суррогатной пары на краю среза: такой текст API может не принять (без флага u: по кодовым единицам).
const LONE_SURROGATE_AT_EDGES = /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g;

function findAll(text: string, pattern: RegExp): RegExpExecArray[] {
  return [...text.matchAll(pattern)];
}

/** Срез без половинок суррогатных пар на краях: эмодзи не режется пополам. */
function sliceWhole(text: string, start: number, end: number): string {
  return text.slice(start, end).replace(LONE_SURROGATE_AT_EDGES, '');
}

function oneLine(text: string): string {
  return text.trim().replace(/\s+/gu, ' ');
}

function fragmentOf(match: RegExpExecArray): string {
  const fragment = oneLine(match[0]);
  return fragment.length > MAX_FRAGMENT_CHARS
    ? `${sliceWhole(fragment, 0, MAX_FRAGMENT_CHARS)}…`
    : fragment;
}

/** Найденный фрагмент с небольшим контекстом, в одну строку. */
function snippetOf(text: string, match: RegExpExecArray): string {
  const start = Math.max(0, match.index - CONTEXT_CHARS);
  const matchEnd = match.index + Math.min(match[0].length, MAX_FRAGMENT_CHARS);
  const end = Math.min(text.length, matchEnd + CONTEXT_CHARS);
  return oneLine(sliceWhole(text, start, end));
}

function scan(
  text: string,
  patterns: readonly RegExp[],
  code: CheckCode,
  reason: string,
): CheckFinding[] {
  return patterns.flatMap((pattern) =>
    findAll(text, pattern).map((match) => ({
      code,
      detail: `${reason}: «${fragmentOf(match)}» в «…${snippetOf(text, match)}…»`,
    })),
  );
}

/** Нижний регистр и «ё» => «е», чтобы словари не зависели от написания. */
function normalize(text: string): string {
  return text.toLowerCase().replaceAll('ё', 'е');
}

/** Последние цифры номера: +7, 8 и номер без кода страны сравниваются одинаково. */
function phoneKey(phone: string): string {
  return phone.replace(/\P{Nd}/gu, '').slice(-PHONE_COMPARE_DIGITS);
}

function trimLinkTail(link: string): string {
  let end = link.length;
  while (end > 0 && LINK_TAIL.includes(link.charAt(end - 1))) {
    end -= 1;
  }
  return link.slice(0, end);
}

function linkHost(link: string): string {
  const host = trimLinkTail(link)
    .toLowerCase()
    .replace(/^https?:\/\//u, '')
    .replace(/[/?#].*$/su, '');
  return host.startsWith('www.') ? host.slice(4) : host;
}

/** Нет тире: «—», «–», «―», «−», «‒» и дефис между пробелами. Дефис в слове можно. */
export function checkDashes(text: string): readonly CheckFinding[] {
  return scan(text, DASH_PATTERNS, 'dash', 'тире');
}

/** Нет цен: суммы с валютой, валюта и проценты словами, «%», «сэкономите», число рядом с «цена». */
export function checkPrices(text: string): readonly CheckFinding[] {
  return scan(text, PRICE_PATTERNS, 'price', 'цена');
}

/** Нет запрещённых слов раздела 11 документа, казахских стоп-слов и обещаний времени ответа и сроков. */
export function checkStopWords(text: string): readonly CheckFinding[] {
  return scan(normalize(text), STOP_PATTERNS, 'stop_word', 'стоп-слово');
}

const VOICE_REASON =
  'один голос: говори «коллега», а не «специалист», и не обещай, что напишет другой человек, а пиши «Уточню у коллеги и вернусь к вам»';

/** Один голос (решение владельца 29.10.2026): без «специалист» и без «он вам напишет», «свяжется», «позвонит». */
export function checkVoice(text: string): readonly CheckFinding[] {
  return scan(normalize(text), VOICE_PATTERNS, 'voice', VOICE_REASON);
}

/** Нет ссылок: в чате их не присылают совсем. Почта не ссылка. Белый список хостов пуст по умолчанию. */
export function checkLinks(
  text: string,
  allowedHosts: ReadonlySet<string> = ALLOWED_LINK_HOSTS,
): readonly CheckFinding[] {
  const withoutEmails = text.replace(EMAIL_PATTERN, ' ');
  return findAll(withoutEmails, LINK_PATTERN)
    .filter((match) => !allowedHosts.has(linkHost(match[0])))
    .map((match) => ({ code: 'link', detail: `ссылка: «${trimLinkTail(match[0])}»` }));
}

/** Нет квадратных скобок: заметки «[Проверить: …]» и заготовки «[имя]» не уходят клиенту никогда. */
export function checkBrackets(text: string): readonly CheckFinding[] {
  return findAll(text, BRACKET_PATTERN).map((match) => ({
    code: 'brackets',
    detail: `квадратные скобки: «${fragmentOf(match)}»`,
  }));
}

/** Нет жаргона, единиц, брендов и моделей. Технический термин, который клиент написал сам, разрешён. */
export function checkJargon(text: string, clientText: string): readonly CheckFinding[] {
  const forbiddenTerms = JARGON_TERM_PATTERNS.filter(
    (pattern) => findAll(clientText, pattern).length === 0,
  );
  return scan(text, [...forbiddenTerms, ...JARGON_ALWAYS_PATTERNS], 'jargon', 'жаргон');
}

/** Без смайликов, «!!», капслока (кроме RFID, ТОО, БИН, ИИН) и упоминаний, что пишет программа. */
export function checkStyle(text: string): readonly CheckFinding[] {
  const caps: CheckFinding[] = findAll(text, CAPS_PATTERN)
    .filter((match) => !ALLOWED_CAPS.has(match[0]))
    .map((match) => ({ code: 'caps', detail: `капслок: «${fragmentOf(match)}»` }));
  return [
    ...scan(text, [EMOJI_PATTERN], 'emoji', 'смайлик'),
    ...scan(text, [EXCLAMATIONS_PATTERN], 'exclamations', 'несколько «!» подряд'),
    ...caps,
    ...scan(text, AI_MENTION_PATTERNS, 'ai_mention', 'упоминание, что пишет программа'),
  ];
}

/** Сверх образца: без разметки WhatsApp (*жирный*, _курсив_, ~зачёркнутый~, `моно`) и списков. */
export function checkMarkup(text: string): readonly CheckFinding[] {
  return [
    ...scan(text, MARKUP_PATTERNS, 'markup', 'разметка WhatsApp'),
    ...scan(text, [LIST_PATTERN], 'list', 'список'),
  ];
}

/**
 * Только наш номер WhatsApp: чужой номер или ссылка wa.me могли прийти из текста клиента.
 * Отличие от образца: почта в WhatsApp тоже запрещена (в письмах она разрешалась).
 */
export function checkContacts(text: string, ownPhone: PhoneDigits): readonly CheckFinding[] {
  const own = phoneKey(ownPhone);
  const phones: CheckFinding[] = findAll(text, PHONE_PATTERN)
    .filter((match) => phoneKey(match[0]) !== own)
    .map((match) => ({ code: 'contact', detail: `чужой номер: «${fragmentOf(match)}»` }));
  const emails: CheckFinding[] = findAll(text, EMAIL_PATTERN).map((match) => ({
    code: 'contact',
    detail: `почта: «${fragmentOf(match)}»`,
  }));
  return [...phones, ...emails];
}

/**
 * Сверх образца: нет букв не из кириллицы и латиницы, комбинируемых знаков, чужих цифр, смешанных слов
 * и невидимых символов (они остаются, только если конвейер не вызвал normalizeDraft).
 */
export function checkHomoglyphs(text: string): readonly CheckFinding[] {
  const mixedWords: CheckFinding[] = findAll(text, LETTER_RUN_PATTERN)
    .filter((match) => CYRILLIC_LETTER.test(match[0]) && LATIN_LETTER.test(match[0]))
    .map((match) => ({
      code: 'homoglyph',
      detail: `слово из кириллицы и латиницы: «${fragmentOf(match)}»`,
    }));
  return [
    ...scan(text, [FOREIGN_LETTER_PATTERN], 'homoglyph', 'буква не из кириллицы и латиницы'),
    ...scan(text, [COMBINING_MARK_PATTERN], 'homoglyph', 'комбинируемый знак'),
    ...scan(text, [FOREIGN_DIGIT_PATTERN], 'homoglyph', 'цифра не из набора 0123456789'),
    ...scan(text, [INVISIBLE_PATTERN], 'homoglyph', 'невидимый символ'),
    ...mixedWords,
  ];
}

/**
 * Подготовка ответа модели к проверкам (этап 4, перед runCodeChecks): NFKC и удаление невидимых
 * и управляющих символов, кроме переноса строки. Иначе «бес­платно» прячется от словаря.
 */
export function normalizeDraft(text: string): NormalizedText {
  return text.normalize('NFKC').replace(INVISIBLE_EXCEPT_NEWLINE, '') as NormalizedText;
}

/** Число предложений: «1.5», «т.д.», сокращения и строчная буква после точки не делят предложение. */
export function countSentences(text: string): number {
  return text.split(SENTENCE_END).filter((part) => part.trim() !== '').length;
}

/** Не больше трёх предложений и 300 знаков на сообщение. */
export function checkLength(text: string): readonly CheckFinding[] {
  const findings: CheckFinding[] = [];
  const sentences = countSentences(text);
  if (sentences > MAX_SENTENCES) {
    findings.push({
      code: 'too_long',
      detail: `предложений: ${sentences}, можно не больше ${MAX_SENTENCES}`,
    });
  }
  const chars = [...text.trim()].length;
  if (chars > MAX_CHARS) {
    findings.push({ code: 'too_long', detail: `знаков: ${chars}, можно не больше ${MAX_CHARS}` });
  }
  return findings;
}

/** Знаки как класс регулярного выражения: знаки синтаксиса экранируются (с флагом u это допустимо). */
function charClass(chars: string): string {
  return `[${chars.replace(REGEX_SYNTAX, '\\$&')}]`;
}

/** Слева от названия начало текста или пробел, затем, может быть, открывающие кавычки или скобка. */
const NAME_ALONE_BEFORE = String.raw`(?<=(?:^|\s)${charClass(NAME_OPENERS)}*)`;

/** Справа от названия, может быть, знаки конца из LINK_TAIL, а за ними пробел или конец текста. */
const NAME_ALONE_AFTER = String.raw`(?=${charClass(LINK_TAIL)}*(?:\s|$))`;

/**
 * Название компании клиента в тексте заменяется словом-заглушкой: без учёта регистра, пробелы между словами названия
 * любые (до пяти), название готовится как ответ (normalizeDraft). Маскируется только название, которое стоит
 * отдельно: вплотную слева от него ничего, кроме открывающих кавычек и скобки «"'(, а справа до пробела или конца
 * текста только знаки .,;:!?)»"' (NAME_ALONE_BEFORE, NAME_ALONE_AFTER). Поэтому «Вы из компании Kaspi.kz, правильно?»
 * не нарушение ссылки, а название внутри адреса или почты не прячет их: «kaspi.kz/pay», «kaspi.kz?x=1»,
 * «kaspi.kz:8080», «kaspi.kz.evil.com», «pay.kaspi.kz», «evil-shop.kz», «https://kaspi.kz», «pay@kaspi.kz» и
 * «evil.shop» при названии «Shop» проверяются целиком. Название внутри другого слова тоже не маскируется.
 * Названия нет или в нём нет ни буквы, ни цифры (иначе отдельное тире стало бы «названием») => текст как есть.
 */
function maskCompanyName(text: string, name: string | null | undefined): string {
  const words = normalizeDraft(name ?? '')
    .split(/\s+/u)
    .filter((word) => word !== '');
  if (!words.some((word) => LETTER_OR_DIGIT.test(word))) return text;
  const source = words.map((word) => word.replace(REGEX_SYNTAX, '\\$&')).join(String.raw`\s{1,5}`);
  const pattern = new RegExp(`${NAME_ALONE_BEFORE}${source}${NAME_ALONE_AFTER}`, 'giu');
  return text.replace(pattern, COMPANY_PLACEHOLDER);
}

/**
 * Все проверки ответа клиенту. Текст заранее подготовлен normalizeDraft (бренд NormalizedText).
 * Тире, один голос, ссылки, стиль и подмена букв проверяются без названия компании клиента (options.companyName,
 * maskCompanyName), остальное по всему тексту. Пустой список: ответ можно отдавать на второй вызов (ревью).
 */
export function runCodeChecks(
  text: NormalizedText,
  options: CheckOptions,
): readonly CheckFinding[] {
  if (text.trim() === '') {
    return [{ code: 'empty', detail: 'пустой ответ' }];
  }
  const form = maskCompanyName(text, options.companyName);
  return [
    ...checkDashes(form),
    ...checkPrices(text),
    ...checkStopWords(text),
    ...checkVoice(form),
    ...checkLinks(form),
    ...checkBrackets(text),
    ...checkJargon(text, options.clientText),
    ...checkStyle(form),
    ...checkMarkup(text),
    ...checkContacts(text, options.ownPhone),
    ...checkHomoglyphs(form),
    ...checkLength(text),
  ];
}
