import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const BACKSPACE = new Set(['\u007f', '\b']);
const ENTER = new Set(['\r', '\n']);

/** Поток ввода терминала с переключением режима без эха (process.stdin, когда это TTY). */
export interface TtyInput extends Readable {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

/** Прервано: Ctrl+C или конец ввода до Enter. */
export class PromptCancelled extends Error {
  override readonly name = 'PromptCancelled';
}

/** Обрабатывает символы, набранные в терминале без эха; возвращает готовую строку или null, пока Enter не нажат. */
export function applyKeys(buffer: string, chunk: string): { buffer: string; done: boolean } {
  let current = buffer;
  for (const char of chunk) {
    if (char === CTRL_C || char === CTRL_D) throw new PromptCancelled('Ввод прерван');
    if (ENTER.has(char)) return { buffer: current, done: true };
    current = BACKSPACE.has(char) ? Array.from(current).slice(0, -1).join('') : current + char;
  }
  return { buffer: current, done: false };
}

/** Пароль из терминала: сырой режим, символы не выводятся, Enter завершает. */
function readHidden(input: TtyInput, output: Writable, prompt: string): Promise<string> {
  output.write(prompt);
  input.setRawMode?.(true);
  input.setEncoding('utf8');
  input.resume();
  return new Promise((resolve, reject) => {
    let buffer = '';
    const finish = (error: Error | null): void => {
      input.removeListener('data', onData);
      input.setRawMode?.(false);
      input.pause();
      output.write('\n');
      if (error === null) resolve(buffer);
      else reject(error);
    };
    const onData = (chunk: string): void => {
      try {
        const next = applyKeys(buffer, chunk);
        buffer = next.buffer;
        if (next.done) finish(null);
      } catch (error: unknown) {
        finish(error instanceof Error ? error : new PromptCancelled('Ввод прерван'));
      }
    };
    input.on('data', onData);
  });
}

/** Строки stdin, когда это не терминал (пароль передан через канал): по строке на вызов. */
function createLineReader(input: Readable): (prompt: string) => Promise<string> {
  const lines = createInterface({ input, terminal: false })[Symbol.asyncIterator]();
  return async () => {
    const next = await lines.next();
    if (next.done === true) throw new PromptCancelled('Пароль не передан в stdin');
    return next.value;
  };
}

/** Чтение пароля без эха: в терминале — сырой режим, иначе — строка из stdin. */
export function createPasswordReader(
  input: TtyInput,
  output: Writable,
): { readonly interactive: boolean; read(prompt: string): Promise<string> } {
  if (input.isTTY === true && input.setRawMode !== undefined) {
    return { interactive: true, read: (prompt) => readHidden(input, output, prompt) };
  }
  return { interactive: false, read: createLineReader(input) };
}
