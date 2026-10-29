import type { ClientProfile, ReviewedText } from '../domain/types.js';
import { ESTIMATE_LATER, type HandoffMinimum, type MinimumField } from '../handoff/minimum.js';

export { ESTIMATE_LATER } from '../handoff/minimum.js';

/** Поля квалификации клиента, о которых бот может спросить фиксированным вопросом: минимум и остальное. */
export type QuestionField =
  | MinimumField
  | 'business'
  | 'packaging'
  | 'area'
  | 'turnover'
  | 'currentTracking'
  | 'problem'
  | 'oneCName';

/**
 * Фиксированные вопросы клиенту без модели (решение 29.10.2026): один вопрос, без фактов о Tanbala, цен, сроков и
 * обещаний, поэтому проходят проверки кодом (это проверяют тесты) и к ReviewedText приводятся здесь, как проверенный
 * текст модели. Те же вопросы для модели в третьем лице: handoff/minimum.ts (QUESTIONS).
 */
export const SAFE_QUESTION_TEXTS: Readonly<Record<QuestionField, string>> = {
  items: 'Подскажите, какие вещи нужно учитывать?',
  material: 'Подскажите, из какого материала эти вещи: есть ли среди них металл или жидкости?',
  itemCount: 'Подскажите, сколько примерно вещей нужно учитывать?',
  premises: 'Подскажите, где хранятся вещи: склад, открытая площадка или магазин?',
  city: 'Подскажите, в каком городе ваш объект?',
  has1C: 'Подскажите, у вас есть 1С и какая?',
  company: 'Подскажите, как называется ваша компания?',
  business: 'Подскажите, чем занимается ваша компания?',
  packaging: 'Подскажите, как лежат вещи: в коробках, на паллетах или поштучно?',
  area: 'Подскажите, какая примерно площадь помещения?',
  turnover: 'Подскажите, как часто вещи приходят и уходят?',
  currentTracking: 'Подскажите, как вы сейчас ведёте учёт?',
  problem: 'Подскажите, что в нынешнем учёте мешает больше всего?',
  oneCName: 'Подскажите, какая у вас конфигурация 1С?',
};

/** Все поля с вопросами. */
export const QUESTION_FIELDS = Object.keys(SAFE_QUESTION_TEXTS) as readonly QuestionField[];

/** Фиксированный вопрос о поле; на ходу с вопросом цены перед ним фраза об ориентире. */
export function safeQuestion(field: QuestionField, aboutPrice: boolean): ReviewedText {
  const question = SAFE_QUESTION_TEXTS[field];
  return (aboutPrice ? `${ESTIMATE_LATER} ${question}` : question) as ReviewedText;
}

/**
 * Признаки вопроса о поле в тексте бота: по ним выбирается вопрос, которого не было в прошлом сообщении. Фиксированные
 * вопросы узнаются своими словами (это проверяют тесты); вопрос модели узнаётся, если в нём те же слова.
 */
const ASKED: Readonly<Record<QuestionField, RegExp>> = {
  items:
    /какие вещи|что (?:именно )?(?:нужно |хотите |вы хотите |будете )?учитывать|какой товар|какие товары|что храните|что за (?:вещи|товар)/iu,
  material: /материал|металл|жидкост|из чего сделан/iu,
  itemCount:
    /сколько[^?]{0,40}(?:вещей|позиций|товар|единиц|штук|наименований|sku|меток|предметов)/iu,
  premises: /помещени|площадк|где хранятся|где лежат|склад или|магазин или/iu,
  city: /город/iu,
  has1C: /(?:есть|используете|работаете|ведёте|ведете)[^?]{0,20}1\s?[сc](?!\p{L})/iu,
  oneCName: /конфигурац|какая[^?]{0,20}1\s?[сc](?!\p{L})|1\s?[сc] и какая/iu,
  company:
    /компани(?:я|и|ю)?[^?]{0,30}(?:называ|правильно|верно)|из какой[^?]{0,20}компани|из компании|как называется ваша/iu,
  business: /чем занимает|какой у вас бизнес|чем вы занимаетесь/iu,
  packaging: /коробк|паллет|поштучн|упаков|как лежат/iu,
  area: /площад[ьи](?!\p{L})|сколько квадрат|какая[^?]{0,20}площадь/iu,
  turnover: /как часто|приходят и уходят|оборот/iu,
  currentTracking:
    /как (?:вы )?(?:сейчас )?(?:ведёте|ведете) учёт|как (?:вы )?сейчас учитываете|ведёте учёт|ведете учет/iu,
  problem: /мешает|трудност|проблем|как у вас с этим/iu,
};

/** Предложения-вопросы текста: только они спрашивают. */
function questionsOf(text: string): readonly string[] {
  return text.split(/(?<=[.!?])\s+/u).filter((sentence) => sentence.includes('?'));
}

/** О каких полях спрашивает текст бота (только его предложения с вопросом). */
export function askedFields(text: string): ReadonlySet<QuestionField> {
  const questions = questionsOf(text);
  return new Set(
    QUESTION_FIELDS.filter((field) => questions.some((question) => ASKED[field].test(question))),
  );
}

/** Остальное, о чём бот спрашивает, когда минимум собран (решение владельца 29.10.2026: по возможности). */
const OPTIONAL_FIELDS: readonly Exclude<QuestionField, MinimumField>[] = [
  'business',
  'packaging',
  'area',
  'turnover',
  'currentTracking',
  'problem',
  'oneCName',
];

/** Не выяснено ли необязательное поле; конфигурацию 1С спрашивают, только если 1С есть. */
function optionalMissing(profile: ClientProfile, field: (typeof OPTIONAL_FIELDS)[number]): boolean {
  if (field === 'oneCName') return profile.has1C === true && profile.oneCName === null;
  return profile[field] === null;
}

/** Что известно для выбора безопасного вопроса. */
export interface SafeQuestionInput {
  readonly profile: ClientProfile;
  /** Минимум по той же выжимке: недостающее в нём идёт первым (компания, только если о ней можно спросить). */
  readonly minimum: HandoffMinimum;
  /** Прошлое сообщение бота клиенту; null: бот ещё не писал. */
  readonly lastBotText: string | null;
}

/**
 * Поле для фиксированного вопроса вместо черновика, который не прошёл проверки (решение 29.10.2026): недостающее из
 * минимума по порядку, затем остальное невыясненное; о чём бот спросил прошлым сообщением, не спрашивается второй раз
 * подряд. Выводы «вероятно» выяснены. Спросить нечего => null (тогда передача check_failed).
 */
export function nextSafeField(input: SafeQuestionInput): QuestionField | null {
  const asked = input.lastBotText === null ? new Set() : askedFields(input.lastBotText);
  const optional = OPTIONAL_FIELDS.filter((field) => optionalMissing(input.profile, field));
  const candidates: readonly QuestionField[] = [...input.minimum.missing, ...optional];
  return candidates.find((field) => !asked.has(field)) ?? null;
}
