import { describe, expect, it } from 'vitest';
import { normalizeName } from '../../../src/company/normalize-name.js';

describe('normalizeName', () => {
  it.each([
    ['ТОО «Платформа-А»', 'платформа а'],
    ['ООО "Ромашка", г. Алматы', 'ромашка г алматы'],
    ['ИП Иванов И.И.', 'иванов и и'],
    ['LLP Alpha Group', 'alpha group'],
    ['Alpha Group Ltd.', 'alpha group'],
    ['Beta Inc', 'beta'],
    ['Gamma GmbH', 'gamma'],
    ['JSC Delta', 'delta'],
    ['Epsilon LLC', 'epsilon'],
    ['АО Зета', 'зета'],
    ['ЗАО Эта', 'эта'],
    ['ОАО Тета', 'тета'],
  ])('«%s» даёт «%s»', (raw, expected) => {
    expect(normalizeName(raw)).toBe(expected);
  });

  it('нижний регистр и ё => е', () => {
    expect(normalizeName('ЁЛКА Склад')).toBe('елка склад');
    expect(normalizeName('Ёж')).toBe('еж');
  });

  it('все виды кавычек и знаков препинания убираются', () => {
    expect(normalizeName('«Альфа»')).toBe('альфа');
    expect(normalizeName('"Альфа"')).toBe('альфа');
    expect(normalizeName('“Альфа”')).toBe('альфа');
    expect(normalizeName('„Альфа“')).toBe('альфа');
    expect(normalizeName("O'Brien & Co.")).toBe('o brien co');
  });

  it('пробелы, табуляции и переносы схлопываются в один', () => {
    expect(normalizeName('  Альфа \t\n  Групп  ')).toBe('альфа групп');
  });

  it('цифры остаются', () => {
    expect(normalizeName('Склад 24')).toBe('склад 24');
  });

  it('форма собственности убирается только отдельным словом', () => {
    expect(normalizeName('Ипподром')).toBe('ипподром');
    expect(normalizeName('Аотеа')).toBe('аотеа');
    expect(normalizeName('Инкубатор')).toBe('инкубатор');
  });

  it('разный регистр и оформление одного названия дают одну строку', () => {
    const forms = ['ТОО «Альфа»', 'альфа', 'АЛЬФА', 'Альфа ТОО', ' "Альфа" ', 'ИП  Альфа.'];

    expect(new Set(forms.map(normalizeName))).toEqual(new Set(['альфа']));
  });

  it('одна форма собственности без названия и пустая строка дают пустую строку', () => {
    expect(normalizeName('ТОО')).toBe('');
    expect(normalizeName('ИП ООО')).toBe('');
    expect(normalizeName('«»')).toBe('');
    expect(normalizeName('')).toBe('');
    expect(normalizeName('   ')).toBe('');
  });
});
