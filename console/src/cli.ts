import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScryptHasher } from './auth/passwords.js';
import { runUserCommand } from './cli/commands.js';
import { createPasswordReader } from './cli/password-prompt.js';
import { loadEnvironment } from './config/dotenv.js';
import { resolveDatabasePath } from './config/env.js';
import { ConfigError, formatFatalError } from './config/errors.js';
import { openDatabase } from './db/connection.js';
import { systemClock } from './shared/clock.js';

/** Корень консоли: папка над dist/. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * node dist/cli.js user add|passwd|role|disable|enable|list|revoke. Нужна только база (CONSOLE_DATABASE_PATH),
 * токены к почте и боту команде не нужны. Пароль без эха из терминала или строкой из stdin.
 */
async function main(): Promise<number> {
  const databasePath = resolveDatabasePath(loadEnvironment(ROOT, process.env), ROOT);
  if (databasePath === null) {
    throw new ConfigError(['CONSOLE_DATABASE_PATH: путь должен вести внутрь папки data/ консоли']);
  }
  const db = openDatabase(databasePath);
  const reader = createPasswordReader(process.stdin, process.stderr);
  try {
    return await runUserCommand(process.argv.slice(2), {
      db,
      hasher: createScryptHasher(),
      clock: systemClock,
      io: {
        interactive: reader.interactive,
        readPassword: (prompt) => reader.read(prompt),
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
      },
    });
  } finally {
    db.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(formatFatalError('Команда не выполнена', error));
    process.exitCode = 1;
  });
