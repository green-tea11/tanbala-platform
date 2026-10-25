import type { Logger } from '../domain/ports.js';
import { notImplemented } from './todo.js';

/**
 * Создаёт логгер приложения на pino 10. level: trace, debug, info, warn или error.
 * TODO(этап 2): pino с redact для текста сообщений, pushName, номеров, ключей и пароля панели; номера маскировать.
 * TODO(этап 2): Baileys получает logger.child({ module: 'baileys' }, { level: 'warn' }): на debug и trace он пишет протокол и содержимое сообщений.
 * TODO(этап 2): JID и длинные цепочки цифр маскировать и в объекте, и в строке сообщения: formatters.log видит только объект, поэтому строки маскировать через hooks.logMethod на корневом логгере (дочерние, в том числе логгер Baileys, его наследуют); пути redact не достают вложенные объекты и строки Baileys.
 */
export function createLogger(options: { level: string }): Logger {
  return notImplemented('этап 2', 'shared/logger.createLogger');
}
