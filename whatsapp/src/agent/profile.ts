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

/**
 * Выжимка для данных вызова (ответ и оценка интереса): только выясненные поля, по строке на поле, и строка о согласии,
 * что трудность есть, если оно выяснено. Ничего не выяснили => null: блока данных нет, а не пустая выжимка
 * с «не выяснено», которую модель могла бы принять за значение поля.
 */
export function profileText(profile: ClientProfile): string | null {
  const fields: readonly (readonly [string, string | null])[] = [
    ['Бизнес', profile.business],
    ['Площадь', profile.area],
    ['Что учитывать', profile.scope],
    ['Примерное число вещей', profile.itemCount],
    ['1С', has1CText(profile.has1C, profile.oneCName)],
    ['Задача', profile.problem],
    ['Особенности', profile.specifics],
  ];
  const known = fields.flatMap(([label, value]) => (value === null ? [] : [`${label}: ${value}`]));
  const agreed = profile.problemAgreed ? [PROBLEM_AGREED] : [];
  if (known.length === 0 && agreed.length === 0) {
    return null;
  }
  return ['Что клиент уже рассказал о себе (выжимка системы):', ...known, ...agreed].join('\n');
}
