// Заметка «Вернуть боту»: два поля склеиваются так же, как на сервере консоли, и чистятся как cleanBotNote бота
// (whatsapp/src/handoff/bot-note.ts), чтобы счётчик на странице совпадал с проверкой бота.

export const NOTE_MAX = 1000;

const HIDDEN = /[^\P{C}\n]/gu;

export function cleanNote(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(HIDDEN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function composeNote(answer: string, task: string): string {
  const parts = [
    answer.trim() ? `Ответ клиенту: ${answer.trim()}` : null,
    task.trim() ? `Задание боту: ${task.trim()}` : null,
  ].filter((part): part is string => part !== null);
  return cleanNote(parts.join('\n\n'));
}

/** Длина в символах Unicode (эмодзи = 1), как считает бот. */
export function noteLength(note: string): number {
  return [...note].length;
}
