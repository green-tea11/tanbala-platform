import { describe, expect, it } from 'vitest';
import { ConfigError, formatFatalError } from '../../../src/config/errors.js';
import { SafeError } from '../../../src/shared/safe-error.js';
import { NotImplementedError } from '../../../src/shared/todo.js';

const SECRET_TEXT = 'ключ sk-ant-secret и номер 77011234567@s.whatsapp.net';

/** Ошибка Node или SQLite с кодом. */
function errorWithCode(code: unknown, name = 'Error'): Error {
  const error = new Error(SECRET_TEXT);
  error.name = name;
  return Object.assign(error, { code });
}

describe('config/errors ConfigError', () => {
  it('обычная ошибка с именем, проблемами и проблемами в тексте', () => {
    const error = new ConfigError(['PANEL_PORT: целое число', 'TEST_MODE: только true или false']);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ConfigError');
    expect(error.problems).toEqual(['PANEL_PORT: целое число', 'TEST_MODE: только true или false']);
    expect(error.message).toContain('PANEL_PORT: целое число');
    expect(error.message).toContain('TEST_MODE: только true или false');
  });

  it('остаётся SafeError: её текст можно показать владельцу', () => {
    expect(new ConfigError(['PANEL_PORT: целое число'])).toBeInstanceOf(SafeError);
  });

  it('хранит свою неизменяемую копию списка проблем', () => {
    const problems = ['PANEL_PORT: целое число'];
    const error = new ConfigError(problems);

    problems.push('лишнее');

    expect(error.problems).toEqual(['PANEL_PORT: целое число']);
    expect(Object.isFrozen(error.problems)).toBe(true);
  });
});

describe('config/errors formatFatalError', () => {
  it('ConfigError: каждая проблема отдельной строкой', () => {
    const text = formatFatalError(new ConfigError(['PANEL_PORT: целое число', 'TEST_MODE: нет']));

    expect(text).toContain('\n- PANEL_PORT: целое число\n- TEST_MODE: нет\n');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('SafeError: печатается её безопасный текст, причина (cause) нет', () => {
    const error = new SafeError('Бот уже запущен в другом окне', { cause: new Error(SECRET_TEXT) });

    const text = formatFatalError(error);

    expect(text).toContain('Бот уже запущен в другом окне');
    expect(text).not.toContain('sk-ant-secret');
    expect(text).not.toContain('77011234567');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('подкласс SafeError тоже печатает свой текст', () => {
    class PairingLimitError extends SafeError {
      override readonly name = 'PairingLimitError';
    }

    expect(formatFatalError(new PairingLimitError('Попытки привязки исчерпаны'))).toContain(
      'Попытки привязки исчерпаны',
    );
  });

  it('прочая ошибка: имя класса без текста ошибки', () => {
    const text = formatFatalError(new TypeError(SECRET_TEXT));

    expect(text).toContain('TypeError');
    expect(text).not.toContain('sk-ant-secret');
    expect(text).not.toContain('77011234567');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('ошибка заготовки называется по классу', () => {
    expect(formatFatalError(new NotImplementedError('этап 2', 'main.main'))).toContain(
      'NotImplementedError',
    );
  });

  it('безопасный код ошибки Node или SQLite показывается', () => {
    const text = formatFatalError(errorWithCode('SQLITE_CANTOPEN', 'SqliteError'));

    expect(text).toContain('SqliteError');
    expect(text).toContain('SQLITE_CANTOPEN');
    expect(text).not.toContain('sk-ant-secret');
  });

  it.each(['код с пробелом', '77011234567@s.whatsapp.net', 'eacces', 'E77011234567', 42])(
    'код не из заглавных латинских букв, цифр и подчёркиваний не показывается: %s',
    (code) => {
      const text = formatFatalError(errorWithCode(code));

      expect(text).not.toContain(String(code));
      expect(text).toContain('Error');
    },
  );

  it.each(['Сбой для 77011234567', 'Error77011234567'])(
    'имя класса, похожее на текст или с номером, заменяется на Error: %s',
    (name) => {
      const text = formatFatalError(errorWithCode(undefined, name));

      expect(text).not.toContain('77011234567');
      expect(text).toContain('Error');
    },
  );

  it.each([SECRET_TEXT, 42, null, { reason: SECRET_TEXT }])(
    'брошено не Error (%s): общий текст без содержимого',
    (thrown) => {
      const text = formatFatalError(thrown);

      expect(text).not.toContain('sk-ant-secret');
      expect(text.endsWith('\n')).toBe(true);
    },
  );
});
