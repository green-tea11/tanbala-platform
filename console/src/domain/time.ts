/** Алматы — фиксированный сдвиг UTC+5 (так считают сутки бот и почта). */
const ALMATY_OFFSET_MS = 5 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_FORM = /^(\d{4})-(\d{2})-(\d{2})$/;

/** День по Алматы: ГГГГ-ММ-ДД. */
export function almatyDay(ms: number): string {
  return new Date(ms + ALMATY_OFFSET_MS).toISOString().slice(0, 10);
}

/** Первый день месяца по Алматы для момента ms: ГГГГ-ММ-01. */
export function almatyMonthStart(ms: number): string {
  return `${almatyDay(ms).slice(0, 7)}-01`;
}

/** Часы и минуты по Алматы: ЧЧ:ММ. */
export function almatyClock(ms: number): string {
  return new Date(ms + ALMATY_OFFSET_MS).toISOString().slice(11, 16);
}

/** Настоящая ли дата ГГГГ-ММ-ДД (31 февраля — нет). */
export function isValidDay(day: string): boolean {
  const match = DAY_FORM.exec(day);
  if (match === null) return false;
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

/** День ± n дней. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Сколько дней от from до to включительно (from ≤ to). */
export function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}
