import { describe, expect, it } from 'vitest';
import { clipText } from '../../../src/company/clip-text.js';

describe('clipText', () => {
  it.each([null, '', '   ', '\n\t  \n'])('пустое значение %j даёт null', (raw) => {
    expect(clipText(raw, 10)).toBeNull();
  });

  it('убирает пробелы и переносы по краям, внутри оставляет как есть', () => {
    expect(clipText('  \n Платформа  А \t', 50)).toBe('Платформа  А');
  });

  it('текст ровно по лимиту остаётся целым, на знак длиннее обрезается', () => {
    expect(clipText('abcde', 5)).toBe('abcde');
    expect(clipText('abcdef', 5)).toBe('abcde');
  });

  it('после обрезки хвостовые пробелы убираются: слово не заканчивается пустотой', () => {
    expect(clipText('ab cd', 3)).toBe('ab');
  });

  it('обрезает по знакам: эмодзи (суррогатная пара) не рвётся пополам', () => {
    const text = '😀'.repeat(5);

    const clipped = clipText(text, 3);

    expect(clipped).toBe('😀😀😀');
    expect(encodeURIComponent(clipped ?? '')).toBeTypeOf('string');
  });

  it('лимит считается в знаках, а не в кодовых единицах UTF-16', () => {
    expect(Array.from(clipText('я'.repeat(300), 200) ?? '')).toHaveLength(200);
  });

  it('текст из одних пробелов после обрезки по лимиту нуля тоже даёт null', () => {
    expect(clipText('   x', 0)).toBeNull();
  });
});
