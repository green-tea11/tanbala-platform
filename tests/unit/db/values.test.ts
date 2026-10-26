import { describe, expect, it } from 'vitest';
import { assertCount, HANDOFF_REASONS, LEVELS, oneOf } from '../../../src/db/values.js';

describe('assertCount', () => {
  it.each([0, 1, 50, Number.MAX_SAFE_INTEGER])('принимает %s', (value) => {
    expect(() => {
      assertCount(value, 'limit');
    }).not.toThrow();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'отклоняет %s: RangeError с именем параметра (в SQLite отрицательный LIMIT значит «без лимита»)',
    (value) => {
      expect(() => {
        assertCount(value, 'offset');
      }).toThrow(RangeError);
      expect(() => {
        assertCount(value, 'offset');
      }).toThrow(/offset/);
    },
  );
});

describe('oneOf', () => {
  it('возвращает значение из набора', () => {
    expect(oneOf(['bot', 'manager'] as const, 'manager', 'В chats статус')).toBe('manager');
  });

  it.each(['robot', '', 'Manager'])(
    'значение %j вне набора: явная ошибка с описанием, а не догадка',
    (value) => {
      expect(() => oneOf(['bot', 'manager'] as const, value, 'В chats неизвестный статус')).toThrow(
        'В chats неизвестный статус: строка испорчена',
      );
    },
  );
});

describe('списки значений колонок', () => {
  it('уровни интереса идут от холодного к горячему', () => {
    expect(LEVELS).toEqual(['cold', 'warm', 'hot']);
  });

  it('причины передачи те же, что в HandoffReason', () => {
    expect([...HANDOFF_REASONS].sort()).toEqual(
      [
        'asked_human',
        'check_failed',
        'complaint',
        'hot',
        'human_took_over',
        'limit',
        'llm_error',
        'no_answer',
      ].sort(),
    );
  });
});
