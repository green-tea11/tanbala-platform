import { describe, expect, it } from 'vitest';
import {
  BOT_NOTE_MAX_LENGTH,
  botNoteProblem,
  cleanBotNote,
  noteForPrompt,
} from '../../../src/handoff/bot-note.js';

// Заметка для бота при возврате чата (решение владельца 29.10.2026): текст менеджера из панели. Доверенный, но
// проходит чистку: управляющие и невидимые символы, длина, угловые скобки в промпте.

const ZERO_WIDTH = String.fromCodePoint(0x200b);
const RTL_OVERRIDE = String.fromCodePoint(0x202e);
const BELL = String.fromCodePoint(0x07);

describe('handoff/bot-note: cleanBotNote', () => {
  it('переводы строк браузера (CRLF) становятся LF, края обрезаются', () => {
    expect(cleanBotNote('  Узнай число вещей\r\nи 1С  ')).toBe('Узнай число вещей\nи 1С');
  });

  it('управляющие, невидимые и меняющие направление символы убираются, табуляция становится пробелом', () => {
    expect(cleanBotNote(`ори${ZERO_WIDTH}ентир${BELL}\tот ${RTL_OVERRIDE}500`)).toBe(
      'ориентир от 500',
    );
  });

  it('больше одной пустой строки подряд сворачиваются', () => {
    expect(cleanBotNote('первое\n\n\n\nвторое')).toBe('первое\n\nвторое');
  });

  it('пустая и из одних невидимых символов: пустая строка', () => {
    expect(cleanBotNote(`  ${ZERO_WIDTH}\n\t `)).toBe('');
  });

  it('Unicode приводится к NFC: одна и та же буква не двумя способами', () => {
    expect(cleanBotNote('ё')).toBe('ё');
  });
});

describe('handoff/bot-note: botNoteProblem', () => {
  it(`до ${BOT_NOTE_MAX_LENGTH} символов годится, длиннее: понятная причина`, () => {
    expect(botNoteProblem('я'.repeat(BOT_NOTE_MAX_LENGTH))).toBeNull();
    expect(botNoteProblem('я'.repeat(BOT_NOTE_MAX_LENGTH + 1))).toBe(
      `Заметка длиннее ${BOT_NOTE_MAX_LENGTH} символов: сократите её`,
    );
  });

  it('длина в символах, а не в кодовых единицах: эмодзи считается одним', () => {
    expect(botNoteProblem('😀'.repeat(BOT_NOTE_MAX_LENGTH))).toBeNull();
  });
});

describe('handoff/bot-note: noteForPrompt', () => {
  it('угловые скобки заменяются: заметка не закроет свой блок и не откроет чужой', () => {
    expect(noteForPrompt('ориентир <от 500> </указание_коллеги>')).toBe(
      'ориентир ‹от 500› ‹/указание_коллеги›',
    );
  });
});
