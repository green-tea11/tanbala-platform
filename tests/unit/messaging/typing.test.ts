import { describe, expect, it } from 'vitest';
import { typingDelayMs } from '../../../src/messaging/typing.js';

const middle = (): number => 0.5;

describe('typingDelayMs', () => {
  it('около 200 мс на символ при среднем разбросе', () => {
    expect(typingDelayMs('x'.repeat(20), middle)).toBe(4000);
  });

  it('случайный разброс в пределах четверти в обе стороны', () => {
    const text = 'x'.repeat(20);

    expect(typingDelayMs(text, () => 0)).toBe(3000);
    expect(typingDelayMs(text, () => 0.999_999)).toBe(5000);
  });

  it('не меньше 1 с, даже для пустого текста', () => {
    expect(typingDelayMs('Да', () => 0)).toBe(1000);
    expect(typingDelayMs('', middle)).toBe(1000);
  });

  it('не больше 20 с для длинного текста', () => {
    expect(typingDelayMs('x'.repeat(1000), () => 0.999_999)).toBe(20_000);
  });

  it('символы считаются по кодовым точкам: эмодзи один символ', () => {
    expect(typingDelayMs('😀'.repeat(10), middle)).toBe(2000);
  });

  it.each([
    ['ниже нуля', -5, 3000],
    ['выше единицы', 7, 5000],
    ['NaN', Number.NaN, 4000],
  ])('случайность %s приводится к допустимой', (_label, value, expected) => {
    expect(typingDelayMs('x'.repeat(20), () => value)).toBe(expected);
  });
});
