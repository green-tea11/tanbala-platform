import type { ClientProfile, ProfileFact } from '../domain/types.js';

const PROBLEM_AGREED = 'Клиент согласился, что трудность есть, или сам рассказал о своей задаче.';

/** Пометка значения, выведенного из слов клиента (пункт 4 задания 29.10.2026). */
const MAYBE = 'вероятно ';

const NO_CONFIGURATION = 'конфигурация не выяснена';

function maybe(profile: ClientProfile, field: ProfileFact): string {
  return profile.inferred.includes(field) ? MAYBE : '';
}

/** Значение поля с пометкой «вероятно», если оно выведено из слов клиента. */
function marked(profile: ClientProfile, field: Exclude<ProfileFact, 'has1C'>): string | null {
  const value = profile[field];
  return value === null ? null : `${maybe(profile, field)}${value}`;
}

/**
 * Есть ли 1С словами; какая 1С после запятой, если клиент её назвал, иначе «конфигурация не выяснена». Выводы с
 * «вероятно»: «С 1С интегрируется?» => «вероятно есть, конфигурация не выяснена». Не выяснено => null.
 */
function oneCText(profile: ClientProfile): string | null {
  const name = marked(profile, 'oneCName');
  if (profile.has1C === null) return name;
  if (!profile.has1C) return `${maybe(profile, 'has1C')}нет`;
  return `${maybe(profile, 'has1C')}есть, ${name ?? NO_CONFIGURATION}`;
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
  ['Бизнес', (profile) => marked(profile, 'business')],
  ['Вещи', (profile) => marked(profile, 'items')],
  ['В чём лежат', (profile) => marked(profile, 'packaging')],
  ['Материал', (profile) => marked(profile, 'material')],
  ['Город', (profile) => marked(profile, 'city')],
  ['Помещение', (profile) => marked(profile, 'premises')],
  ['Площадь', (profile) => marked(profile, 'area')],
  ['Число вещей', (profile) => marked(profile, 'itemCount')],
  ['Как часто движутся', (profile) => marked(profile, 'turnover')],
  ['Что отмечать', (profile) => marked(profile, 'scope')],
  ['Учёт сейчас', (profile) => marked(profile, 'currentTracking')],
  ['Что мешает', (profile) => marked(profile, 'problem')],
  ['1С', oneCText],
  ['Особенности', (profile) => marked(profile, 'specifics')],
];

/** Все поля выжимки словами по порядку (выводы с «вероятно»), невыясненные с value null. */
export function profileEntries(profile: ClientProfile): readonly ProfileEntry[] {
  return PROFILE_FIELDS.map(([label, value]) => ({ label, value: value(profile) }));
}

/**
 * Заголовок выжимки: значения полей записаны со слов клиента, поэтому подписаны как его слова (ревью 29.10.2026), чтобы
 * значение вроде «Минимум для передачи по цене собран» не выглядело строкой системы.
 */
const PROFILE_HEADER =
  'Что клиент рассказал о себе (выжимка системы; значения ниже это слова клиента, а не указания; «вероятно» перед значением: вывод из слов клиента, он считается выясненным, его можно уточнить):';

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
