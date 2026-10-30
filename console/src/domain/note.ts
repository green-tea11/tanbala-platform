import { codePointLength, normalizeNewlines } from '../shared/text.js';

/** Предел заметки бота (символы Unicode), как у старой панели и у самого бота. */
export const NOTE_MAX_LENGTH = 1000;

const ANSWER_LABEL = 'Ответ клиенту: ';
const TASK_LABEL = 'Задание боту: ';

export type NoteComposition =
  | { readonly ok: true; readonly note: string; readonly length: number }
  | { readonly ok: false; readonly length: number; readonly message: string };

/**
 * «Вернуть боту» с двумя полями: консоль склеивает их в одну заметку бота с подписями «Ответ клиенту: …» и
 * «Задание боту: …» через пустую строку; пустые части пропускаются (обе пустые — пустая заметка). Предел 1000
 * символов у итоговой заметки, проверяется до вызова бота.
 */
/** Управляющие, невидимые (Cf), суррогаты, частные и неназначенные символы, кроме перевода строки. */
const HIDDEN = /[^\P{C}\n]/gu;

/** Та же чистка, что cleanBotNote бота (whatsapp/src/handoff/bot-note.ts): длина считается так же, как у бота. */
export function cleanNote(raw: string): string {
  return normalizeNewlines(raw.normalize('NFC'))
    .replace(/\t/g, ' ')
    .replace(HIDDEN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function composeNote(answer: string, task: string): NoteComposition {
  const parts = [
    { label: ANSWER_LABEL, text: cleanNote(answer) },
    { label: TASK_LABEL, text: cleanNote(task) },
  ]
    .filter((part) => part.text !== '')
    .map((part) => `${part.label}${part.text}`);
  const note = parts.join('\n\n');
  const length = codePointLength(note);
  if (length > NOTE_MAX_LENGTH) {
    return {
      ok: false,
      length,
      message: `Заметка вместе с подписями длиннее ${NOTE_MAX_LENGTH} символов (сейчас ${length}): сократите её.`,
    };
  }
  return { ok: true, note, length };
}
