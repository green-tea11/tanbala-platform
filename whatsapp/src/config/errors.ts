import { SafeError } from '../shared/safe-error.js';

/**
 * Настройки не прошли проверку. Каждая проблема: имя переменной и причина, без значения
 * (в значениях бывают ключи и номера), например «PANEL_PORT: целое число от 1 до 65535».
 * Это SafeError: и текст, и список проблем можно показать владельцу.
 */
export class ConfigError extends SafeError {
  override readonly name = 'ConfigError';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Настройки не прошли проверку: ${problems.join('; ')}`);
    this.problems = Object.freeze([...problems]);
  }
}

/** Имя класса ошибки, которое можно показать: латиница, цифры и подчёркивание. */
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Код ошибки Node или SQLite, который можно показать, например EACCES или SQLITE_CANTOPEN. */
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** 7 и больше цифр подряд: похоже на номер, такое имя или код не показываем. */
const LONG_DIGITS = /\d{7,}/;

function isShowable(value: string, pattern: RegExp): boolean {
  return pattern.test(value) && !LONG_DIGITS.test(value);
}

/** Имя класса и код ошибки без её текста. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'неизвестного вида';
  }
  const name = isShowable(error.name, SAFE_ERROR_NAME) ? error.name : 'Error';
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' && isShowable(code, SAFE_ERROR_CODE) ? `${name} (${code})` : name;
}

/**
 * Текст для stderr, когда бот не запустился, упал при остановке или на необработанной ошибке.
 * ConfigError: список проблем по строке. SafeError: её текст (подробности в cause не печатаются).
 * Прочие ошибки: только имя класса и код, без текста, потому что в нём бывают ключи, номера и пути.
 */
export function formatFatalError(error: unknown): string {
  if (error instanceof ConfigError) {
    const lines = error.problems.map((problem) => `- ${problem}`);
    return ['Бот не запущен: настройки не прошли проверку.', ...lines, ''].join('\n');
  }
  if (error instanceof SafeError) {
    return `Бот остановлен: ${error.message}\n`;
  }
  return (
    `Бот остановлен из-за ошибки ${describeError(error)}. ` +
    'Текст ошибки не выводится: в нём могут быть ключи и номера.\n'
  );
}
