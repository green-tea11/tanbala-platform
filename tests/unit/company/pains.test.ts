import { describe, expect, it } from 'vitest';
import { mergeClientPains, promptPains } from '../../../src/company/pains.js';
import type { CompanyPain } from '../../../src/domain/company.js';
import { deepFreeze, makeBrief } from './builders.js';

describe('mergeClientPains', () => {
  it('новых болей нет и старых нет: пусто', () => {
    expect(mergeClientPains([], [])).toEqual([]);
  });

  it('первые боли просто записываются, пробелы по краям убираются', () => {
    expect(mergeClientPains([], ['  Пересорт при приёмке ', 'Долгая инвентаризация'])).toEqual([
      'Пересорт при приёмке',
      'Долгая инвентаризация',
    ]);
  });

  it('новые боли добавляются в конец, старые остаются', () => {
    expect(mergeClientPains(['a', 'b'], ['c'])).toEqual(['a', 'b', 'c']);
  });

  it('повтор без учёта регистра не дублируется, остаётся новая запись', () => {
    expect(mergeClientPains(['Пересорт при приёмке'], ['ПЕРЕСОРТ при приёмке'])).toEqual([
      'ПЕРЕСОРТ при приёмке',
    ]);
  });

  it('повтор внутри новых болей записывается один раз, берётся первый', () => {
    expect(mergeClientPains([], ['Боль', 'боль', 'БОЛЬ', 'Другая'])).toEqual(['БОЛЬ', 'Другая']);
  });

  it('пустые и пробельные строки отбрасываются', () => {
    expect(mergeClientPains(['a'], ['', '   ', '\n', 'b'])).toEqual(['a', 'b']);
  });

  it('больше пяти не бывает: теряются самые старые', () => {
    expect(mergeClientPains(['1', '2', '3', '4', '5'], ['6'])).toEqual(['2', '3', '4', '5', '6']);
    expect(mergeClientPains(['1', '2', '3', '4'], ['5', '6', '7'])).toEqual([
      '3',
      '4',
      '5',
      '6',
      '7',
    ]);
  });

  it('свежие боли не теряются: повторённая старая боль считается свежей и уходит в конец', () => {
    expect(mergeClientPains(['a', 'b', 'c', 'd', 'e'], ['a', 'f'])).toEqual([
      'c',
      'd',
      'e',
      'a',
      'f',
    ]);
  });

  it('свежих больше пяти: остаются последние пять свежих', () => {
    expect(mergeClientPains(['old'], ['1', '2', '3', '4', '5', '6', '7'])).toEqual([
      '3',
      '4',
      '5',
      '6',
      '7',
    ]);
  });

  it('повторное применение тех же болей ничего не меняет', () => {
    const once = mergeClientPains(['a', 'b'], ['c', 'b']);

    expect(mergeClientPains(once, ['c', 'b'])).toEqual(once);
  });

  it('входные списки не меняются', () => {
    const known = deepFreeze(['a', 'b']);
    const fresh = deepFreeze(['b', 'c']);

    expect(() => mergeClientPains(known, fresh)).not.toThrow();
    expect(known).toEqual(['a', 'b']);
  });
});

describe('promptPains', () => {
  const pain = (text: string): CompanyPain => ({
    pain: text,
    evidence: 'цитата 12',
    source: 'site',
  });

  it('справки нет: болей нет', () => {
    expect(promptPains(null)).toEqual([]);
  });

  it('берутся только тексты pain, без цитаты и источника', () => {
    const brief = makeBrief({
      pains: [pain('Пересорт при приёмке'), pain('Долгая инвентаризация')],
    });

    expect(promptPains(brief)).toEqual(['Пересорт при приёмке', 'Долгая инвентаризация']);
  });

  it('строки с цифрами отбрасываются', () => {
    const brief = makeBrief({
      pains: [pain('Остатки в 1С не совпадают'), pain('Долгая инвентаризация')],
    });

    expect(promptPains(brief)).toEqual(['Долгая инвентаризация']);
  });

  it.each(['2 склада', 'Склад ²', 'склад ٣', 'Склад ½'])(
    'цифры любого вида отбрасывают строку (%s)',
    (text) => {
      expect(promptPains(makeBrief({ pains: [pain(text)] }))).toEqual([]);
    },
  );

  it('не больше двух болей', () => {
    const brief = makeBrief({ pains: [pain('a'), pain('b'), pain('c')] });

    expect(promptPains(brief)).toEqual(['a', 'b']);
  });

  it('два предела вместе: сначала отбрасываются строки с цифрами, потом берутся первые две', () => {
    const brief = makeBrief({ pains: [pain('a1'), pain('b'), pain('c'), pain('d')] });

    expect(promptPains(brief)).toEqual(['b', 'c']);
  });

  it('у справки нет болей: пусто', () => {
    expect(promptPains(makeBrief({ pains: [] }))).toEqual([]);
  });
});
