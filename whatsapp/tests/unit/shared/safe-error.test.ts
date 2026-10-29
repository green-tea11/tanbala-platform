import { describe, expect, it } from 'vitest';
import { SafeError } from '../../../src/shared/safe-error.js';

describe('SafeError', () => {
  it('несёт текст, который можно показать владельцу, и сохраняет причину отдельно', () => {
    const cause = new Error('детали с номером 77000000001');
    const error = new SafeError('Попытки привязки исчерпаны', { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Попытки привязки исчерпаны');
    expect(error.cause).toBe(cause);
    expect(error.name).toBe('SafeError');
  });

  it('подклассы задают своё имя и остаются SafeError', () => {
    class LockBusyError extends SafeError {
      override readonly name = 'LockBusyError';
    }
    const error = new LockBusyError('Бот уже запущен');

    expect(error).toBeInstanceOf(SafeError);
    expect(error.name).toBe('LockBusyError');
  });
});
