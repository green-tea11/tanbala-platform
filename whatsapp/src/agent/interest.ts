import { z } from 'zod';
import type { CompanyMention, CompanyPrompt } from '../domain/company.js';
import type {
  ClientProfile,
  InterestAssessment,
  InterestLevel,
  TurnSignals,
} from '../domain/types.js';
import { cleanLine } from './clean-text.js';
import { companyInterestData } from './company-data.js';
import { profileText } from './profile.js';

/** Поля выжимки короткие: они идут менеджеру в уведомление и в панель, а модель пишет их по словам клиента. */
const MAX_FIELD_CHARS = 200;
const MAX_REASON_CHARS = 300;
/** Пределы контракта API почтового проекта: название до 200, город до 100 символов. */
const MAX_COMPANY_NAME_CHARS = 200;
const MAX_CITY_CHARS = 100;
/** Подтверждённых болей в одной оценке не больше трёх. */
const MAX_PAINS = 3;

/** Ничего не выяснено: блок данных не пустой, и модель знает, что все поля пока null. */
const NOTHING_KNOWN = 'В выжимке пока ничего нет: клиент ещё ничего о себе не рассказал.';

/**
 * Схема ответа оценки интереса: плоский объект (уровень, поля ClientProfile, причина), все поля обязательны.
 * Невыясненное поле null. describe() стоит до nullable(): SDK пишет поле как anyOf [тип, null] без $defs и $ref
 * (после nullable() он вынес бы тип в $defs).
 * Без transform: вход и выход совпадают. В InterestAssessment её переводит normalizeInterest.
 */
export const interestSchema = z.object({
  level: z.enum(['cold', 'warm', 'hot']).describe('Уровень интереса клиента: cold, warm или hot.'),
  business: z.string().describe('Чем занимается компания клиента; иначе null.').nullable(),
  items: z.string().describe('Какие вещи клиент хочет учитывать; иначе null.').nullable(),
  packaging: z
    .string()
    .describe('В чём вещи: коробки, паллеты, поштучно; иначе null.')
    .nullable(),
  material: z.string().describe('Материал вещей (металл, жидкости и другое); иначе null.').nullable(),
  city: z.string().describe('Город объекта; иначе null.').nullable(),
  premises: z
    .string()
    .describe('Тип помещения: склад, открытая площадка, магазин и другое; иначе null.')
    .nullable(),
  area: z.string().describe('Площадь; иначе null.').nullable(),
  scope: z
    .string()
    .describe('Что отмечать: только ввоз и вывоз или где лежит каждая вещь; иначе null.')
    .nullable(),
  itemCount: z.string().describe('Примерное число вещей; иначе null.').nullable(),
  turnover: z.string().describe('Как часто вещи приходят и уходят; иначе null.').nullable(),
  currentTracking: z.string().describe('Как клиент ведёт учёт сейчас; иначе null.').nullable(),
  has1C: z
    .boolean()
    .describe('true или false, если клиент сказал, есть ли у него 1С; иначе null.')
    .nullable(),
  problem: z
    .string()
    .describe('Что мешает в нынешнем учёте, какую проблему клиент хочет решить; иначе null.')
    .nullable(),
  specifics: z.string().describe('Особенности со слов клиента; null, если их нет.').nullable(),
  reason: z.string().describe('Одна короткая фраза: почему выбран этот уровень.'),
  companyName: z
    .string()
    .describe('Название компании клиента, если клиент сам его написал или сказал; иначе null.')
    .nullable(),
  companyCity: z.string().describe('Город компании клиента с его слов; иначе null.').nullable(),
  companyAnswer: z
    .enum(['yes', 'no', 'none'])
    .describe(
      'Ответ клиента на вопрос бота «Вы из компании X?»: yes, no или none (не ответил или вопроса не было).',
    ),
  confirmedPains: z
    .array(z.string())
    .describe(
      'Трудности, с которыми клиент согласился или о которых рассказал сам, коротко; до трёх; иначе пустой список.',
    ),
  oneCName: z.string().describe('Какая 1С у клиента, если он её назвал; иначе null.').nullable(),
  problemAgreed: z
    .boolean()
    .describe(
      'true, если клиент согласился, что трудность у него есть, или сам рассказал о своей задаче; иначе false.',
    ),
  priceAsked: z
    .boolean()
    .describe(
      'true, если в последних сообщениях клиента (после последней реплики assistant) есть вопрос о цене или стоимости; иначе false.',
    ),
  refused: z
    .boolean()
    .describe(
      'true, если в последних сообщениях клиент отказывается отвечать на вопросы бота; иначе false.',
    ),
});

/**
 * Ответ модели до нормализации. Поля о компании необязательны: подделки LLM в тестах конвейера их не пишут, а схема
 * для настоящего вызова требует все поля.
 */
export interface RawInterest {
  readonly level: InterestLevel;
  readonly business: string | null;
  readonly items?: string | null;
  readonly packaging?: string | null;
  readonly material?: string | null;
  readonly city?: string | null;
  readonly premises?: string | null;
  readonly area: string | null;
  readonly scope: string | null;
  readonly itemCount: string | null;
  readonly turnover?: string | null;
  readonly currentTracking?: string | null;
  readonly has1C: boolean | null;
  readonly problem: string | null;
  readonly specifics: string | null;
  readonly reason: string;
  readonly companyName?: string | null;
  readonly companyCity?: string | null;
  readonly companyAnswer?: CompanyMention['answer'];
  readonly confirmedPains?: readonly string[];
  readonly oneCName?: string | null;
  readonly problemAgreed?: boolean;
  readonly priceAsked?: boolean;
  readonly refused?: boolean;
}

/** Новое значение поля после cleanLine; модель ничего не дала или остался пустой текст => прежнее значение. */
function textField(fresh: string | null, previous: string | null): string | null {
  const cleaned = fresh === null ? '' : cleanLine(fresh, MAX_FIELD_CHARS);
  return cleaned === '' ? previous : cleaned;
}

/** Строка о компании после cleanLine; пусто => null. */
function companyField(value: string | null | undefined, maxChars: number): string | null {
  const cleaned = value === null || value === undefined ? '' : cleanLine(value, maxChars);
  return cleaned === '' ? null : cleaned;
}

/**
 * Что клиент сказал о компании: название и город (поиск идёт только через API почтового проекта), ответ на вопрос
 * «Вы из компании X?» и подтверждённые боли (до трёх, без пустых). Модель не прислала ни одного поля о компании
 * => undefined: так отвечают подделки LLM, настоящая схема требует все поля.
 */
function companyMention(raw: RawInterest): CompanyMention | undefined {
  const { companyName, companyCity, companyAnswer, confirmedPains } = raw;
  if (
    companyName === undefined &&
    companyCity === undefined &&
    companyAnswer === undefined &&
    confirmedPains === undefined
  ) {
    return undefined;
  }
  const pains = (confirmedPains ?? [])
    .map((pain) => cleanLine(pain, MAX_FIELD_CHARS))
    .filter((pain) => pain !== '')
    .slice(0, MAX_PAINS);
  return {
    name: companyField(companyName, MAX_COMPANY_NAME_CHARS),
    city: companyField(companyCity, MAX_CITY_CHARS),
    answer: companyAnswer ?? 'none',
    pains,
  };
}

/**
 * Сигналы хода: спрашивает ли клиент цену и отказывается ли отвечать. Модель не прислала ни одного из полей => undefined
 * (так отвечают подделки LLM); иначе отсутствующее поле значит false.
 */
function turnSignals(raw: RawInterest): TurnSignals | undefined {
  if (raw.priceAsked === undefined && raw.refused === undefined) return undefined;
  return { priceAsked: raw.priceAsked === true, refused: raw.refused === true };
}

/** Есть ли 1С: ответ клиента, иначе прежнее значение; названная 1С без ответа значит, что 1С есть. */
function has1COf(
  raw: RawInterest,
  previous: ClientProfile,
  oneCName: string | null,
): boolean | null {
  return raw.has1C ?? previous.has1C ?? (oneCName === null ? null : true);
}

/**
 * Нормализует оценку интереса. Поля выжимки: cleanLine (одна строка, до 200 знаков), пустое значение => прежнее.
 * Известное раньше сохраняется, даже если модель его потеряла (она переписывает выжимку целиком, а окно истории
 * короткое): null значит «клиент не говорил», стирать выясненное он не может. Исправление клиента модель
 * присылает новым значением, и оно заменяет прежнее; has1C false не считается пустым. reason до 300 знаков,
 * может остаться пустой: оценка из-за этого не теряется. company: что клиент сказал о своей компании
 * (companyMention); его хранит и применяет сервис компании, а не выжимка. Какая 1С (oneCName) чистится как
 * текстовое поле; названная 1С без ответа «есть ли 1С» значит, что 1С есть. Согласие, что трудность есть
 * (problemAgreed), раз выяснено, не теряется. signals: вопрос цены и отказ отвечать в последних сообщениях клиента
 * (turnSignals), они в выжимку не входят.
 */
export function normalizeInterest(raw: RawInterest, previous: ClientProfile): InterestAssessment {
  const company = companyMention(raw);
  const signals = turnSignals(raw);
  const oneCName = textField(raw.oneCName ?? null, previous.oneCName);
  return {
    level: raw.level,
    profile: {
      business: textField(raw.business, previous.business),
      items: textField(raw.items ?? null, previous.items),
      packaging: textField(raw.packaging ?? null, previous.packaging),
      material: textField(raw.material ?? null, previous.material),
      city: textField(raw.city ?? null, previous.city),
      premises: textField(raw.premises ?? null, previous.premises),
      area: textField(raw.area, previous.area),
      scope: textField(raw.scope, previous.scope),
      itemCount: textField(raw.itemCount, previous.itemCount),
      turnover: textField(raw.turnover ?? null, previous.turnover),
      currentTracking: textField(raw.currentTracking ?? null, previous.currentTracking),
      has1C: has1COf(raw, previous, oneCName),
      oneCName,
      problem: textField(raw.problem, previous.problem),
      specifics: textField(raw.specifics, previous.specifics),
      problemAgreed: previous.problemAgreed || raw.problemAgreed === true,
    },
    reason: cleanLine(raw.reason, MAX_REASON_CHARS),
    ...(company === undefined ? {} : { company }),
    ...(signals === undefined ? {} : { signals }),
  };
}

/**
 * Данные вызова оценки: уровень, который система хранит сейчас (если конвейер его передал), текущая выжимка
 * (profileText) и, если определение компании включено, строка о вопросе «Вы из компании X?» (companyInterestData).
 * Блок есть всегда, даже при пустой выжимке: последняя реплика user не остаётся без данных.
 */
export function interestCallData(
  profile: ClientProfile,
  level: InterestLevel | undefined,
  company?: CompanyPrompt,
): string {
  const levelLine =
    level === undefined ? null : `Уровень интереса, который система хранит сейчас: ${level}.`;
  return [levelLine, profileText(profile) ?? NOTHING_KNOWN, companyInterestData(company)]
    .filter((line) => line !== null)
    .join('\n');
}
