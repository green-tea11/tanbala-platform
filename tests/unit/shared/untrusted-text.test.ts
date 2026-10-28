import { describe, expect, it } from 'vitest';
import {
  cleanUntrusted,
  INVISIBLE,
  INVISIBLE_EXCEPT_NEWLINE,
  limitChars,
} from '../../../src/shared/untrusted-text.js';

const INVISIBLE_OR_CONTROL = /[\p{Cc}\p{Cf}]/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Строка из кусков: число значит кодовая точка. Невидимые символы в исходнике не пишутся прямо. */
function text(...parts: readonly (string | number)[]): string {
  return parts
    .map((part) => (typeof part === 'string' ? part : String.fromCodePoint(part)))
    .join('');
}

const ZERO_WIDTH_SPACE = 0x200b;
const RIGHT_TO_LEFT_OVERRIDE = 0x202e;
const POP_DIRECTIONAL_FORMATTING = 0x202c;
const COMBINING_ACUTE = 0x0301;
const ARABIC_LIGATURE_SALLALLAHOU = 0xfdfa;

describe('shared/untrusted-text cleanUntrusted', () => {
  it('убирает управляющие Cc и невидимые Cf, включая перенос строки', () => {
    const raw = text(
      'Ай\nге',
      ZERO_WIDTH_SPACE,
      'рим',
      0,
      ' ',
      RIGHT_TO_LEFT_OVERRIDE,
      'KZ',
      POP_DIRECTIONAL_FORMATTING,
    );

    expect(cleanUntrusted(raw, INVISIBLE, 64)).toBe('Айгерим KZ');
  });

  it('с исключением для переноса строки \\n остаётся, остальное убирается', () => {
    const raw = text('Добрый', 0, ' день\r\nцена?', 7);

    expect(cleanUntrusted(raw, INVISIBLE_EXCEPT_NEWLINE, 100)).toBe('Добрый день\nцена?');
  });

  it('нормализует NFKC: полноширинные буквы, цифры в кружках, лигатуры', () => {
    const raw = text(0xff34, 0xff2f, 0xff2f, ' ', 0x2460, ' ', 0xfb01, 'le');

    expect(cleanUntrusted(raw, INVISIBLE, 64)).toBe('TOO 1 file');
  });

  it('сначала убирает невидимое, потом NFKC: результат нормализован', () => {
    const cleaned = cleanUntrusted(text('e', ZERO_WIDTH_SPACE, COMBINING_ACUTE), INVISIBLE, 64);

    expect(cleaned).toBe(text(0x00e9));
    expect(cleaned).toBe(cleaned?.normalize('NFKC'));
  });

  it('обрезает пробелы по краям, а внутри строки не трогает', () => {
    expect(cleanUntrusted('  ТОО  Ромашка \n', INVISIBLE, 64)).toBe('ТОО  Ромашка');
  });

  it('лимит считается после NFKC: строка, раздутая нормализацией, обрезается', () => {
    const ligature = text(ARABIC_LIGATURE_SALLALLAHOU);
    const cleaned = cleanUntrusted(ligature.repeat(10), INVISIBLE, 64) ?? '';

    expect(ligature.normalize('NFKC').length).toBe(18);
    expect([...cleaned]).toHaveLength(64);
  });

  it('лимит в символах не рвёт суррогатные пары', () => {
    const cleaned = cleanUntrusted(text(0x1f600).repeat(300), INVISIBLE, 200) ?? '';

    expect([...cleaned]).toHaveLength(200);
    expect(LONE_SURROGATE.test(cleaned)).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['пустая строка', ''],
    ['пробелы и невидимое', text('  ', ZERO_WIDTH_SPACE, ' ')],
    ['только управляющие', text(0, 1)],
  ])('%s => null', (_label, raw) => {
    expect(cleanUntrusted(raw, INVISIBLE, 64)).toBeNull();
  });

  it('не строка => null', () => {
    expect(cleanUntrusted(42 as unknown as string, INVISIBLE, 64)).toBeNull();
  });

  it.each([
    text('a', 0, 1, 0x1f, 0x7f, 0x80, 0x9f, 'b'),
    ' строка ',
    text('x', 0x034f, 0x180e, 0x2060, 0x2061, 0x2064, 0xfff9, 0xfffb, 'Y'),
    text(0x1f469, 0x200d, 0x1f4bb),
    text(0xff21, COMBINING_ACUTE, ZERO_WIDTH_SPACE, 0x0308),
  ])('после очистки нет Cc и Cf, строка в NFKC: %j', (raw) => {
    const cleaned = cleanUntrusted(raw, INVISIBLE, 64) ?? '';

    expect(INVISIBLE_OR_CONTROL.test(cleaned)).toBe(false);
    expect(cleaned).toBe(cleaned.normalize('NFKC'));
  });

  it('повторное применение общей регулярки не зависит от прошлых вызовов', () => {
    expect(cleanUntrusted(text('а', ZERO_WIDTH_SPACE, 'б'), INVISIBLE, 64)).toBe('аб');
    expect(cleanUntrusted(text('в', ZERO_WIDTH_SPACE, 'г'), INVISIBLE, 64)).toBe('вг');
  });
});

describe('shared/untrusted-text limitChars', () => {
  it('строка в пределах лимита не меняется', () => {
    expect(limitChars('абв', 3)).toBe('абв');
  });

  it('длиннее лимита обрезается по символам, пробел перед разрезом убирается', () => {
    expect(limitChars('ab cd', 3)).toBe('ab');
  });

  it('суррогатная пара не рвётся', () => {
    const emoji = text(0x1f600);

    expect(limitChars(`a${emoji}b`, 2)).toBe(`a${emoji}`);
  });
});
