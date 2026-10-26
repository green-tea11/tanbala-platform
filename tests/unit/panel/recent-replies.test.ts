import { describe, expect, it } from 'vitest';
import type { Clock } from '../../../src/domain/ports.js';
import type { ChatId } from '../../../src/domain/types.js';
import {
  createRecentReplies,
  DUPLICATE_REPLY_WINDOW_MS,
  type RecentReplies,
} from '../../../src/panel/recent-replies.js';

const T0 = Date.UTC(2026, 9, 26, 10, 0);
const CHAT_1 = 1 as ChatId;
const CHAT_2 = 2 as ChatId;

interface Setup {
  readonly replies: RecentReplies;
  readonly advance: (ms: number) => void;
}

function setup(): Setup {
  let now = T0;
  const clock: Clock = { now: () => now, sleep: () => Promise.resolve() };
  return {
    replies: createRecentReplies(clock),
    advance: (ms) => {
      now += ms;
    },
  };
}

describe('createRecentReplies', () => {
  it('окно повтора ровно 10 секунд (решение владельца)', () => {
    expect(DUPLICATE_REPLY_WINDOW_MS).toBe(10_000);
  });

  it('первый ответ принимается, тот же текст в тот же чат сразу после него нет', () => {
    const { replies } = setup();

    expect(replies.claim(CHAT_1, 'Добрый день')).toBe(true);
    expect(replies.claim(CHAT_1, 'Добрый день')).toBe(false);
    expect(replies.claim(CHAT_1, 'Добрый день')).toBe(false);
  });

  it('другой текст в тот же чат и тот же текст в другой чат принимаются', () => {
    const { replies } = setup();
    replies.claim(CHAT_1, 'Добрый день');

    expect(replies.claim(CHAT_1, 'Добрый вечер')).toBe(true);
    expect(replies.claim(CHAT_2, 'Добрый день')).toBe(true);
  });

  it('текст сравнивается точно: регистр и внутренние пробелы различаются', () => {
    const { replies } = setup();
    replies.claim(CHAT_1, 'Да, конечно');

    expect(replies.claim(CHAT_1, 'да, конечно')).toBe(true);
    expect(replies.claim(CHAT_1, 'Да,  конечно')).toBe(true);
  });

  it('пробелы и переводы строк по краям не различают тексты: в чат уходит обрезанный', () => {
    const { replies } = setup();
    replies.claim(CHAT_1, 'Привет');

    expect(replies.claim(CHAT_1, '  Привет \n')).toBe(false);
  });

  it('до 10 секунд повтор отклоняется, ровно через 10 секунд принимается', () => {
    const { replies, advance } = setup();
    replies.claim(CHAT_1, 'Привет');

    advance(DUPLICATE_REPLY_WINDOW_MS - 1);
    expect(replies.claim(CHAT_1, 'Привет')).toBe(false);

    advance(1);
    expect(replies.claim(CHAT_1, 'Привет')).toBe(true);
  });

  it('отклонённые повторы окно не продлевают: отсчёт идёт от принятого ответа', () => {
    const { replies, advance } = setup();
    replies.claim(CHAT_1, 'Привет');
    advance(6_000);
    expect(replies.claim(CHAT_1, 'Привет')).toBe(false);

    advance(4_000);

    expect(replies.claim(CHAT_1, 'Привет')).toBe(true);
  });

  it('release снимает отметку: ответ, который не ушёл, можно сразу повторить', () => {
    const { replies } = setup();
    replies.claim(CHAT_1, 'Привет');

    replies.release(CHAT_1, 'Привет');

    expect(replies.claim(CHAT_1, 'Привет')).toBe(true);
  });

  it('release снимает отметку только этого чата и этого текста; лишний вызов безвреден', () => {
    const { replies } = setup();
    replies.claim(CHAT_1, 'Привет');
    replies.claim(CHAT_2, 'Привет');
    replies.claim(CHAT_1, 'Пока');

    replies.release(CHAT_1, 'Привет');
    replies.release(CHAT_1, 'Такого не было');

    expect(replies.claim(CHAT_1, 'Привет')).toBe(true);
    expect(replies.claim(CHAT_2, 'Привет')).toBe(false);
    expect(replies.claim(CHAT_1, 'Пока')).toBe(false);
  });

  it('записи старше 10 секунд удаляются при следующем обращении: память не растёт', () => {
    const { replies, advance } = setup();
    for (let i = 0; i < 50; i += 1) replies.claim(CHAT_1, `Сообщение ${String(i)}`);
    expect(replies.size()).toBe(50);

    advance(DUPLICATE_REPLY_WINDOW_MS);
    replies.claim(CHAT_2, 'Новое');

    expect(replies.size()).toBe(1);
  });

  it('release тоже убирает устаревшие записи', () => {
    const { replies, advance } = setup();
    replies.claim(CHAT_1, 'Старое');
    advance(DUPLICATE_REPLY_WINDOW_MS + 1);

    replies.release(CHAT_2, 'Ничего');

    expect(replies.size()).toBe(0);
  });

  it('пустой текст и длинный текст с эмодзи не ломают ключ', () => {
    const { replies } = setup();
    const long = `😀${'я'.repeat(4096)}`;

    expect(replies.claim(CHAT_1, '')).toBe(true);
    expect(replies.claim(CHAT_1, '')).toBe(false);
    expect(replies.claim(CHAT_1, long)).toBe(true);
    expect(replies.claim(CHAT_1, long)).toBe(false);
    expect(replies.claim(CHAT_1, `😁${'я'.repeat(4096)}`)).toBe(true);
  });

  it('отметки разных экземпляров не пересекаются: общего состояния нет', () => {
    const first = setup();
    const second = setup();

    first.replies.claim(CHAT_1, 'Привет');

    expect(second.replies.claim(CHAT_1, 'Привет')).toBe(true);
  });
});
