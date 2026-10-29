import { describe, expect, it } from 'vitest';
import { priceReplyData } from '../../../src/agent/price-data.js';
import type { ChatProgress, ClientProfile } from '../../../src/domain/types.js';
import { ANY_DASH, EMPTY_PROFILE } from './fakes.js';

// Строки блока данных вызова ответа о минимуме для передачи по цене (решение владельца 29.10.2026).

const FRESH: ChatProgress = { priceAsks: 0, refused: false };

/** Живой тест 29.10: склад 5000 м², ввоз и вывоз, 1С; число позиций клиент назовёт в следующем сообщении. */
const SKLAD_28_10: ClientProfile = {
  ...EMPTY_PROFILE,
  business: 'склад',
  area: '5000 м²',
  scope: 'ввоз и вывоз',
  has1C: true,
  problemAgreed: true,
  items: null,
  packaging: null,
  material: null,
  city: null,
  premises: 'склад',
  turnover: null,
  currentTracking: null,
  inferred: [],
};

const FULL: ClientProfile = {
  ...SKLAD_28_10,
  itemCount: 'около 3000',
  items: 'запчасти',
  material: 'металл',
  city: 'Алматы',
};

describe('agent/price-data: минимум не собран', () => {
  it('живой тест 29.10: собрано и не хватает, вопросы группами по порядку и фраза об ориентире', () => {
    const data = priceReplyData({
      profile: SKLAD_28_10,
      company: { kind: 'unknown', askName: true },
      companyName: null,
      progress: FRESH,
    });

    expect(data).toContain('Для передачи по цене собрано: тип помещения, есть ли 1С');
    expect(data).toContain(
      'не хватает: какие вещи, материал, примерное число вещей, город, название компании',
    );
    expect(data).toMatch(/не передавай чат \(answer\)/);
    expect(data).toContain('напиши «Ориентир коллега назовёт, когда поймём ваш объект.»');
    expect(data).toContain('задай одним блоком вопросы первой группы, где есть недостающее');
    expect(data).toContain(
      'Недостающее по группам: 1) из какой клиент компании (companyQuestion: name); 2) какие вещи клиент хочет учитывать, из какого материала вещи: есть ли металл или жидкости; 3) в каком городе объект, сколько примерно вещей нужно учитывать.',
    );
    expect(data).toContain('Вопросов других групп в этом сообщении не задавай.');
    expect(data).not.toContain('чтобы коллега сразу назвал ориентир');
    expect(data).not.toMatch(/один вопрос/);
  });

  it('ничего не собрано, компания выключена: первым спрашивается, какие вещи; о компании ни слова', () => {
    const data = priceReplyData({
      profile: EMPTY_PROFILE,
      company: { kind: 'off' },
      companyName: null,
      progress: FRESH,
    });

    expect(data).toContain('Для передачи по цене собрано: ничего');
    expect(data).toContain(
      'Недостающее по группам: 1) какие вещи клиент хочет учитывать, из какого материала вещи',
    );
    expect(data).not.toMatch(/компани/i);
  });

  it('не хватает только компании: вопрос о ней по блоку о компании (confirm или name)', () => {
    const candidate = priceReplyData({
      profile: FULL,
      company: { kind: 'candidate', name: 'ТОО Береке', city: null, withCity: false },
      companyName: null,
      progress: FRESH,
    });
    const unknown = priceReplyData({
      profile: FULL,
      company: { kind: 'unknown', askName: true },
      companyName: null,
      progress: FRESH,
    });

    expect(candidate).toMatch(
      /Недостающее по группам: 1\) из той ли компании клиент[^\n]*companyQuestion: confirm/,
    );
    expect(unknown).toMatch(
      /Недостающее по группам: 1\) из какой клиент компании[^\n]*companyQuestion: name/,
    );
  });

  it('не хватает только города: вопрос о городе; согласие с трудностью для минимума не нужно', () => {
    const data = priceReplyData({
      profile: { ...FULL, problemAgreed: false, city: null },
      company: { kind: 'off' },
      companyName: null,
      progress: FRESH,
    });

    expect(data).toContain('не хватает: город.');
    expect(data).toContain('Недостающее по группам: 1) в каком городе объект.');
  });

  it('сказанное в последнем сообщении считается выясненным: выжимка до него', () => {
    const data = priceReplyData({
      profile: EMPTY_PROFILE,
      company: undefined,
      companyName: null,
      progress: FRESH,
    });

    expect(data).toMatch(/последнем сообщении[^\n]*выясненным/);
  });
});

describe('agent/price-data: минимум собран и исключения', () => {
  it('минимум собран: при вопросе цены передать чат (hot), без вопросов', () => {
    const data = priceReplyData({
      profile: FULL,
      company: { kind: 'confirmed', name: 'ТОО Склад', rubric: null, pains: [], emailed: false },
      companyName: 'ТОО Склад',
      progress: FRESH,
    });

    expect(data).toMatch(/Минимум для передачи по цене собран[^\n]*hot/);
    expect(data).not.toMatch(/не хватает/);
  });

  it('компанию спросить нельзя: она не мешает и не упоминается среди недостающего', () => {
    const data = priceReplyData({
      profile: FULL,
      company: { kind: 'asked', name: 'ТОО Береке', city: null, awaitingAnswer: false },
      companyName: null,
      progress: FRESH,
    });

    expect(data).toMatch(/Минимум для передачи по цене собран/);
  });

  it.each([
    [0, /цену ещё не спрашивал/],
    [1, /спрашивал цену 1 раз/],
    [2, /спрашивал цену 2 раза\./],
    [3, /спрашивал цену 3 раза[^\n]*четвёртый раз: передай чат сразу \(hot\)/],
    [5, /спрашивал цену 5 раз[^\n]*передай чат сразу \(hot\)/],
    [12, /спрашивал цену 12 раз\./],
    [22, /спрашивал цену 22 раза\./],
  ])('вопросов цены до этого сообщения %s', (priceAsks, expected) => {
    const data = priceReplyData({
      profile: EMPTY_PROFILE,
      company: undefined,
      companyName: null,
      progress: { priceAsks, refused: false },
    });

    expect(data).toMatch(expected);
  });

  it('клиент отказывался отвечать: при вопросе цены передать сразу', () => {
    const data = priceReplyData({
      profile: EMPTY_PROFILE,
      company: undefined,
      companyName: null,
      progress: { priceAsks: 1, refused: true },
    });

    expect(data).toMatch(/отказывался отвечать[^\n]*передай чат сразу \(hot\)/);
  });

  it('просьба о человеке и жалоба передаются сразу при любом минимуме', () => {
    const data = priceReplyData({
      profile: EMPTY_PROFILE,
      company: undefined,
      companyName: null,
      progress: FRESH,
    });

    expect(data).toMatch(/asked_human[^\n]*complaint|complaint[^\n]*asked_human/);
  });

  it('без тире', () => {
    const data = priceReplyData({
      profile: SKLAD_28_10,
      company: { kind: 'unknown', askName: true },
      companyName: null,
      progress: { priceAsks: 2, refused: true },
    });

    expect(data).not.toMatch(ANY_DASH);
  });
});

describe('agent/price-data: заметка с суммой (ревью 29.10.2026, второй круг)', () => {
  it('в заметке есть сумма: строки не велят передавать чат при отказе и четвёртом вопросе, а велят назвать сумму', () => {
    const data = priceReplyData({
      profile: SKLAD_28_10,
      company: { kind: 'off' },
      companyName: null,
      progress: { priceAsks: 3, refused: true },
      hasNote: true,
      notePrice: true,
    });

    expect(data).not.toMatch(/передай чат сразу/);
    expect(data).toMatch(
      /В указании коллеги есть ориентир цены: на вопрос цены отвечай им, ровно как в указании, и чат не передавай/,
    );
    expect(data).toMatch(/спрашивал цену 3 раза/);
    expect(data).not.toMatch(ANY_DASH);
  });

  it('заметка без суммы: отказ и четвёртый вопрос по-прежнему передают чат', () => {
    const data = priceReplyData({
      profile: SKLAD_28_10,
      company: { kind: 'off' },
      companyName: null,
      progress: { priceAsks: 3, refused: true },
      hasNote: true,
      notePrice: false,
    });

    expect(data).toMatch(/это четвёртый раз: передай чат сразу \(hot\)/);
    expect(data).toMatch(
      /отказывался отвечать на вопросы: если он спрашивает цену, передай чат сразу/,
    );
  });
});
