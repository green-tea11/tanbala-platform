import { fileURLToPath } from 'node:url';
import { loadEnvironment } from './config/dotenv.js';
import { formatFatalError } from './config/errors.js';
import { main, type RunningApp } from './main.js';

// Точка входа: единственный модуль, который что-то запускает при импорте.
// Корень проекта считается от этого файла (src/ или dist/), а не от текущей папки процесса.
const root = fileURLToPath(new URL('..', import.meta.url));

/** Код выхода, если остановку прервали повторным сигналом. */
const FORCED_EXIT_CODE = 1;

/** Код выхода, когда WhatsApp остановился сам: служба этапа 8 видит сбой, а не штатное завершение. */
const SELF_STOP_EXIT_CODE = 1;

/**
 * Причина в stderr через formatFatalError (ConfigError: список проблем, SafeError: её текст, прочие: без
 * текста ошибки) и выход с кодом 1, когда текст ушёл.
 */
function exitWithError(error: unknown): void {
  process.stderr.write(formatFatalError(error), () => process.exit(1));
}

/**
 * SIGINT, SIGTERM и SIGHUP: корректная остановка и выход 0; повторный сигнал: выход сразу, не дожидаясь stop.
 * SIGHUP приходит, когда закрыли окно терминала или оборвалась SSH-сессия (привязка по QR идёт в терминале): без
 * обработчика Node завершился бы сразу, посреди записи creds.json, и сессию пришлось бы привязывать заново.
 */
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
  process.on('SIGHUP', onSignal);
}

/** Вывод в закрытый терминал (после SIGHUP) даёт EIO или EPIPE: сообщить об этом некуда, и остановку это не прерывает. */
function isLostOutput(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EIO' || code === 'EPIPE';
}

/** WhatsApp остановился сам (не по stop): процесс завершится сам, но с кодом SELF_STOP_EXIT_CODE. */
function exitCodeOnSelfStop(app: RunningApp): void {
  app.stopped.then((reason) => {
    if (reason !== 'requested') process.exitCode = SELF_STOP_EXIT_CODE;
  }, exitWithError);
}

// Необработанные ошибки: иначе Node напечатает их целиком, с текстом и JID, в обход фильтра.
process.on('uncaughtException', (error) => {
  if (!isLostOutput(error)) exitWithError(error);
});
process.on('unhandledRejection', exitWithError);

try {
  // .env из корня проекта, переменные процесса главнее; сам process.env не меняется.
  const app = await main({ env: loadEnvironment(root, process.env), root });
  stopOnSignals(app);
  exitCodeOnSelfStop(app);
} catch (error: unknown) {
  exitWithError(error);
}
