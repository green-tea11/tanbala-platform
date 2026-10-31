import { describe, expect, it } from 'vitest';
import type { ChatId, StoredMessage } from '../../../src/domain/types.js';
import { answerPartOf, clientAsksNow } from '../../../src/pipeline/answer-part.js';

// Передачу делает код, а модель ответила answer: из её ответа в сообщение передачи остаётся только ответ из знаний (без
// вопросов, без фразы об ориентире), и только если клиент что-то спросил.

const CHAT_ID = 1 as ChatId;

function message(id: number, author: StoredMessage['author'], text: string): StoredMessage {
  return { id, chatId: CHAT_ID, author, kind: 'text', text, tsMs: id };
}

describe('pipeline/answer-part: спрашивает ли клиент что-то сейчас', () => {
  it.each([
    'Компания tyri, занимаемся складами и отгрузками как работает ваше оборудование',
    'А с 1С интегрируется?',
    'Расскажите подробнее',
    'Можно ли клеить на металл',
  ])('«%s»: вопрос', (text) => {
    expect(clientAsksNow([message(1, 'bot', 'Здравствуйте!'), message(2, 'client', text)])).toBe(
      true,
    );
  });

  it.each(['Да обычная 1с', 'Алматы', 'Метал имеется жидкости нет', 'Около 5000 тысяч в месяц'])(
    '«%s»: ответ без вопроса',
    (text) => {
      expect(clientAsksNow([message(1, 'bot', 'Какая 1С?'), message(2, 'client', text)])).toBe(
        false,
      );
    },
  );

  it('считаются только сообщения после последней реплики бота или менеджера', () => {
    const history = [
      message(1, 'client', 'Как это работает?'),
      message(2, 'bot', 'Есть ли у вас 1С?'),
      message(3, 'client', 'Да'),
    ];
    expect(clientAsksNow(history)).toBe(false);
    expect(clientAsksNow([...history, message(4, 'client', 'А сколько стоит?')])).toBe(true);
    expect(
      clientAsksNow([message(2, 'human_panel', 'Добрый день'), message(1, 'client', '?')]),
    ).toBe(false);
  });
});

describe('pipeline/answer-part: ответ из черновика answer', () => {
  it('остаются утверждения, без вопросов, фразы об ориентире и фраз передачи', () => {
    expect(
      answerPartOf(
        'Да, мы проводим интеграцию с вашей 1С. Ориентир коллега назовёт, когда поймём ваш объект. Какая у вас конфигурация?',
      ),
    ).toBe('Да, мы проводим интеграцию с вашей 1С.');
    expect(
      answerPartOf('Цена сильно зависит от объёма. Уточню у коллеги и вернусь к вам.'),
    ).toBeNull();
    expect(answerPartOf('Я уточню у коллеги решение и ориентир под вашу задачу.')).toBeNull();
  });

  it('пустое вступление «Понятно» в ответ не идёт', () => {
    expect(answerPartOf('Понятно, у вас склад. Да, мы проводим интеграцию с вашей 1С.')).toBe(
      'Да, мы проводим интеграцию с вашей 1С.',
    );
  });

  it('только вопросы: ответа нет', () => {
    expect(answerPartOf('Подскажите, есть ли у вас 1С и какая?')).toBeNull();
    expect(answerPartOf('   ')).toBeNull();
  });
});
