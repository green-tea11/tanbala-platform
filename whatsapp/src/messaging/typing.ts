/** Скорость «набора»: около 200 мс на символ. */
const MS_PER_CHAR = 200;
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 20_000;
/** Случайный разброс: до четверти в обе стороны. */
const JITTER = 0.25;
/** Случайность NaN считается серединой: пауза без разброса. */
const MIDDLE = 0.5;

/**
 * Пауза со статусом «печатает» перед ответом, мс: бот пишет как живой менеджер, а не мгновенно.
 * Около 200 мс на символ (кодовую точку: эмодзи один символ) с разбросом до 25% в обе стороны,
 * не меньше 1 с и не больше 20 с. random: источник случайности от 0 до 1, в тестах подменяется;
 * значение вне [0, 1] прижимается к границе, NaN считается серединой.
 */
export function typingDelayMs(text: string, random: () => number): number {
  const chars = [...text].length;
  const factor = 1 - JITTER + 2 * JITTER * unitInterval(random());
  return Math.round(Math.min(Math.max(chars * MS_PER_CHAR * factor, MIN_DELAY_MS), MAX_DELAY_MS));
}

function unitInterval(value: number): number {
  return Number.isNaN(value) ? MIDDLE : Math.min(Math.max(value, 0), 1);
}
