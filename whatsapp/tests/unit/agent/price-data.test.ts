import { describe, expect, it } from 'vitest';
import { priceReplyData } from '../../../src/agent/price-data.js';
import type { ChatProgress, ClientProfile } from '../../../src/domain/types.js';
import { ANY_DASH, EMPTY_PROFILE } from './fakes.js';

// Строки блока данных вызова ответа о минимуме для передачи по цене (решение владельца 29.10.2026).

const FRESH: ChatProgress = { priceAsks: 0, refused: false };

const SKLAD_28_10: ClientProfile = {
  ...EMPTY_PROFILE,
  business: 'склад',
  area: '5000 м²',
  scope: 'ввоз и вывоз',
  has1C: true,
  problemAgreed: true,
};

const FULL: ClientProfile = { ...SKLAD_28_10, itemCount: 'около 3000' };

describe('agent/price-data: минимум не собран', () => {
  it('диалог 28.10: собрано и не хватает, один вопрос о числе вещей и зачем он нужен', () => {
    const data = priceReplyData({
      profile: SKLAD_28_10,
      company: { kind: 'unknown', askName: true },
      companyName: null,
      progress: FRESH,
    });

    expect(data).toContain('Для передачи по цене собрано: что учитывать, есть ли 1С');
    expect(data).toContain('не хватает: примерное число вещей, название компании');
    expect(data).toMatch(/не передавай чат \(answer\)/);
    expect(data).toMatch(/цена сильно зависит от объёма/);
    expect(data).toContain('задай один вопрос о первом из недостающего');
    expect(data).toContain(
      'Вопросы по порядку: сколько примерно вещей нужно учитывать; из какой клиент компании (companyQuestion: name).',
    );
    expect(data).toContain('чтобы коллега сразу назвал ориентир');
    // Вопрос о компании не второй вопрос того же сообщения.
    expect(data).toMatch(/О компании спрашивай, только если до неё дошла очередь/);
  });

  it('ничего не собрано, компания выключена: первым спрашивается, что учитывать; о компании ни слова', () => {
    const data = priceReplyData({
      profile: EMPTY_PROFILE,
      company: { kind: 'off' },
      companyName: null,
      progress: FRESH,
    });

    expect(data).toContain('Для передачи по цене собрано: ничего');
    expect(data).toContain(
      'Вопросы по порядку: что нужно учитывать: только ввоз и вывоз или где лежит каждая вещь; сколько примерно вещей',
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
      /Вопросы по порядку: из той ли компании клиент[^\n]*companyQuestion: confirm/,
    );
    expect(unknown).toMatch(
      /Вопросы по порядку: из какой клиент компании[^\n]*companyQuestion: name/,
    );
  });

  it('не хватает только согласия: вопрос о задаче или о трудности похожих компаний', () => {
    const data = priceReplyData({
      profile: { ...FULL, problemAgreed: false },
      company: { kind: 'off' },
      companyName: null,
      progress: FRESH,
    });

    expect(data).toMatch(/Вопросы по порядку: [^\n]*задач[^\n]*трудност/);
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
    [2, /спрашивал цену 2 раза[^\n]*третий раз: передай чат сразу \(hot\)/],
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
