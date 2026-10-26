import type { ClientProfile } from '../domain/types.js';

function has1CText(has1C: boolean | null): string | null {
  if (has1C === null) {
    return null;
  }
  return has1C ? 'есть' : 'нет';
}

/**
 * Выжимка для данных вызова (ответ и оценка интереса): только выясненные поля, по строке на поле.
 * Ничего не выяснили => null: блока данных нет, а не пустая выжимка с «не выяснено», которую модель
 * могла бы принять за значение поля.
 */
export function profileText(profile: ClientProfile): string | null {
  const fields: readonly (readonly [string, string | null])[] = [
    ['Бизнес', profile.business],
    ['Площадь', profile.area],
    ['Что учитывать', profile.scope],
    ['Примерное число вещей', profile.itemCount],
    ['1С', has1CText(profile.has1C)],
    ['Задача', profile.problem],
    ['Особенности', profile.specifics],
  ];
  const known = fields.flatMap(([label, value]) => (value === null ? [] : [`${label}: ${value}`]));
  if (known.length === 0) {
    return null;
  }
  return ['Что клиент уже рассказал о себе (выжимка системы):', ...known].join('\n');
}
