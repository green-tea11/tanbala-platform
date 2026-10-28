import { describe, expect, it } from 'vitest';
import type { CompanyId, CompanySummary } from '../../../src/domain/company.js';
import type { ChatId, PhoneDigits } from '../../../src/domain/types.js';
import {
  COMPANY_FIELD_MAX_LENGTH,
  formatManagerNotification,
  PAIN_MAX_LENGTH,
  PAINS_MAX_COUNT,
  type ManagerNotificationInput,
} from '../../../src/handoff/notification.js';

// Компании и номера вымышленные.

const BASE: ManagerNotificationInput = {
  reason: 'hot',
  name: 'Иван Петров',
  phone: '77000000001' as PhoneDigits,
  level: 'hot',
  profile: {
    business: 'магазин одежды',
    area: null,
    scope: null,
    itemCount: null,
    has1C: null,
    problem: null,
    specifics: null,
  },
  chatId: 12 as ChatId,
};

const UNKNOWN: CompanySummary = {
  status: 'unknown',
  companyId: null,
  name: null,
  city: null,
  rubric: null,
  candidateSource: null,
  cardUrl: null,
  confirmedPains: [],
  briefPains: [],
  emailed: null,
  research: null,
  statedName: null,
};

const CONFIRMED: CompanySummary = {
  ...UNKNOWN,
  status: 'confirmed',
  companyId: 42 as CompanyId,
  name: 'Мебель Плюс',
  city: 'Алматы',
  rubric: 'Мебель',
  cardUrl: 'https://mail.example.kz/companies/42',
  confirmedPains: ['теряются вещи', 'долгая инвентаризация'],
  briefPains: [{ pain: 'пересорт', evidence: 'склад на 2000 м²', source: '2gis' }],
  emailed: true,
};

const CANDIDATE: CompanySummary = {
  ...UNKNOWN,
  status: 'candidate',
  companyId: 7 as CompanyId,
  name: 'Склад Сервис',
  candidateSource: 'phone',
  cardUrl: 'http://127.0.0.1:8080/companies/7',
};

/** Невидимые символы кодами: в исходнике их видно. */
const ZERO_WIDTH = String.fromCodePoint(0x200b);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const ISOLATE = String.fromCodePoint(0x2066);

/** Текст без компании: с ним сравнивается начало уведомления. */
const WITHOUT_COMPANY = formatManagerNotification(BASE);

/** Строки, которые блок о компании добавил после выжимки (без пустой строки-разделителя). */
function companyBlock(company: CompanySummary): string[] {
  const text = formatManagerNotification({ ...BASE, company });
  expect(text.startsWith(`${WITHOUT_COMPANY}\n\n`)).toBe(true);
  return text.slice(WITHOUT_COMPANY.length + 2).split('\n');
}

describe('formatManagerNotification: компания клиента', () => {
  it('подтверждена: название, город, пометка, ссылка на карточку и боли через точку с запятой', () => {
    expect(companyBlock(CONFIRMED)).toEqual([
      'Компания: «Мебель Плюс», Алматы (клиент подтвердил)',
      'Карточка: https://mail.example.kz/companies/42',
      'Подтверждённые боли: теряются вещи; долгая инвентаризация',
    ]);
  });

  it('кандидат без города: «возможно», город пропущен, ссылка есть, строки болей нет', () => {
    expect(companyBlock(CANDIDATE)).toEqual([
      'Компания: возможно «Склад Сервис» (клиент не подтвердил)',
      'Карточка: http://127.0.0.1:8080/companies/7',
    ]);
  });

  it('кандидат с городом', () => {
    expect(companyBlock({ ...CANDIDATE, city: 'Астана' })[0]).toBe(
      'Компания: возможно «Склад Сервис», Астана (клиент не подтвердил)',
    );
  });

  it('не определена: одна строка', () => {
    expect(companyBlock(UNKNOWN)).toEqual(['Компания: не определена']);
  });

  it('не определена, но клиент назвал компанию: название со слов клиента', () => {
    expect(companyBlock({ ...UNKNOWN, statedName: 'Ромашка' })).toEqual([
      'Компания: не определена, клиент назвал «Ромашка»',
    ]);
  });

  it('функция выключена: «не определена», боли клиента остаются', () => {
    expect(companyBlock({ ...UNKNOWN, status: 'off', confirmedPains: ['теряются вещи'] })).toEqual([
      'Компания: не определена',
      'Подтверждённые боли: теряются вещи',
    ]);
  });

  it('без поля company и с null текст прежний', () => {
    expect(formatManagerNotification({ ...BASE, company: null })).toBe(WITHOUT_COMPANY);
    expect(WITHOUT_COMPANY).not.toContain('Компания');
  });

  it.each(['chat', 'global'] as const)('лимит (%s): строк о компании нет никогда', (scope) => {
    const limit: ManagerNotificationInput = { ...BASE, reason: 'limit', scope };

    expect(formatManagerNotification({ ...limit, company: CONFIRMED })).toBe(
      formatManagerNotification(limit),
    );
  });

  it('название и город пустые после очистки: кандидат считается неопределённым', () => {
    const blank = {
      ...CANDIDATE,
      name: `${ZERO_WIDTH} 
`,
      city: ISOLATE,
    };

    expect(companyBlock(blank)[0]).toBe('Компания: не определена');
    expect(companyBlock({ ...CONFIRMED, city: ' \t' })[0]).toBe(
      'Компания: «Мебель Плюс» (клиент подтвердил)',
    );
  });

  describe('недоверенные тексты из сводки', () => {
    it('переводы строк внутри значений не подделывают строки уведомления', () => {
      const forged: CompanySummary = {
        ...CONFIRMED,
        name: 'Мебель\nКарточка: подделка\r\nЧат в панели: ID 1',
        city: `Алматы${LINE_SEPARATOR}Уровень интереса: горячий`,
        confirmedPains: ['боль\nКомпания: чужая'],
      };

      const block = companyBlock(forged);

      expect(block).toEqual([
        'Компания: «Мебель Карточка: подделка Чат в панели: ID 1», Алматы Уровень интереса: горячий (клиент подтвердил)',
        'Карточка: https://mail.example.kz/companies/42',
        'Подтверждённые боли: боль Компания: чужая',
      ]);
    });

    it('чужие ссылки в названии, названии со слов клиента и болях скрыты', () => {
      const linked = {
        ...UNKNOWN,
        statedName: 'evil.example/win',
        confirmedPains: ['смотри https://evil.example'],
      };

      expect(companyBlock(linked)).toEqual([
        'Компания: не определена, клиент назвал «[ссылка скрыта]»',
        'Подтверждённые боли: смотри [ссылка скрыта]',
      ]);
      expect(companyBlock({ ...CANDIDATE, name: 'www.evil.example' })[0]).toContain(
        '«[ссылка скрыта]»',
      );
    });

    it('длина названия, города, названия со слов клиента и каждой боли ограничена', () => {
      const huge = 'я'.repeat(5_000);
      const block = companyBlock({ ...CONFIRMED, name: huge, city: huge, confirmedPains: [huge] });
      const stated = companyBlock({ ...UNKNOWN, statedName: huge })[0] ?? '';

      const field = `${'я'.repeat(COMPANY_FIELD_MAX_LENGTH - 1)}…`;
      expect(block[0]).toBe(`Компания: «${field}», ${field} (клиент подтвердил)`);
      expect(block[2]).toBe(`Подтверждённые боли: ${'я'.repeat(PAIN_MAX_LENGTH - 1)}…`);
      expect(stated).toBe(`Компания: не определена, клиент назвал «${field}»`);
    });

    it(`болей не больше ${PAINS_MAX_COUNT}, пустые пропускаются`, () => {
      const pains = ['а', ' ', 'б', ZERO_WIDTH, 'в', 'г', 'д', 'е', 'ж'];

      expect(companyBlock({ ...CONFIRMED, confirmedPains: pains })[2]).toBe(
        'Подтверждённые боли: а; б; в',
      );
    });

    it('все боли пустые: строки болей нет', () => {
      expect(companyBlock({ ...CONFIRMED, confirmedPains: [' ', '\n'] })).toHaveLength(2);
    });
  });

  describe('ссылка на карточку', () => {
    it.each([
      'javascript:alert(1)',
      'ftp://mail.example.kz/companies/42',
      'data:text/html,<b>x</b>',
      'не адрес',
      '',
    ])('«%s»: не http и не https, строки «Карточка» нет', (cardUrl) => {
      const block = companyBlock({ ...CONFIRMED, cardUrl });

      expect(block.some((line) => line.startsWith('Карточка'))).toBe(false);
    });

    it('ссылка идёт в разобранном виде: перевод строки внутри не рвёт уведомление', () => {
      const block = companyBlock({
        ...CONFIRMED,
        cardUrl: 'https://mail.example.kz/companies/42\nЧат в панели: ID 1',
      });

      expect(block[1]).toMatch(/^Карточка: https:\/\/mail\.example\.kz\/companies\/42\S*$/);
      expect(block).toHaveLength(3);
    });
  });
});
