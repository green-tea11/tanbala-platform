import { notImplemented } from '../shared/todo.js';

/**
 * Пауза со статусом «печатает» перед ответом, мс: бот пишет как живой менеджер, а не мгновенно.
 * random: источник случайности от 0 до 1, в тестах подменяется.
 * TODO(этап 3): около 200 мс на символ, не меньше 1 с и не больше 20 с, со случайным разбросом.
 */
export function typingDelayMs(text: string, random: () => number): number {
  return notImplemented('этап 3', 'messaging/typing.typingDelayMs');
}
