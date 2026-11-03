import type { ClientProfile, ConversationStage, StrengthId } from '../domain/types.js';
import { HOT_PRICE_HANDOFF_TEXT } from '../messaging/outbox.js';

/**
 * Ответ на вопрос цены, сроков или договора, пока задача клиента не понятна (решение владельца 30.10.2026): ориентир
 * называет коллега. Эту фразу пропускают проверки кодом и проверка вторым вызовом на ходу с вопросом цены.
 */
export const ESTIMATE_LATER = 'Ориентир коллега назовёт, когда поймём вашу задачу.';

/**
 * Что нужно знать для расчёта (решение владельца 30.10.2026): чем занимается клиент, что лежит на хранении, сколько
 * этого, сколько нового приходит в месяц, сколько проходов учитывать, есть ли 1С и город.
 */
export type CalcField =
  'business' | 'items' | 'itemCount' | 'monthlyIntake' | 'passages' | 'has1C' | 'city';

/** Поля для расчёта в порядке разговора (knowledge/bot.md, «Ход разговора»). */
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
  items: 'что лежит на хранении',
  itemCount: 'сколько этого примерно',
  monthlyIntake: 'сколько нового приходит в месяц',
  passages: 'сколько проходов нужно учитывать',
  has1C: 'есть ли 1С и какая',
  city: 'город',
};

/**
 * Короткие названия сильных сторон (knowledge/bot.md, «Что умеем») для менеджера: уведомление и панель (решение
 * владельца 30.10.2026). Клиенту номера и эти названия не пишутся.
 */
export const STRENGTH_LABELS: Readonly<Record<StrengthId, string>> = {
  F1: 'метка читается по радио',
  F2: 'сотни меток за секунду',
  F3: 'антенны на входе и выходе',
  F4: 'ручной сканер',
  F5: 'в метку записан товар',
  F6: 'интеграция с 1С',
  F7: 'своя веб-платформа в дополнение к 1С',
  F8: 'под ключ',
  F9: 'лучше штрихкода',
  F10: 'не госмаркировка',
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
  /** Самый дальний этап отправленных ответов бота; null: бот ещё не отвечал текстом модели. */
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

/**
 * Задача клиента понятна (решение владельца 30.10.2026): клиент согласился, что трудность есть, или сам рассказал о задаче,
 * и известно, что лежит на хранении и сколько этого. Тогда вопрос цены, сроков или договора передаёт чат коллеге.
 */
export function taskUnderstood(profile: ClientProfile): boolean {
  return profile.problemAgreed && isKnown('items', profile) && isKnown('itemCount', profile);
}

/** Чего не хватает для расчёта по выжимке; вывод с пометкой «вероятно» считается известным. */
export function calcMissing(profile: ClientProfile): readonly CalcField[] {
  return CALC_FIELDS.filter((field) => !isKnown(field, profile));
}

/** Что для расчёта уже известно по выжимке, по порядку CALC_FIELDS (вывод «вероятно» тоже). */
export function calcKnown(profile: ClientProfile): readonly CalcField[] {
  return CALC_FIELDS.filter((field) => isKnown(field, profile));
}

/**
 * Этап по правилам владельца (30.10.2026), по порядку: нет бизнеса => знакомство; бот ещё ни разу не был на крючке или
 * дальше => крючок; дальше крючка ещё не ушёл => как это работает; не хватает чего-то для расчёта => боли и детали;
 * всё известно => финал, но если чат уже передавался коллеге, финал не предлагается (боли и детали). «Ни разу не был
 * на крючке» судится по самому дальнему этапу ответов: хранится только он.
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
  /** Задача клиента понятна (taskUnderstood); нет поля => не понятна. */
  readonly taskUnderstood?: boolean;
}

/** «раз» или «раза» по числу. */
function times(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'раза' : 'раз';
}

/** Что делать с вопросом цены, сроков или договора: при понятной задаче передать чат, иначе ответить об ориентире. */
function priceLine(understood: boolean): string {
  return understood
    ? `Задача клиента понятна: если он спрашивает цену, сроки или договор, передай чат (hot) с фразой «${HOT_PRICE_HANDOFF_TEXT}».`
    : `Задача клиента ещё не понятна: на вопрос цены, сроков или договора ответь «${ESTIMATE_LATER}» и задай один вопрос.`;
}

/**
 * Строки системы для данных вызова ответа (решение владельца 30.10.2026): этап по данным системы и право модели выбрать
 * другой по последнему сообщению клиента, чего не хватает для расчёта, что делать с вопросом цены, сроков или договора
 * (понятна ли задача), какие сильные стороны уже рассказаны (если есть) и сколько раз клиент уже спрашивал цену (если
 * спрашивал).
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
    priceLine(input.taskUnderstood === true),
    ...(told.length === 0 ? [] : [`Уже рассказано: ${told.join(', ')}.`]),
    ...(priceAsks > 0
      ? [`До этого сообщения клиент спрашивал цену ${priceAsks} ${times(priceAsks)}.`]
      : []),
  ].join('\n');
}
