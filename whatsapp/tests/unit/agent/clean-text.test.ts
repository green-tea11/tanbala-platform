import { describe, expect, it } from 'vitest';
import { cleanLine } from '../../../src/agent/clean-text.js';

// Невидимые символы заданы кодами: в исходнике их не видно, и редактор мог бы их потерять.
const NUL = String.fromCharCode(0x0000);
const SOFT_HYPHEN = String.fromCharCode(0x00ad);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const LONE_SURROGATE = String.fromCharCode(0xd800);
const EMOJI = String.fromCodePoint(0x1f600);

describe('cleanLine', () => {
  it('убирает пробелы по краям, переносы строк, табуляции и повторные пробелы сворачивает в один', () => {
    expect(cleanLine('  магазин \n\n одежды\t и  обуви \r\n', 100)).toBe('магазин одежды и обуви');
  });

  it('управляющий символ разделяет слова', () => {
    expect(cleanLine(`склад${NUL}офис`, 100)).toBe('склад офис');
  });

  it('невидимые символы форматирования исчезают, слово не разрывается', () => {
    expect(cleanLine(`бес${SOFT_HYPHEN}плат${ZERO_WIDTH_SPACE}но`, 100)).toBe('бесплатно');
  });

  it('одиночная половинка суррогатной пары убирается: такой текст API может не принять', () => {
    expect(cleanLine(`ab${LONE_SURROGATE}cd`, 100)).toBe('abcd');
  });

  it.each([
    ['пустая строка', ''],
    ['пробелы', '   '],
    ['переносы и табуляция', '\n\t'],
    ['невидимый символ', ZERO_WIDTH_SPACE],
  ])('%s => пустая строка', (_name, text) => {
    expect(cleanLine(text, 100)).toBe('');
  });

  it('режет по знакам, а не по кодовым единицам: суррогатная пара не рвётся', () => {
    expect(cleanLine(EMOJI.repeat(5), 3)).toBe(EMOJI.repeat(3));
  });

  it('обрезанный текст не кончается пробелом', () => {
    expect(cleanLine('склад офис', 6)).toBe('склад');
  });

  it('текст короче лимита остаётся целым', () => {
    expect(cleanLine('склад', 5)).toBe('склад');
  });
});
