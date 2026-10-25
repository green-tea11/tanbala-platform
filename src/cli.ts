import { fileURLToPath } from 'node:url';
import { loadEnvironment } from './config/dotenv.js';
import { formatFatalError } from './config/errors.js';
import { main, type RunningApp } from './main.js';

// Точка входа: единственный модуль, который что-то запускает при импорте.
// Корень проекта считается от этого файла (src/ или dist/), а не от текущей папки процесса.
const root = fileURLToPath(new URL('..', import.meta.url));

/** Код выхода, если остановку прервали повторным сигналом. */
const FORCED_EXIT_CODE = 1;

/**
 * Причина в stderr через formatFatalError (ConfigError: список проблем, SafeError: её текст, прочие: без
 * текста ошибки) и выход с кодом 1, когда текст ушёл.
 */
function exitWithError(error: unknown): void {
  process.stderr.write(formatFatalError(error), () => process.exit(1));
}

/** SIGINT и SIGTERM: корректная остановка и выход 0; повторный сигнал: выход сразу, не дожидаясь stop. */
function stopOnSignals(app: RunningApp): void {
  let stopping = false;
  const onSignal = (): void => {
    if (stopping) {
      process.exit(FORCED_EXIT_CODE);
    }
    stopping = true;
    app.stop().then(() => process.exit(0), exitWithError);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

// Необработанные ошибки: иначе Node напечатает их целиком, с текстом и JID, в обход фильтра.
process.on('uncaughtException', exitWithError);
process.on('unhandledRejection', exitWithError);

try {
  // .env из корня проекта, переменные процесса главнее; сам process.env не меняется.
  const app = await main({ env: loadEnvironment(root, process.env), root });
  stopOnSignals(app);
} catch (error: unknown) {
  exitWithError(error);
}
