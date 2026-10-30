import type { CompanyPrompt, CompanySummary } from '../domain/company.js';
import type { ClientProfile } from '../domain/types.js';

/**
 * Минимум для передачи по цене (решение владельца 29.10.2026, второй круг): компания; что учитывать (какие вещи и
 * материал: металл и жидкости важны для меток); примерное число вещей; город и тип помещения; есть ли 1С (какая, для
 * минимума не обязательно). Остальное (упаковка, площадь, движение вещей, нынешний учёт, что мешает) по возможности.
 * Чистые функции без LLM: их зовут данные вызова ответа, проверка исхода hot в конвейере и уведомление менеджеру.
 */
export type MinimumField =
  'items' | 'material' | 'itemCount' | 'premises' | 'city' | 'has1C' | 'company';

/**
 * Ответ на вопрос цены до минимума (решение владельца 29.10.2026, слова с 30.10.2026): ориентир называет коллега, когда
 * задача понятна. Эту фразу пропускают проверки кодом и проверка вторым вызовом.
 */
export const ESTIMATE_LATER = 'Ориентир коллега назовёт, когда поймём вашу задачу.';

/**
 * Минимум собран, а чат ещё не передавался (решение владельца 29.10.2026 вечером): передача сразу, даже без вопроса
 * цены. Эту фразу пропускают проверки кодом и проверка вторым вызовом.
 */
export const MINIMUM_HANDOFF_TEXT =
  'Спасибо, этого хватит, чтобы коллега назвал ориентир. Уточню у коллеги и вернусь к вам.';

/**
 * Предел терпения клиента (решение владельца 29.10.2026 вечером): на этом по счёту сообщении клиента чат, который ещё не
 * передавался, уходит коллеге, даже если минимума нет.
 */
export const CLIENT_MESSAGES_FOR_HANDOFF = 5;

/** Фраза передачи по пределу сообщений: проходит проверки кодом и проверку вторым вызовом. */
export const CAP_HANDOFF_TEXT = 'Спасибо! Уточню у коллеги и вернусь к вам.';

/** Какой по счёту вопрос цены даёт передачу без минимума (решение владельца 29.10.2026, второй круг): четвёртый. */
export const PRICE_ASKS_FOR_HANDOFF = 4;

/**
 * Порядок вопросов: что учитывать (вещи, материал), сколько, где (помещение, город), 1С; компания последней: её
 * чаще находит определение компании, а вопрос о ней задаёт блок о компании.
 */
export const MINIMUM_ORDER: readonly MinimumField[] = [
  'items',
  'material',
  'itemCount',
  'premises',
  'city',
  'has1C',
  'company',
];

/** Названия полей минимума для менеджера и для данных вызова ответа (без тире). */
export const MINIMUM_LABELS: Readonly<Record<MinimumField, string>> = {
  items: 'какие вещи',
  material: 'материал',
  itemCount: 'примерное число вещей',
  premises: 'тип помещения',
  city: 'город',
  has1C: 'есть ли 1С',
  company: 'название компании',
};

/**
 * Что спросить у клиента, если не хватает поля (для данных вызова ответа и замечания повтору), без тире. Это указание
 * модели в третьем лице; готовые вопросы клиенту, которые уходят без модели, лежат в pipeline/safe-questions.ts.
 */
const QUESTIONS: Readonly<Record<Exclude<MinimumField, 'company'>, string>> = {
  items: 'какие вещи клиент хочет учитывать',
  material: 'из какого материала вещи: есть ли металл или жидкости',
  itemCount: 'сколько примерно вещей нужно учитывать',
  premises: 'где хранятся вещи: склад, открытая площадка или магазин',
  city: 'в каком городе объект',
  has1C: 'есть ли у клиента 1С и какая',
};

/**
 * Вопрос о недостающем поле. О компании: подтвердить кандидата из блока о компании (confirm) или спросить название
 * (name), как разрешает блок.
 */
export function minimumQuestion(field: MinimumField, company: CompanyPrompt | undefined): string {
  if (field !== 'company') return QUESTIONS[field];
  return company?.kind === 'candidate'
    ? 'из той ли компании клиент, что названа в блоке о компании (companyQuestion: confirm)'
    : 'из какой клиент компании (companyQuestion: name)';
}

/**
 * Группы вопросов минимума по порядку (решение владельца 29.10.2026 вечером): компания; что учитывать; где и сколько;
 * 1С. В одном сообщении бот задаёт вопросы одной группы, блоком из двух или трёх связанных вопросов.
 */
export const MINIMUM_GROUPS: readonly (readonly MinimumField[])[] = [
  ['company'],
  ['items', 'material'],
  ['city', 'premises', 'itemCount'],
  ['has1C'],
];

/**
 * Недостающее по группам для данных вызова ответа: «1) ...; 2) ...», в каждой группе только недостающие поля, группы
 * без недостающего пропущены, номера по порядку оставшихся.
 */
export function minimumGroupQuestions(
  missing: readonly MinimumField[],
  company: CompanyPrompt | undefined,
): string {
  return MINIMUM_GROUPS.map((group) => group.filter((field) => missing.includes(field)))
    .filter((fields) => fields.length > 0)
    .map(
      (fields, index) =>
        `${index + 1}) ${fields.map((field) => minimumQuestion(field, company)).join(', ')}`,
    )
    .join('; ');
}

/** Что известно для минимума. */
export interface MinimumInput {
  readonly profile: ClientProfile;
  /** Название компании: подтверждённое через API или со слов клиента; null: неизвестно. */
  readonly companyName: string | null;
  /**
   * О компании можно спросить сейчас (кандидат ещё не спрошен или разрешён вопрос о названии). Иначе неизвестная
   * компания передаче не мешает: бот о ней больше не спрашивает (уже спрашивал или определение выключено).
   */
  readonly companyAskable: boolean;
}

/** Итог: что собрано, чего не хватает (мешает передаче по цене) и что не выяснено, но спросить нельзя. */
export interface HandoffMinimum {
  readonly collected: readonly MinimumField[];
  readonly missing: readonly MinimumField[];
  readonly unknown: readonly MinimumField[];
}

/** Строки для уведомления менеджеру: что собрано и что выяснить не удалось. */
export interface MinimumReport {
  readonly collected: string;
  readonly missing: string;
}

const NOTHING_COLLECTED = 'ничего';
const NOTHING_MISSING = 'всё выяснено';

function hasText(value: string | null): boolean {
  return value !== null && value.trim() !== '';
}

function isCollected(
  field: MinimumField,
  profile: ClientProfile,
  companyName: string | null,
): boolean {
  switch (field) {
    case 'company':
      return hasText(companyName);
    case 'has1C':
      return profile.has1C !== null;
    default:
      return hasText(profile[field]);
  }
}

/**
 * Минимум по выжимке и компании, поля в порядке MINIMUM_ORDER. Невыясненная компания мешает передаче, только если о
 * ней можно спросить сейчас (companyAskable); иначе она в unknown.
 */
export function handoffMinimum(input: MinimumInput): HandoffMinimum {
  const { profile, companyName, companyAskable } = input;
  const collected = MINIMUM_ORDER.filter((field) => isCollected(field, profile, companyName));
  const absent = MINIMUM_ORDER.filter((field) => !collected.includes(field));
  const blocks = (field: MinimumField): boolean => field !== 'company' || companyAskable;
  return {
    collected,
    missing: absent.filter(blocks),
    unknown: absent.filter((field) => !blocks(field)),
  };
}

/** Можно ли спросить о компании в этом ответе: кандидат ещё не спрошен или блок разрешает вопрос о названии. */
export function companyAskable(prompt: CompanyPrompt | undefined): boolean {
  if (prompt?.kind === 'candidate') return true;
  return prompt?.kind === 'unknown' && prompt.askName;
}

/** Название компании для минимума: подтверждённая клиентом, иначе со слов клиента; нет => null. */
export function companyNameOf(summary: CompanySummary | null): string | null {
  if (summary === null) return null;
  const name = summary.status === 'confirmed' ? summary.name : summary.statedName;
  const trimmed = name?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * Что собрано и что не выяснено (вместе: мешающее передаче и то, о чём спросить нельзя), словами для менеджера.
 * Собранное по выводу из слов клиента помечено «(вероятно)».
 */
export function minimumReport(input: Omit<MinimumInput, 'companyAskable'>): MinimumReport {
  const minimum = handoffMinimum({ ...input, companyAskable: true });
  const inferred = new Set<string>(input.profile.inferred);
  const label = (field: MinimumField): string =>
    inferred.has(field) ? `${MINIMUM_LABELS[field]} (вероятно)` : MINIMUM_LABELS[field];
  const words = (fields: readonly MinimumField[], empty: string): string =>
    fields.length === 0 ? empty : fields.map(label).join(', ');
  return {
    collected: words(minimum.collected, NOTHING_COLLECTED),
    missing: words(minimum.missing, NOTHING_MISSING),
  };
}
