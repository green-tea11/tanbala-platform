import type { ClientProfile, ConversationStage, StrengthId } from '../domain/types.js';

/**
 * Что нужно знать для расчёта (решение владельца 30.10.2026): чем занимается клиент, что лежит на хранении, сколько
 * этого, сколько нового приходит в месяц, сколько проходов учитывать, есть ли 1С и город.
 */
export type CalcField =
  'business' | 'items' | 'itemCount' | 'monthlyIntake' | 'passages' | 'has1C' | 'city';

/** Поля для расчёта в порядке разговора (knowledge/consult.md, раздел 5). */
export const CALC_FIELDS: readonly CalcField[] = [
  'business',
  'items',
  'itemCount',
  'monthlyIntake',
  'passages',
  'has1C',
  'city',
];

/** Недостающее для расчёта человеческими словами: для данных вызова ответа. */
export const CALC_LABELS: Readonly<Record<CalcField, string>> = {
  business: 'чем занимается клиент',
  items: 'что лежит на хранении и в каком виде',
  itemCount: 'сколько этого примерно',
  monthlyIntake: 'сколько нового приходит в месяц',
  passages: 'сколько проходов нужно учитывать',
  has1C: 'есть ли 1С и какая',
  city: 'город',
};

/** Номер и название этапа по-русски для данных вызова ответа. */
const STAGE_TITLES: Readonly<Record<ConversationStage, string>> = {
  intro: '1 знакомство',
  hook: '2 крючок',
  explain: '3 как это работает',
  details: '4 боли и детали',
  final: '5 финал',
};

/** Этапы с крючка и дальше: бот на них уже спросил, знает ли клиент RFID, или клиент его знает. */
const FROM_HOOK: readonly ConversationStage[] = ['hook', 'explain', 'details', 'final'];

/** Что известно для выбора этапа. */
export interface StageInput {
  /** Выжимка до этого хода. */
  readonly profile: ClientProfile;
  /** Этап последнего отправленного ответа бота; null: бот ещё не отвечал текстом модели. */
  readonly lastStage: ConversationStage | null;
  /** Чат уже передавался коллеге (по любой причине). */
  readonly handedOff: boolean;
}

/** Рекомендуемый этап и чего не хватает для расчёта (полями и словами, по порядку CALC_FIELDS). */
export interface StageAdvice {
  readonly stage: ConversationStage;
  readonly missing: readonly CalcField[];
  readonly missingWords: readonly string[];
}

function isKnown(field: CalcField, profile: ClientProfile): boolean {
  if (field === 'has1C') return profile.has1C !== null;
  const value = profile[field];
  return value !== null && value.trim() !== '';
}

/** Чего не хватает для расчёта по выжимке; вывод с пометкой «вероятно» считается известным. */
export function calcMissing(profile: ClientProfile): readonly CalcField[] {
  return CALC_FIELDS.filter((field) => !isKnown(field, profile));
}

/**
 * Этап по правилам владельца (30.10.2026), по порядку: нет бизнеса => знакомство; бот ещё ни разу не был на крючке или
 * дальше => крючок; последний ответ на крючке => как это работает; не хватает чего-то для расчёта => боли и детали;
 * всё известно => финал, но если чат уже передавался коллеге, финал не предлагается (боли и детали). «Ни разу не был
 * на крючке» судится по этапу последнего ответа: хранится только он.
 */
function stageOf(input: StageInput, missing: readonly CalcField[]): ConversationStage {
  if (missing.includes('business')) return 'intro';
  if (input.lastStage === null || !FROM_HOOK.includes(input.lastStage)) return 'hook';
  if (input.lastStage === 'hook') return 'explain';
  if (missing.length > 0 || input.handedOff) return 'details';
  return 'final';
}

/** Рекомендуемый этап разговора и недостающее для расчёта. Чистая функция, без LLM. */
export function recommendStage(input: StageInput): StageAdvice {
  const missing = calcMissing(input.profile);
  return {
    stage: stageOf(input, missing),
    missing,
    missingWords: missing.map((field) => CALC_LABELS[field]),
  };
}

/** Что идёт в строки данных вызова ответа об этапе. */
export interface StageDataInput {
  readonly advice: StageAdvice;
  /** Уже рассказанные сильные стороны; нет поля => ни одной. */
  readonly toldFacts?: readonly StrengthId[];
  /** Сколько раз клиент спрашивал цену до этого сообщения; нет поля => ноль. */
  readonly priceAsks?: number;
}

/** «раз» или «раза» по числу. */
function times(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'раза' : 'раз';
}

/**
 * Строки системы для данных вызова ответа (решение владельца 30.10.2026): этап по данным системы и право модели выбрать
 * другой по последнему сообщению клиента, чего не хватает для расчёта, какие сильные стороны уже рассказаны (если есть)
 * и сколько раз клиент уже спрашивал цену (если спрашивал).
 */
export function stageReplyData(input: StageDataInput): string {
  const { advice } = input;
  const told = input.toldFacts ?? [];
  const priceAsks = input.priceAsks ?? 0;
  return [
    `Этап по данным системы: ${STAGE_TITLES[advice.stage]}. Если из последнего сообщения клиента ясно другое (например, он сам знает RFID или уже назвал всё нужное), выбери этап сам и верни его в stage.`,
    advice.missingWords.length === 0
      ? 'Для расчёта известно всё.'
      : `Для расчёта не хватает: ${advice.missingWords.join(', ')}.`,
    ...(told.length === 0 ? [] : [`Уже рассказано: ${told.join(', ')}.`]),
    ...(priceAsks > 0
      ? [`До этого сообщения клиент спрашивал цену ${priceAsks} ${times(priceAsks)}.`]
      : []),
  ].join('\n');
}
