import { describe, expect, it } from 'vitest';
import { wroteAfterLetter } from '../../src/domain/after-letter.js';
import { composeNote, NOTE_MAX_LENGTH } from '../../src/domain/note.js';
import {
  rowCostUsd,
  rowsBetween,
  spendByDay,
  sumSpend,
  type TokenRow,
} from '../../src/domain/spend.js';
import {
  addDays,
  almatyClock,
  almatyDay,
  almatyMonthStart,
  daysInclusive,
  isValidDay,
} from '../../src/domain/time.js';
import { errorMessage } from '../../src/domain/messages.js';
import {
  cleanLine,
  codePointLength,
  cutCodePoints,
  hasControlChars,
} from '../../src/shared/text.js';
import { PRICES } from '../helpers/fixtures.js';

function row(overrides: Partial<TokenRow>): TokenRow {
  return {
    day: '2026-10-30',
    model: 'claude-haiku-5-5',
    calls: 1,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ...overrides,
  };
}

describe('расход по таблице цен', () => {
  it('формула llm.py: вход, выход, чтение и запись кэша за миллион', () => {
    const haiku = PRICES['claude-haiku-5-5'];
    expect(rowCostUsd(row({ input: 1_000_000 }), haiku)).toBe(0.1);
    expect(rowCostUsd(row({ output: 1_000_000 }), haiku)).toBe(0.5);
    expect(rowCostUsd(row({ cacheRead: 1_000_000 }), haiku)).toBe(0.01);
    expect(rowCostUsd(row({ cacheWrite: 1_000_000 }), haiku)).toBe(0.125);
  });

  it('сумма с кэшем; модель без цены — в unpricedTokens, а не по самой дорогой', () => {
    const total = sumSpend(
      [
        row({ input: 1000, output: 200, cacheRead: 10_000, cacheWrite: 2000, calls: 3 }),
        row({ model: 'claude-sonnet-5-5', input: 1000, output: 100, calls: 2 }),
        row({ model: 'claude-new-6', input: 70, output: 30, calls: 1 }),
      ],
      PRICES,
    );
    expect(total).toEqual({
      usd: 0.00355,
      tokens: 14_400,
      unpricedTokens: 100,
      calls: 6,
      notCountedCalls: 0,
    });
  });

  it('расшифровка OpenRouter не оценивается: только число вызовов «не учтено»', () => {
    const total = sumSpend(
      [row({ provider: 'openrouter', model: 'elevenlabs/scribe-v2', calls: 4, input: 9 })],
      PRICES,
    );
    expect(total).toEqual({ usd: 0, tokens: 0, unpricedTokens: 0, calls: 0, notCountedCalls: 4 });
  });

  it('нет таблицы цен: usd null, все токены без цены', () => {
    expect(sumSpend([row({ input: 10 })], null)).toEqual({
      usd: null,
      tokens: 10,
      unpricedTokens: 10,
      calls: 1,
      notCountedCalls: 0,
    });
  });

  it('по дням по возрастанию; выборка дней включительно', () => {
    const rows = [
      row({ day: '2026-10-30', input: 10 }),
      row({ day: '2026-10-01', input: 1_000_000 }),
    ];
    expect(spendByDay(rows, PRICES).map((day) => [day.day, day.usd])).toEqual([
      ['2026-10-01', 0.1],
      ['2026-10-30', 0.000001],
    ]);
    expect(rowsBetween(rows, '2026-10-02', '2026-10-30')).toHaveLength(1);
  });
});

describe('заметка «Вернуть боту»', () => {
  it('оба поля: подписи и пустая строка между; CRLF → LF, пробелы по краям убираются', () => {
    expect(composeNote('  Ориентир от X\r\nнужен выезд ', ' Узнай число вещей ')).toEqual({
      ok: true,
      note: 'Ответ клиенту: Ориентир от X\nнужен выезд\n\nЗадание боту: Узнай число вещей',
      length: 73,
    });
  });

  it('пустые части пропускаются; обе пустые — пустая заметка', () => {
    expect(composeNote('', 'Задача')).toMatchObject({ note: 'Задание боту: Задача' });
    expect(composeNote('Ответ', '   ')).toMatchObject({ note: 'Ответ клиенту: Ответ' });
    expect(composeNote(' ', '\n')).toEqual({ ok: true, note: '', length: 0 });
  });

  it('чистка как у бота: невидимые символы убираются, NFC, не больше одной пустой строки', () => {
    const zeroWidth = 'Ответ​ клиенту‏';
    const nfd = 'ёлка'; // «ё», разложенная на «е» и знак
    const expected = 'Ответ клиенту: Ответ клиенту\n\nконец\n\nЗадание боту: ёлка';
    expect(composeNote(`${zeroWidth}\n\n\n\nконец`, nfd)).toEqual({ ok: true, note: expected, length: [...expected].length });
  });

  it('предел 1000 символов Unicode у итоговой заметки (эмодзи = 1)', () => {
    const label = 'Ответ клиенту: '.length;
    expect(composeNote('😀'.repeat(NOTE_MAX_LENGTH - label), '')).toMatchObject({
      ok: true,
      length: NOTE_MAX_LENGTH,
    });
    const over = composeNote('😀'.repeat(NOTE_MAX_LENGTH - label + 1), '');
    expect(over).toMatchObject({ ok: false, length: NOTE_MAX_LENGTH + 1 });
    expect(over.ok ? '' : over.message).toContain('сейчас 1001');
  });
});

describe('писали после письма', () => {
  const link = (chatId: number, companyId: number, at: string | null) => ({
    chatId,
    companyId,
    name: `чат ${chatId}`,
    firstClientMessageAt: at,
  });
  const company = (id: number, at: string | null) => ({
    id,
    name: `компания ${id}`,
    firstLetterAt: at,
  });

  it('только позже первого письма; без письма, без сообщения или без компании — нет; свежие сверху', () => {
    const digest = new Map([
      [1, company(1, '2026-10-01T00:00:00Z')],
      [2, company(2, '2026-10-01T00:00:00Z')],
      [3, company(3, null)],
    ]);
    const items = wroteAfterLetter(
      [
        link(10, 1, '2026-10-03T12:00:00Z'),
        link(11, 2, '2026-10-09T00:00:00Z'),
        link(12, 1, '2026-09-30T00:00:00Z'),
        link(13, 1, '2026-10-01T00:00:00Z'),
        link(14, 3, '2026-10-05T00:00:00Z'),
        link(15, 4, '2026-10-05T00:00:00Z'),
        link(16, 1, null),
      ],
      digest,
    );
    expect(items.map((item) => [item.chatId, item.daysAfter])).toEqual([
      [11, 8],
      [10, 2],
    ]);
    expect(items[0]?.companyName).toBe('компания 2');
  });
});

describe('время по Алматы', () => {
  it('сутки начинаются в 19:00 UTC', () => {
    expect(almatyDay(Date.parse('2026-10-29T18:59:59Z'))).toBe('2026-10-29');
    expect(almatyDay(Date.parse('2026-10-29T19:00:00Z'))).toBe('2026-10-30');
    expect(almatyMonthStart(Date.parse('2026-10-31T19:30:00Z'))).toBe('2026-11-01');
    expect(almatyClock(Date.parse('2026-10-30T06:05:00Z'))).toBe('11:05');
  });

  it('даты', () => {
    expect(isValidDay('2026-02-28')).toBe(true);
    expect(isValidDay('2026-02-31')).toBe(false);
    expect(isValidDay('2026-2-1')).toBe(false);
    expect(addDays('2026-10-30', -29)).toBe('2026-10-01');
    expect(daysInclusive('2026-10-01', '2026-10-30')).toBe(30);
  });
});

describe('тексты', () => {
  it('длина и обрезка по символам Unicode', () => {
    expect(codePointLength('a😀б')).toBe(3);
    expect(cutCodePoints('😀😀😀', 2)).toBe('😀😀');
    expect(cutCodePoints('abc', 5)).toBe('abc');
  });

  it('строка для показа: без управляющих символов и смены направления, одной строкой', () => {
    expect(cleanLine(' a\u0000b‮c\r\n\td  e ', 100)).toBe('abc d e');
    expect(cleanLine('я'.repeat(10), 3)).toBe('яяя');
    expect(hasControlChars('a\nb')).toBe(true);
    expect(hasControlChars('a\nb', true)).toBe(false);
    expect(hasControlChars('a\tb', true)).toBe(true);
  });

  it('текст ошибки по коду; неизвестный код — общий', () => {
    expect(errorMessage('no_session')).toContain('войти');
    expect(errorMessage('что-то')).toBe('Неверный запрос.');
  });
});
