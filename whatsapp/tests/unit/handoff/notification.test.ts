import { describe, expect, it } from 'vitest';
import type {
  BacklogChat,
  ChatId,
  ClientProfile,
  InterestLevel,
  PhoneDigits,
} from '../../../src/domain/types.js';
import {
  BACKLOG_TEXT_MAX_LENGTH,
  formatBacklogNotification,
  formatManagerNotification,
  NAME_MAX_LENGTH,
  PROFILE_FIELD_MAX_LENGTH,
  type ManagerNotificationInput,
  type NotificationReason,
} from '../../../src/handoff/notification.js';

// Номера вымышленные: 7700000000N.
const PHONE = '77000000001' as PhoneDigits;

const PROFILE: ClientProfile = {
  business: 'магазин одежды',
  area: '300 кв. м',
  scope: 'где лежит каждая вещь',
  itemCount: 'около 5000',
  has1C: true,
  oneCName: null,
  problem: 'путаница с остатками',
  specifics: 'два склада',
  problemAgreed: false,
  items: 'одежда',
  packaging: 'на вешалках',
  material: 'ткань',
  city: null,
  premises: 'магазин',
  turnover: null,
  currentTracking: 'в 1С вручную',
};

const EMPTY_PROFILE: ClientProfile = {
  business: null,
  area: null,
  scope: null,
  itemCount: null,
  has1C: null,
  oneCName: null,
  problem: null,
  specifics: null,
  problemAgreed: false,
  items: null,
  packaging: null,
  material: null,
  city: null,
  premises: null,
  turnover: null,
  currentTracking: null,
};

const BASE: ManagerNotificationInput = {
  reason: 'hot',
  name: 'Иван Петров',
  phone: PHONE,
  level: 'hot',
  profile: PROFILE,
  chatId: 12 as ChatId,
};

/**
 * Строк в обычном уведомлении: заголовок, имя, номер, чат, уровень, пустая, шапка выжимки, четырнадцать полей, пустая
 * и две строки о минимуме для оценки цены.
 */
const NORMAL_LINE_COUNT = 24;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function lines(text: string): string[] {
  return text.split('\n');
}

/** Значение строки «Метка: значение» из уведомления; нет такой строки: пустая строка. */
function valueOf(text: string, label: string): string {
  const line = lines(text).find((candidate) => candidate.startsWith(`${label}: `)) ?? '';
  return line.slice(label.length + 2);
}

function codePoints(text: string): number {
  return Array.from(text).length;
}

function withProfile(patch: Partial<ClientProfile>): ManagerNotificationInput {
  return { ...BASE, profile: { ...PROFILE, ...patch } };
}

describe('formatManagerNotification', () => {
  it('фиксированный шаблон: причина, имя, номер, ID чата, уровень и вся выжимка со слов клиента', () => {
    expect(formatManagerNotification(BASE)).toBe(
      [
        'Передача чата менеджеру: горячий клиент.',
        'Имя в WhatsApp: Иван Петров',
        'Номер: +77000000001',
        'Чат в панели: ID 12',
        'Уровень интереса: горячий',
        '',
        'Выжимка (всё со слов клиента, не проверено):',
        'Бизнес: магазин одежды',
        'Вещи: одежда',
        'В чём лежат: на вешалках',
        'Материал: ткань',
        'Город: не выяснено',
        'Помещение: магазин',
        'Площадь: 300 кв. м',
        'Число вещей: около 5000',
        'Как часто движутся: не выяснено',
        'Что отмечать: где лежит каждая вещь',
        'Учёт сейчас: в 1С вручную',
        'Что мешает: путаница с остатками',
        '1С: есть',
        'Особенности: два склада',
        '',
        'Для оценки цены собрано: какие вещи, материал, примерное число вещей, тип помещения, есть ли 1С',
        'Не удалось выяснить: город, название компании',
      ].join('\n'),
    );
  });

  it('какая 1С идёт в строке 1С после «есть»', () => {
    const text = formatManagerNotification(withProfile({ oneCName: '1С:Управление торговлей' }));

    expect(valueOf(text, '1С')).toBe('есть, 1С:Управление торговлей');
  });

  it('минимум собран: компания подтверждена, город есть; не выяснено «всё выяснено»', () => {
    const text = formatManagerNotification({
      ...withProfile({ city: 'Алматы' }),
      company: {
        status: 'confirmed',
        companyId: null,
        name: 'ТОО Склад',
        city: null,
        rubric: null,
        candidateSource: null,
        cardUrl: null,
        confirmedPains: [],
        briefPains: [],
        emailed: null,
        research: null,
        statedName: null,
      },
    });

    expect(valueOf(text, 'Для оценки цены собрано')).toBe(
      'какие вещи, материал, примерное число вещей, тип помещения, город, есть ли 1С, название компании',
    );
    expect(valueOf(text, 'Не удалось выяснить')).toBe('всё выяснено');
  });

  it('уведомление о лимите без строк о минимуме: это не передача по цене', () => {
    const text = formatManagerNotification({ ...BASE, reason: 'limit', scope: 'chat' });

    expect(text).not.toMatch(/Для оценки цены|Не удалось выяснить/);
  });

  it('нет номера: «номер скрыт» и ID чата, по которому его найти в панели', () => {
    const text = formatManagerNotification({ ...BASE, phone: null, chatId: 57 as ChatId });

    expect(text).toContain('Номер: номер скрыт, чат ищите в панели по ID 57');
    expect(text).toContain('Чат в панели: ID 57');
    expect(text).not.toContain('+7');
  });

  it.each([null, '', '   \n '])('имени нет (%j): «не указано»', (name) => {
    expect(formatManagerNotification({ ...BASE, name })).toContain('Имя в WhatsApp: не указано');
  });

  it.each<readonly [InterestLevel, string]>([
    ['cold', 'холодный'],
    ['warm', 'тёплый'],
    ['hot', 'горячий'],
  ])('уровень %s словами: %s', (level, word) => {
    expect(formatManagerNotification({ ...BASE, level })).toContain(`Уровень интереса: ${word}`);
  });

  const REASON_PHRASES: readonly (readonly [NotificationReason, string])[] = [
    [{ reason: 'hot' }, 'горячий клиент'],
    [{ reason: 'no_answer' }, 'в знаниях нет ответа на вопрос клиента'],
    [{ reason: 'check_failed' }, 'ответ бота не прошёл проверку'],
    [{ reason: 'asked_human' }, 'клиент просит живого человека'],
    [{ reason: 'complaint' }, 'клиент жалуется или раздражён'],
    [{ reason: 'human_took_over' }, 'в чат написал человек, бот выключен'],
    [{ reason: 'llm_error' }, 'сбой модели, бот не смог ответить'],
  ];

  it.each(REASON_PHRASES)('причина %j в первой строке', (reason, phrase) => {
    const text = formatManagerNotification({ ...BASE, ...reason });

    expect(lines(text)[0]).toBe(`Передача чата менеджеру: ${phrase}.`);
  });

  it.each([
    ['chat', 'исчерпан лимит чата (API_DAILY_LIMIT_PER_CHAT)'],
    ['global', 'исчерпан общий лимит бота на сутки (API_DAILY_LIMIT)'],
  ] as const)(
    'лимит, область %s: бот замолчал, названа настройка, есть ID чата и номер',
    (scope, phrase) => {
      const text = formatManagerNotification({ ...BASE, reason: 'limit', scope });

      expect(lines(text)[0]).toBe(`Бот замолчал в этом чате: ${phrase}.`);
      expect(text).toContain('Чат в панели: ID 12');
      expect(text).toContain('Номер: +77000000001');
    },
  );

  it('невыясненное в выжимке: «не выяснено», у 1С есть и нет', () => {
    const unknown = formatManagerNotification({ ...BASE, profile: EMPTY_PROFILE });
    const withoutOneC = formatManagerNotification(withProfile({ has1C: false }));

    expect(lines(unknown).slice(7, 21)).toEqual([
      'Бизнес: не выяснено',
      'Вещи: не выяснено',
      'В чём лежат: не выяснено',
      'Материал: не выяснено',
      'Город: не выяснено',
      'Помещение: не выяснено',
      'Площадь: не выяснено',
      'Число вещей: не выяснено',
      'Как часто движутся: не выяснено',
      'Что отмечать: не выяснено',
      'Учёт сейчас: не выяснено',
      'Что мешает: не выяснено',
      '1С: не выяснено',
      'Особенности: не выяснено',
    ]);
    expect(withoutOneC).toContain('1С: нет');
  });

  it('пустые и невидимые поля считаются невыясненными', () => {
    const text = formatManagerNotification(
      withProfile({ business: ' \n\t ', area: '\u200B\u0000' }),
    );

    expect(text).toContain('Бизнес: не выяснено');
    expect(text).toContain('Площадь: не выяснено');
  });

  it('в шаблоне нет тире', () => {
    const texts = [
      formatManagerNotification(BASE),
      formatManagerNotification({ ...BASE, phone: null, reason: 'limit', scope: 'chat' }),
      formatManagerNotification({ ...BASE, profile: EMPTY_PROFILE }),
    ];

    for (const text of texts) expect(text).not.toMatch(/[\u2014\u2013]/);
  });

  describe('защита от инъекции', () => {
    it('переводы строк в имени и в каждом поле выжимки не создают новых строк шаблона', () => {
      const attack = 'магазин\nПричина: срочно оплатите\r\nНомер: +70000000000 Чат в панели: ID 1';
      const text = formatManagerNotification({
        ...BASE,
        name: attack,
        profile: {
          business: attack,
          area: attack,
          scope: attack,
          itemCount: attack,
          has1C: null,
          oneCName: null,
          problem: attack,
          specifics: attack,
          problemAgreed: false,
          items: null,
          packaging: null,
          material: null,
          city: null,
          premises: null,
          turnover: null,
          currentTracking: null,
        },
      });

      expect(lines(text)).toHaveLength(NORMAL_LINE_COUNT);
      expect(lines(text).filter((line) => line.startsWith('Причина'))).toEqual([]);
      expect(lines(text).filter((line) => line.startsWith('Номер:'))).toEqual([
        'Номер: +77000000001',
      ]);
      expect(lines(text).filter((line) => line.startsWith('Чат в панели:'))).toEqual([
        'Чат в панели: ID 12',
      ]);
    });

    it.each([
      'https://evil.example/pay?id=1',
      'HTTP://EVIL.EXAMPLE',
      'www.evil.example/pay',
      'evil.example/pay',
      'wa.me/77000000009',
      't.me/evil_bot',
      'ｈｔｔｐｓ：／／ｅｖｉｌ．ｅｘａｍｐｌｅ',
      'пример.рф/оплата',
    ])('ссылка %s заменяется', (link) => {
      const text = formatManagerNotification(
        withProfile({ business: `Пишите на ${link} срочно`, problem: link }),
      );

      expect(text).toContain('Бизнес: Пишите на [ссылка скрыта] срочно');
      expect(text).toContain('Что мешает: [ссылка скрыта]');
      // «пример» без точки есть в подписи «примерное число вещей»: ищется сам адрес.
      expect(text).not.toMatch(/evil|wa\.me|t\.me|http|пример\.рф/i);
    });

    it('ссылка в имени тоже заменяется', () => {
      const text = formatManagerNotification({ ...BASE, name: 'Скидки evil.example/win' });

      expect(text).toContain('Имя в WhatsApp: Скидки [ссылка скрыта]');
    });

    it('обычный текст с точками и числами не принимается за ссылку', () => {
      const text = formatManagerNotification(
        withProfile({ area: 'около 1.5 тыс. кв. м, версия 2.0', problem: 'учёт.Склад большой' }),
      );

      expect(text).toContain('Площадь: около 1.5 тыс. кв. м, версия 2.0');
      expect(text).toContain('Что мешает: учёт.Склад большой');
    });

    it('управляющие и невидимые символы убираются, переносы и табуляция становятся пробелом', () => {
      const text = formatManagerNotification(
        withProfile({ business: 'ма\u0000га\u200Bзин\u202E\tодежды\u0085и\u00A0обуви' }),
      );

      expect(text).toContain('Бизнес: магазин одежды и обуви');
    });

    it('длинные имя и поля обрезаются с многоточием', () => {
      const long = 'а'.repeat(1000);
      const text = formatManagerNotification({
        ...withProfile({ business: long, specifics: long }),
        name: long,
      });

      const name = valueOf(text, 'Имя в WhatsApp');
      const business = valueOf(text, 'Бизнес');
      const specifics = valueOf(text, 'Особенности');
      expect(codePoints(name)).toBe(NAME_MAX_LENGTH);
      expect(codePoints(business)).toBe(PROFILE_FIELD_MAX_LENGTH);
      expect(codePoints(specifics)).toBe(PROFILE_FIELD_MAX_LENGTH);
      expect(name.endsWith('…')).toBe(true);
      expect(business.endsWith('…')).toBe(true);
    });

    it('обрезка не разрывает суррогатную пару', () => {
      const emoji = '😀'.repeat(PROFILE_FIELD_MAX_LENGTH);
      const text = formatManagerNotification(withProfile({ business: `а${emoji}` }));

      expect(text).not.toMatch(LONE_SURROGATE);
      expect(lines(text).find((line) => line.startsWith('Бизнес: '))).toMatch(/😀…$/u);
    });

    it('огромное значение читается не целиком и не подвешивает обработку', () => {
      const huge = 'a.'.repeat(500_000);
      const text = formatManagerNotification(withProfile({ business: huge }));

      expect(text.length).toBeLessThan(2000);
    });
  });
});

const CHAT_A: BacklogChat = {
  chatId: 12 as ChatId,
  name: 'Иван Петров',
  phone: PHONE,
  // 25.10.2026 16:30 UTC = 21:30 по Алматы (UTC+5).
  lastMessageAtMs: Date.UTC(2026, 9, 25, 16, 30),
};

const CHAT_B: BacklogChat = {
  chatId: 15 as ChatId,
  name: null,
  phone: null,
  lastMessageAtMs: Date.UTC(2026, 9, 25, 17, 5),
};

function backlogChat(index: number, overrides: Partial<BacklogChat> = {}): BacklogChat {
  return {
    chatId: (1000 + index) as ChatId,
    name: `Клиент номер ${index} ${'и'.repeat(NAME_MAX_LENGTH)}`,
    phone: PHONE,
    lastMessageAtMs: Date.UTC(2026, 9, 25, 16, 30),
    ...overrides,
  };
}

/** Число скрытых чатов по хвосту «и ещё N чатов»; нет хвоста: 0. */
function hiddenChats(text: string): number {
  return Number(/^и ещё (\d+) чат/.exec(lines(text).at(-1) ?? '')?.[1] ?? 0);
}

/** Текст, где ровно `hidden` чатов не поместилось: чаты одинаковые, поэтому скрытых растёт на один с каждым лишним. */
function backlogTextWithHidden(hidden: number): string {
  for (let total = 1; total <= 400; total += 1) {
    const chats = Array.from({ length: total }, (_, index) => backlogChat(index));
    const text = formatBacklogNotification(chats, 12);
    if (hiddenChats(text) === hidden) return text;
  }
  throw new Error(`Не нашлось списка со скрытыми чатами: ${hidden}`);
}

describe('formatBacklogNotification', () => {
  it('фиксированный шаблон: порог, число чатов и по строке на чат со временем по Алматы', () => {
    expect(formatBacklogNotification([CHAT_A, CHAT_B], 12)).toBe(
      [
        'Простой бота: сообщения старше 12 часов остались без ответа.',
        'Бот на них не отвечал и не отмечал их прочитанными.',
        'Чатов: 2. Время по Алматы.',
        '',
        '1. Иван Петров, +77000000001, чат ID 12, последнее сообщение 25.10.2026 21:30',
        '2. без имени, номер скрыт, чат ID 15, последнее сообщение 25.10.2026 22:05',
      ].join('\n'),
    );
  });

  it('полночь по Алматы пишется как 00:30, а не 24:30', () => {
    // 25.10.2026 19:30 UTC = 26.10.2026 00:30 по Алматы.
    const text = formatBacklogNotification(
      [backlogChat(1, { name: 'Анна', lastMessageAtMs: Date.UTC(2026, 9, 25, 19, 30) })],
      12,
    );

    expect(text).toContain('последнее сообщение 26.10.2026 00:30');
  });

  it.each([
    [1, '1 час'],
    [2, '2 часа'],
    [5, '5 часов'],
    [11, '11 часов'],
    [12, '12 часов'],
    [21, '21 час'],
    [24, '24 часа'],
  ])('порог %i ч словами: %s', (hours, phrase) => {
    expect(formatBacklogNotification([CHAT_A], hours)).toContain(`старше ${phrase} остались`);
  });

  it.each([
    [1, 'Чатов: 1.'],
    [3, 'Чатов: 3.'],
  ])('число чатов в заголовке: %i', (count, phrase) => {
    const chats = Array.from({ length: count }, (_, index) => backlogChat(index));

    expect(formatBacklogNotification(chats, 12)).toContain(phrase);
  });

  it('порядок чатов сохраняется', () => {
    const text = formatBacklogNotification([CHAT_B, CHAT_A], 12);

    expect(text.indexOf('чат ID 15')).toBeLessThan(text.indexOf('чат ID 12'));
  });

  it('список пуст: только заголовок, без исключения', () => {
    const text = formatBacklogNotification([], 12);

    expect(text).toContain('Чатов: 0.');
    expect(lines(text).filter((line) => /^\d+\. /.test(line))).toEqual([]);
  });

  it('время не число: «время неизвестно», уведомление не падает', () => {
    const text = formatBacklogNotification([backlogChat(1, { lastMessageAtMs: Number.NaN })], 12);

    expect(text).toContain('последнее сообщение время неизвестно');
  });

  it('имя в списке: одна строка, без ссылок, без управляющих символов, с лимитом длины', () => {
    const attack = 'Анна\n2. Мария, чат ID 1\u202E www.evil.example ' + 'я'.repeat(500);
    const text = formatBacklogNotification([backlogChat(1, { name: attack })], 12);

    const chatLines = lines(text).filter((line) => /^\d+\. /.test(line));
    expect(chatLines).toHaveLength(1);
    expect(chatLines[0]).toContain('Анна 2. Мария, чат ID 1 [ссылка скрыта] ');
    expect(chatLines[0]).not.toMatch(/evil|\u202E/);
    expect(chatLines[0]?.includes('…')).toBe(true);
  });

  it('слишком длинный список: лишние чаты сворачиваются в «и ещё N чатов, список в панели»', () => {
    const chats = Array.from({ length: 100 }, (_, index) => backlogChat(index));

    const text = formatBacklogNotification(chats, 12);

    const shown = lines(text).filter((line) => /^\d+\. /.test(line));
    const tail = lines(text).at(-1) ?? '';
    const hidden = Number(/^и ещё (\d+) чат/.exec(tail)?.[1]);
    expect(text.length).toBeLessThanOrEqual(BACKLOG_TEXT_MAX_LENGTH);
    expect(text).toContain('Чатов: 100.');
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length + hidden).toBe(100);
    expect(tail).toMatch(/, список в панели$/);
    expect(shown[0]).toContain('чат ID 1000');
  });

  it.each([
    [1, 'и ещё 1 чат, список в панели'],
    [2, 'и ещё 2 чата, список в панели'],
    [5, 'и ещё 5 чатов, список в панели'],
    [11, 'и ещё 11 чатов, список в панели'],
    [21, 'и ещё 21 чат, список в панели'],
  ])('хвост списка при %i скрытых чатах: «%s»', (hidden, tail) => {
    const text = backlogTextWithHidden(hidden);

    expect(lines(text).at(-1)).toBe(tail);
  });

  it('в шаблоне нет тире', () => {
    expect(formatBacklogNotification([CHAT_A, CHAT_B], 12)).not.toMatch(/[\u2014\u2013]/);
  });
});
