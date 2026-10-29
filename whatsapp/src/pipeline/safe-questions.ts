import type { CompanyQuestion } from '../domain/company.js';
import type { ClientProfile, ReviewedText } from '../domain/types.js';
import { ESTIMATE_LATER, type HandoffMinimum, type MinimumField } from '../handoff/minimum.js';

export { ESTIMATE_LATER } from '../handoff/minimum.js';

/** Поля квалификации, о которых бот спрашивает фиксированным вопросом: минимум и то, что входит в его группы. */
export type QuestionField = MinimumField | 'business' | 'packaging' | 'oneCName';

/**
 * Группы вопросов по порядку (решение владельца 29.10.2026 вечером): компания и чем занимается; что учитывать; где и
 * сколько; 1С. Площадь, движение вещей, нынешний учёт и боли в фиксированные вопросы не входят: отдельным сообщением
 * ради них бот не спрашивает.
 */
export const QUESTION_GROUPS: readonly (readonly QuestionField[])[] = [
  ['company', 'business'],
  ['items', 'packaging', 'material'],
  ['city', 'premises', 'itemCount'],
  ['has1C', 'oneCName'],
];

/** Все поля с вопросами, по порядку групп. */
export const QUESTION_FIELDS: readonly QuestionField[] = QUESTION_GROUPS.flat();

/**
 * Часть вопроса о поле: first, если часть идёт первой в вопросе, next, если перед ней уже есть другая (там вещи и
 * компания названы местоимением). Без фактов о Tanbala, цен, сроков и обещаний.
 */
interface QuestionPart {
  readonly first: string;
  readonly next: string;
}

function part(first: string, next: string = first): QuestionPart {
  return { first, next };
}

const PARTS: Readonly<Record<QuestionField, QuestionPart>> = {
  company: part('как называется ваша компания'),
  business: part('чем занимается ваша компания', 'чем она занимается'),
  items: part('какие вещи нужно учитывать'),
  packaging: part(
    'в чём лежат вещи (коробки, паллеты или поштучно)',
    'в чём они лежат (коробки, паллеты или поштучно)',
  ),
  material: part(
    'есть ли среди вещей металл или жидкости',
    'есть ли среди них металл или жидкости',
  ),
  city: part('в каком городе ваш объект'),
  premises: part('какое у вас помещение (склад, открытая площадка или магазин)'),
  itemCount: part('сколько примерно вещей нужно учитывать'),
  has1C: part('есть ли у вас 1С и какая'),
  oneCName: part('какая у вас конфигурация 1С'),
};

/** «а», «а и б», «а, б и в». */
function joinParts(parts: readonly string[]): string {
  if (parts.length < 2) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} и ${parts.at(-1) ?? ''}`;
}

/**
 * Фиксированный вопрос о полях одной группы одним предложением (решение 29.10.2026 вечером): «Подскажите, какие вещи
 * нужно учитывать, в чём они лежат (коробки, паллеты или поштучно) и есть ли среди них металл или жидкости?». Поля
 * идут в порядке QUESTION_FIELDS; при вопросе «есть ли 1С и какая» конфигурация отдельно не спрашивается. На ходу с вопросом цены перед ним фраза об ориентире. Проходит проверки кодом (это
 * проверяют тесты), поэтому к ReviewedText приводится здесь, как проверенный текст модели. Пусто => RangeError.
 */
export function groupQuestion(fields: readonly QuestionField[], aboutPrice: boolean): ReviewedText {
  // «Есть ли у вас 1С и какая» уже спрашивает и конфигурацию.
  const asks1C = fields.includes('has1C');
  const ordered = QUESTION_FIELDS.filter(
    (field) => fields.includes(field) && !(asks1C && field === 'oneCName'),
  );
  if (ordered.length === 0) throw new RangeError('Вопрос без полей: спросить не о чем');
  const parts = ordered.map((field, index) =>
    index === 0 ? PARTS[field].first : PARTS[field].next,
  );
  const question = `Подскажите, ${joinParts(parts)}?`;
  return (aboutPrice ? `${ESTIMATE_LATER} ${question}` : question) as ReviewedText;
}

/**
 * Признаки вопроса о поле в тексте бота: по ним выбирается группа, о которой бот не спрашивал прошлым сообщением.
 * Фиксированные вопросы узнаются своими словами (это проверяют тесты); вопрос модели узнаётся, если в нём те же слова.
 */
const ASKED: Readonly<Record<QuestionField, RegExp>> = {
  items:
    /какие вещи|что (?:именно )?(?:нужно |хотите |вы хотите |будете )?учитывать|какой товар|какие товары|что храните|что за (?:вещи|товар)/iu,
  material: /материал|металл|жидкост|из чего сделан/iu,
  itemCount:
    /сколько[^?]{0,40}(?:вещей|позиций|товар|единиц|штук|наименований|sku|меток|предметов|паллет|коробок)/iu,
  premises: /помещени|площадк|где хранятся|где лежат|склад или|магазин или/iu,
  city: /город/iu,
  has1C: /(?:есть|используете|работаете|ведёте|ведете)[^?]{0,20}1\s?[сc](?!\p{L})/iu,
  oneCName: /конфигурац|какая[^?]{0,20}1\s?[сc](?!\p{L})|1\s?[сc] и какая/iu,
  company:
    /компани(?:я|и|ю)?[^?]{0,30}(?:называ|правильно|верно)|из какой[^?]{0,20}компани|из компании|как называется ваша/iu,
  business: /чем[^?]{0,10}занимает|какой у вас бизнес|чем вы занимаетесь/iu,
  packaging: /коробк|паллет|поштучн|упаков|как лежат|в ч[её]м[^?]{0,10}лежат/iu,
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

/** Что известно для выбора безопасного вопроса. */
export interface SafeQuestionInput {
  readonly profile: ClientProfile;
  /** Минимум по той же выжимке: компания в нём недостающая, только если о ней можно спросить. */
  readonly minimum: HandoffMinimum;
  /** Прошлое сообщение бота клиенту; null: бот ещё не писал. */
  readonly lastBotText: string | null;
}

/** Фиксированный вопрос о группе: поля, текст и вопрос о названии компании, если он в тексте. */
export interface SafeQuestion {
  readonly fields: readonly QuestionField[];
  readonly text: ReviewedText;
  readonly companyQuestion?: CompanyQuestion;
}

/**
 * Не выяснено ли поле: поле минимума по минимуму (компания, только если о ней можно спросить); бизнес и упаковка по
 * выжимке; конфигурацию 1С спрашивают, только если 1С есть. Выводы «вероятно» выяснены.
 */
function isMissing(field: QuestionField, input: SafeQuestionInput): boolean {
  switch (field) {
    case 'business':
    case 'packaging':
      return input.profile[field] === null;
    case 'oneCName':
      return input.profile.has1C === true && input.profile.oneCName === null;
    default:
      return input.minimum.missing.includes(field);
  }
}

/** Группы по порядку, в каждой только невыясненные поля; группы, где всё выяснено, пропущены. */
export function missingGroups(input: SafeQuestionInput): readonly (readonly QuestionField[])[] {
  return QUESTION_GROUPS.map((group) => group.filter((field) => isMissing(field, input))).filter(
    (fields) => fields.length > 0,
  );
}

/** Спрашивал ли прошлый вопрос бота о группе (о любом её поле, а не только о невыясненном). */
function askedGroup(fields: readonly QuestionField[], asked: ReadonlySet<QuestionField>): boolean {
  const group = QUESTION_GROUPS.find((candidate) => candidate.includes(fields[0] ?? 'company'));
  return (group ?? fields).some((field) => asked.has(field));
}

/** Фиксированный вопрос о полях группы; вопрос о компании отмечается как вопрос о названии. */
export function safeQuestionOf(
  fields: readonly QuestionField[],
  aboutPrice: boolean,
): SafeQuestion {
  const text = groupQuestion(fields, aboutPrice);
  return fields.includes('company') ? { fields, text, companyQuestion: 'name' } : { fields, text };
}

/**
 * Вопрос вместо ранней передачи по цене: первая группа с недостающим из минимума, о которой бот не спрашивал прошлым
 * сообщением (все спрошены => первая такая группа), её невыясненные поля, с фразой об ориентире или без.
 */
export function minimumSafeQuestion(input: SafeQuestionInput, aboutPrice: boolean): SafeQuestion {
  const asked =
    input.lastBotText === null ? new Set<QuestionField>() : askedFields(input.lastBotText);
  const minimum = new Set<QuestionField>(input.minimum.missing);
  const groups = missingGroups(input).filter((group) => group.some((field) => minimum.has(field)));
  const fields = groups.find((group) => !askedGroup(group, asked)) ?? groups[0] ?? ['items'];
  return safeQuestionOf(fields, aboutPrice);
}

/**
 * Безопасный вопрос вместо черновика, который не прошёл проверки (решение 29.10.2026, группы с вечера): первая группа
 * с невыясненным, о которой бот не спрашивал прошлым сообщением, только её невыясненные поля. Спросить нечего => null
 * (тогда передача check_failed). aboutPrice: перед вопросом фраза об ориентире.
 */
export function nextSafeQuestion(
  input: SafeQuestionInput,
  aboutPrice: boolean,
): SafeQuestion | null {
  const asked =
    input.lastBotText === null ? new Set<QuestionField>() : askedFields(input.lastBotText);
  const fields = missingGroups(input).find((group) => !askedGroup(group, asked));
  return fields === undefined ? null : safeQuestionOf(fields, aboutPrice);
}
