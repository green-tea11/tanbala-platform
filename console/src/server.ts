import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScryptHasher } from './auth/passwords.js';
import { loadEnvironment } from './config/dotenv.js';
import { loadConfig } from './config/env.js';
import { formatFatalError } from './config/errors.js';
import { openDatabase } from './db/connection.js';
import { buildApp } from './server/app.js';
import { startMaintenance } from './services/maintenance.js';
import { systemClock } from './shared/clock.js';
import { createLogger } from './shared/logger.js';
import { createBackends } from './wiring.js';

/** Корень консоли: папка над dist/. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_DIR = resolve(ROOT, 'web', 'dist');

/** Точка входа службы tanbala-console: настройки, база, сервер на 127.0.0.1:3200, остановка по сигналу. */
async function main(): Promise<void> {
  const config = loadConfig(loadEnvironment(ROOT, process.env), ROOT, process.execArgv);
  const logger = createLogger({ level: config.logLevel });
  const db = openDatabase(config.databasePath);
  const fetchBound = (url: string, init: RequestInit): Promise<Response> => fetch(url, init);
  const backends = createBackends(config, fetchBound, systemClock, logger);
  const { app, context } = buildApp({
    port: config.port,
    allowedHosts: config.allowedHosts,
    db,
    ...backends,
    hasher: createScryptHasher(),
    clock: systemClock,
    logger,
    staticDir: STATIC_DIR,
  });
  const stopMaintenance = startMaintenance({ ...context, clock: systemClock, logger });
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'Консоль останавливается');
    stopMaintenance();
    app
      .close()
      .then(() => db.close())
      .catch((error: unknown) => logger.error({ err: error }, 'Ошибка при остановке'));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  await app.listen({ host: config.host, port: config.port });
  logger.info({ port: config.port }, 'Консоль запущена');
}

main().catch((error: unknown) => {
  process.stderr.write(formatFatalError('Консоль не запущена', error));
  process.exitCode = 1;
});
