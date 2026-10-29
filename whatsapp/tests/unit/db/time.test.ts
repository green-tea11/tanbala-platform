import { describe, expect, it } from 'vitest';
import { assertTimeMs } from '../../../src/db/time.js';

describe('assertTimeMs', () => {
  it.each([0, 1, 1_730_000_000_000, Number.MAX_SAFE_INTEGER])('принимает %s', (value) => {
    expect(() => {
      assertTimeMs(value, 'atMs');
    }).not.toThrow();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'отклоняет %s и называет поле',
    (value) => {
      const check = (): void => {
        assertTimeMs(value, 'atMs');
      };

      expect(check).toThrow(RangeError);
      expect(check).toThrow('atMs');
    },
  );
});
