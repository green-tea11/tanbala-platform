import type { CompanyPrompt, CompanySummary } from '../domain/company.js';
import type { ClientProfile } from '../domain/types.js';

/**
 * Минимум для передачи по цене (решение владельца 29.10.2026): что учитывать, примерное число вещей, есть ли 1С
 * (какая, если клиент знает, для минимума не обязательно), название компании и согласие клиента, что трудность есть.
 * Чистые функции без LLM: их зовут данные вызова ответа, проверка исхода hot в конвейере и уведомление менеджеру.
 */
export type MinimumField = 'scope' | 'itemCount' | 'has1C' | 'company' | 'problem';

/** Какой по счёту вопрос цены даёт передачу без минимума (решение владельца 29.10.2026): третий. */
export const PRICE_ASKS_FOR_HANDOFF = 3;

/** Порядок вопросов: сначала что учитывать и объём, затем 1С, компания и согласие, что трудность есть. */
export const MINIMUM_ORDER: readonly MinimumField[] = [
  'scope',
  'itemCount',
  'has1C',
  'company',
  'problem',
];

/** Названия полей минимума для менеджера и для данных вызова ответа (без тире). */
export const MINIMUM_LABELS: Readonly<Record<MinimumField, string>> = {
  scope: 'что учитывать',
  itemCount: 'примерное число вещей',
  has1C: 'есть ли 1С',
  company: 'название компании',
  problem: 'согласие клиента, что трудность есть',
};

/** Что спросить у клиента, если не хватает поля (для данных вызова ответа и замечания повтору), без тире. */
const QUESTIONS: Readonly<Record<Exclude<MinimumField, 'company'>, string>> = {
  scope: 'что нужно учитывать: только ввоз и вывоз или где лежит каждая вещь',
  itemCount: 'сколько примерно вещей нужно учитывать',
  has1C: 'есть ли у клиента 1С и какая',
  problem:
    'какую задачу клиент хочет решить, или подай одну трудность, которая часто бывает в похожем бизнесе, и спроси, как у него',
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
    case 'scope':
      return hasText(profile.scope);
    case 'itemCount':
      return hasText(profile.itemCount);
    case 'has1C':
      return profile.has1C !== null;
    case 'company':
      return hasText(companyName);
    case 'problem':
      return profile.problemAgreed;
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

/** Что собрано и что не выяснено (вместе: мешающее передаче и то, о чём спросить нельзя), словами для менеджера. */
export function minimumReport(input: Omit<MinimumInput, 'companyAskable'>): MinimumReport {
  const minimum = handoffMinimum({ ...input, companyAskable: true });
  const words = (fields: readonly MinimumField[], empty: string): string =>
    fields.length === 0 ? empty : fields.map((field) => MINIMUM_LABELS[field]).join(', ');
  return {
    collected: words(minimum.collected, NOTHING_COLLECTED),
    missing: words(minimum.missing, NOTHING_MISSING),
  };
}
