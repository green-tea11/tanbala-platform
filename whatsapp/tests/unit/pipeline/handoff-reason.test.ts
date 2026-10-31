import { describe, expect, it } from 'vitest';
import type { ChatId, StoredMessage } from '../../../src/domain/types.js';
import {
  clientQuote,
  handoffReasonText,
  QUOTE_MAX_LENGTH,
} from '../../../src/pipeline/handoff-reason.js';

// Причина передачи своими словами (решение владельца 30.10.2026): код пишет её сам, с цитатой последнего сообщения
// клиента. Её видят панель (причина оценки) и уведомление менеджеру.

const CHAT_ID = 1 as ChatId;

function message(
  id: number,
  author: StoredMessage['author'],
  text: string | null,
  tsMs = id,
): StoredMessage {
  return { id, chatId: CHAT_ID, author, kind: text === null ? 'voice' : 'text', text, tsMs };
}

const HISTORY = [
  message(1, 'client', 'Здравствуйте'),
  message(2, 'bot', 'Здравствуйте! Чем занимается ваша компания?'),
  message(3, 'client', 'Алматы, один вход'),
];

describe('pipeline/handoff-reason: тексты причин', () => {
  it.each([
    ['final', 'Всё для расчёта известно, клиент готов к расчёту. Клиент: «Алматы, один вход»'],
    ['price', 'Спрашивает цену, сроки или договор, задача понятна. Клиент: «Алматы, один вход»'],
    ['price_third', 'Третий раз спрашивает цену. Клиент: «Алматы, один вход»'],
    ['refused', 'Дважды подряд уходит от вопросов. Клиент: «Алматы, один вход»'],
    ['asked_human', 'Просит живого человека. Клиент: «Алматы, один вход»'],
    ['complaint', 'Жалуется. Клиент: «Алматы, один вход»'],
    ['no_answer', 'Ответа нет в документах. Клиент: «Алматы, один вход»'],
  ] as const)('%s: %s', (why, text) => {
    expect(handoffReasonText(why, HISTORY)).toBe(text);
  });

  it('у клиента нет текста (только голосовое без расшифровки): причина без цитаты', () => {
    expect(handoffReasonText('complaint', [message(1, 'client', null)])).toBe('Жалуется.');
    expect(handoffReasonText('final', [])).toBe(
      'Всё для расчёта известно, клиент готов к расчёту.',
    );
  });
});

describe('pipeline/handoff-reason: цитата последнего сообщения клиента', () => {
  it('последнее по времени сообщение клиента с текстом, а не бота или менеджера', () => {
    const history = [
      message(5, 'bot', 'Расскажите подробнее?', 50),
      message(4, 'client', 'Последнее', 40),
      message(3, 'client', 'Раньше', 30),
      message(6, 'human_panel', 'Менеджер', 60),
      message(7, 'client', null, 70),
    ];

    expect(clientQuote(history)).toBe('Последнее');
  });

  it('одна строка: переводы строк и пробелы всех видов в один пробел', () => {
    expect(clientQuote([message(1, 'client', 'Склад\n\nв  Алматы один\u0085вход\t ')])).toBe(
      'Склад в Алматы один вход',
    );
  });

  it('без угловых скобок, управляющих и невидимых символов; полноширинные скобки тоже убираются', () => {
    const text = '<b>Склад</b>\u0000 в​ Алматы ＜данные＞ ‮тест';

    expect(clientQuote([message(1, 'client', text)])).toBe('bСклад/b в Алматы данные тест');
  });

  it(`не длиннее ${QUOTE_MAX_LENGTH} знаков, обрезка по слову с многоточием`, () => {
    const words = Array.from({ length: 40 }, (_, index) => `слово${index}`).join(' ');

    const quote = clientQuote([message(1, 'client', words)]) ?? '';

    expect(QUOTE_MAX_LENGTH).toBe(150);
    expect([...quote].length).toBeLessThanOrEqual(QUOTE_MAX_LENGTH);
    expect(quote.endsWith('…')).toBe(true);
    expect(words.startsWith(quote.slice(0, -1))).toBe(true);
    expect(words.charAt(quote.length - 1)).toBe(' ');
  });

  it('одно длинное слово режется по знакам, суррогатные пары не рвутся', () => {
    const quote = clientQuote([message(1, 'client', '😀'.repeat(200))]) ?? '';

    expect([...quote]).toHaveLength(QUOTE_MAX_LENGTH);
    expect(quote).toBe(`${'😀'.repeat(QUOTE_MAX_LENGTH - 1)}…`);
  });

  it('ровно 150 знаков не режется', () => {
    const text = 'а'.repeat(QUOTE_MAX_LENGTH);

    expect(clientQuote([message(1, 'client', text)])).toBe(text);
  });

  it('пусто после чистки: цитаты нет', () => {
    expect(clientQuote([message(1, 'client', ' <> ​ ')])).toBeNull();
    expect(clientQuote([])).toBeNull();
  });
});
