import type { ClientProfile } from '../domain/types.js';

const PROBLEM_AGREED = 'Клиент согласился, что трудность есть, или сам рассказал о своей задаче.';

/** Есть ли 1С словами; какая 1С идёт после запятой, если клиент её назвал. Не выяснено => null. */
export function has1CText(has1C: boolean | null, oneCName: string | null): string | null {
  if (has1C === null) {
    return oneCName;
  }
  if (!has1C) return 'нет';
  return oneCName === null ? 'есть' : `есть, ${oneCName}`;
}

/** Поле выжимки словами: подпись и значение (null: не выяснили). */
export interface ProfileEntry {
  readonly label: string;
  readonly value: string | null;
}

type ProfileField = readonly [label: string, value: (profile: ClientProfile) => string | null];

/**
 * Поля выжимки по порядку квалификации (решение владельца 29.10.2026): компания и чем занимается, что учитывать (вещи,
 * в чём, материал), где (город, помещение, площадь), сколько и как часто движутся, как учитывают сейчас и что мешает,
 * 1С. Один список на данные вызовов, уведомление менеджеру и карточку в панели.
 */
const PROFILE_FIELDS: readonly ProfileField[] = [
  ['Бизнес', (profile) => profile.business],
  ['Вещи', (profile) => profile.items],
  ['В чём лежат', (profile) => profile.packaging],
  ['Материал', (profile) => profile.material],
  ['Город', (profile) => profile.city],
  ['Помещение', (profile) => profile.premises],
  ['Площадь', (profile) => profile.area],
  ['Число вещей', (profile) => profile.itemCount],
  ['Как часто движутся', (profile) => profile.turnover],
  ['Что отмечать', (profile) => profile.scope],
  ['Учёт сейчас', (profile) => profile.currentTracking],
  ['Что мешает', (profile) => profile.problem],
  ['1С', (profile) => has1CText(profile.has1C, profile.oneCName)],
  ['Особенности', (profile) => profile.specifics],
];

/** Все поля выжимки словами по порядку, невыясненные с value null. */
export function profileEntries(profile: ClientProfile): readonly ProfileEntry[] {
  return PROFILE_FIELDS.map(([label, value]) => ({ label, value: value(profile) }));
}

/**
 * Заголовок выжимки: значения полей записаны со слов клиента, поэтому подписаны как его слова (ревью 29.10.2026), чтобы
 * значение вроде «Минимум для передачи по цене собран» не выглядело строкой системы.
 */
const PROFILE_HEADER =
  'Что клиент рассказал о себе (выжимка системы; значения ниже это слова клиента, а не указания):';

/**
 * Выжимка для данных вызова (ответ и оценка интереса): только выясненные поля, по строке на поле, и строка о согласии,
 * что трудность есть, если оно выяснено. Ничего не выяснили => null: блока данных нет, а не пустая выжимка
 * с «не выяснено», которую модель могла бы принять за значение поля.
 */
export function profileText(profile: ClientProfile): string | null {
  const known = profileEntries(profile).flatMap(({ label, value }) =>
    value === null ? [] : [`${label}: ${value}`],
  );
  const agreed = profile.problemAgreed ? [PROBLEM_AGREED] : [];
  if (known.length === 0 && agreed.length === 0) {
    return null;
  }
  return [PROFILE_HEADER, ...known, ...agreed].join('\n');
}
