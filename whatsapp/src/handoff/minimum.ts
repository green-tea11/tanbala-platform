import type { CompanyPrompt, CompanySummary } from '../domain/company.js';
import type { ClientProfile } from '../domain/types.js';

/**
 * Минимум прежних правил (решение владельца 29.10.2026, второй круг): компания; что учитывать (какие вещи и материал);
 * примерное число вещей; город и тип помещения; есть ли 1С. С 30.10.2026 чат по нему не передаётся (передачу решает
 * готовность к расчёту, pipeline/handoff-gate.ts); пока по нему пишутся строки уведомления менеджеру. Чистые функции без
 * LLM.
 */
export type MinimumField =
  'items' | 'material' | 'itemCount' | 'premises' | 'city' | 'has1C' | 'company';

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
