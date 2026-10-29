import { describe, expect, it } from 'vitest';
import { amountsOf, sameAmount } from '../../../src/checks/amounts.js';
import { normalizeDraft, runCodeChecks } from '../../../src/checks/code-checks.js';
import type { PhoneDigits } from '../../../src/domain/types.js';

// Суммы для сверки цены с заметкой для бота (ревью 29.10.2026): разные записи одной суммы дают одно значение,
// количества, площади, сроки и «1С» не суммы. Текст в нижнем регистре, как его готовит code-checks.

function values(text: string): readonly (readonly [number, boolean])[] {
  return amountsOf(text).map((amount) => [amount.value, amount.priced] as const);
}

describe('checks/amounts: значения сумм', () => {
  it.each<[string, number]>([
    ['от 1 500 000 тенге', 1_500_000],
    ['от 1,5 млн', 1_500_000],
    ['от 1500 тыс.', 1_500_000],
    ['от 1.5 миллиона', 1_500_000],
    ['примерно 500к', 500_000],
    ['примерно 500k', 500_000],
    ['полтора миллиона', 1_500_000],
    ['полторы тысячи', 1_500],
    ['2 млрд', 2_000_000_000],
    ['3 миллиарда', 3_000_000_000],
    ['$100', 100],
    ['₸ 5000', 5000],
    ['скидка 5%', 5],
  ])('%s => %d, цена', (text, value) => {
    expect(values(text)).toEqual([[value, true]]);
  });

  it('сумма словом без цифр: значение неизвестно, цена', () => {
    const [amount] = amountsOf('пара миллионов');

    expect(amount?.priced).toBe(true);
    expect(Number.isNaN(amount?.value)).toBe(true);
  });

  it('сумма словом после числа не считается второй раз', () => {
    const found = amountsOf('1,5 млн и ещё миллион');

    expect(found.map((amount) => amount.index)).toEqual([0, 14]);
    expect(found[0]?.value).toBe(1_500_000);
  });

  it.each([
    'интеграция с 1с',
    'интеграция с 1с 8.3',
    'склад 5000 м2',
    'за 10 000 вещей',
    'для 5 тысяч вещей',
    '500к меток',
    'за 3 недели',
    'выезд 15 ноября',
    'до 20 метров',
  ])('не сумма: %s', (text) => {
    expect(amountsOf(text)).toEqual([]);
  });

  it('число без признака цены: сумма, но не цена', () => {
    expect(values('склад 300 и ещё')).toEqual([[300, false]]);
  });

  it('«1500000. 3 недели»: число не продолжается через «. »', () => {
    expect(values('цена 1500000. 3 недели')).toEqual([[1_500_000, true]]);
  });

  it('диапазон: левая граница берёт признак цены у правой', () => {
    expect(values('от 1 500 000 до 2 000 000 тенге')).toEqual([
      [1_500_000, true],
      [2_000_000, true],
    ]);
    expect(values('от 5-10 млн')).toEqual([
      [5, true],
      [10_000_000, true],
    ]);
  });

  it('далеко стоящие числа не диапазон', () => {
    expect(values(`склад 300 ${'и '.repeat(30)}до 2 000 000 тенге`)).toEqual([
      [300, false],
      [2_000_000, true],
    ]);
  });
});

describe('checks/amounts: сравнение значений', () => {
  it('дробь не расходится с целым из-за двоичной записи', () => {
    expect(sameAmount(1.1 * 1e6, 1_100_000)).toBe(true);
    expect(sameAmount(1_000_000, 1_500_000)).toBe(false);
  });

  it('NaN не равно ничему, даже NaN', () => {
    expect(sameAmount(Number.NaN, Number.NaN)).toBe(false);
  });
});

describe('устойчивость к долгим регуляркам: сверка с заметкой', () => {
  const BUDGET_MS = 250;
  const OWN_PHONE = '77000000001' as PhoneDigits;
  const NOTE = 'Ориентир от 1 500 000 тенге, нужен выезд. Внедрение за 2 недели.';

  it.each([
    ['цифры через пробел', '1 '.repeat(5_000)],
    ['цифры', '1'.repeat(10_000)],
    ['тенге', 'тенге '.repeat(1_670)],
    ['тенге с точками', 'тенге. '.repeat(1_430)],
    ['миллионы', 'миллион '.repeat(1_250)],
    ['полтора', 'полтора тыс '.repeat(830)],
    ['ориентир', 'ориентир '.repeat(1_100)],
    ['суммы', '1,5 млн тенге '.repeat(700)],
    ['за неделю', 'за 2 недели '.repeat(830)],
    ['тысячи с точками', '5 тыс. '.repeat(1_430)],
    ['тысячи в одной части', 'около 5 тысяч за склад '.repeat(430)],
  ])('%s: 10 000 знаков с заметкой проверяются быстро', (_name, input) => {
    const started = performance.now();
    runCodeChecks(normalizeDraft(input), { ownPhone: OWN_PHONE, clientText: '', note: NOTE });
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });

  it('заметка из длинного текста тоже разбирается быстро', () => {
    const started = performance.now();
    runCodeChecks(normalizeDraft('Коллега подсказал: от 1 500 000 тенге.'), {
      ownPhone: OWN_PHONE,
      clientText: '',
      note: '1 '.repeat(500),
    });

    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });
});
