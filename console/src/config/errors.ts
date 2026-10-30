/**
 * Настройки не прошли проверку. Каждая проблема: имя переменной и причина, без значения
 * (в значениях токены), например «CONSOLE_PORT: целое число от 1 до 65535».
 */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Настройки не прошли проверку: ${problems.join('; ')}`);
    this.problems = Object.freeze([...problems]);
  }
}

/** Имя класса и код ошибки Node или SQLite, которые можно показать: латиница, цифры, подчёркивание. */
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'неизвестного вида';
  const name = SAFE_NAME.test(error.name) ? error.name : 'Error';
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' && SAFE_CODE.test(code) ? `${name} (${code})` : name;
}

/**
 * Текст для stderr, когда консоль или команда не запустилась. ConfigError: список проблем по строке.
 * Прочие ошибки: только имя класса и код, без текста (в нём бывают пути и значения).
 */
export function formatFatalError(prefix: string, error: unknown): string {
  if (error instanceof ConfigError) {
    const lines = error.problems.map((problem) => `- ${problem}`);
    return [`${prefix}: настройки не прошли проверку.`, ...lines, ''].join('\n');
  }
  return `${prefix}: ошибка ${describeError(error)}. Текст ошибки не выводится.\n`;
}
