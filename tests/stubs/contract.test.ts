import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NotImplementedError } from '../../src/shared/todo.js';
import { listTsFiles, SRC } from '../helpers/source-files.js';

// Растяжка этапа 1: каждая экспортированная функция src пока заготовка и бросает NotImplementedError
// с меткой «модуль.функция». Тест сам находит все экспорты. Реализовав функцию, добавьте её ключ
// 'модуль#функция' в EXCLUDED и напишите для неё настоящие тесты: исключается функция, а не модуль,
// пока в модуле остались заготовки. Новый модуль с логикой тоже нужно внести в EXCLUDED.
// Устаревший ключ (модуль удалён, функция переименована) роняет тест. Нет заготовок: удалите файл.

// Точка входа запускает приложение при импорте: её не импортируем вовсе.
const NOT_IMPORTABLE = new Set(['cli.ts']);

// Уже реализованные функции: ключ 'модуль#функция'.
const EXCLUDED = new Set([
  'shared/todo.ts#notImplemented',
  // Этап 4: проверки кодом перенесены из docs/reference/checks.py, тесты в tests/unit/checks.
  'checks/code-checks.ts#checkBrackets',
  'checks/code-checks.ts#checkContacts',
  'checks/code-checks.ts#checkDashes',
  'checks/code-checks.ts#checkHomoglyphs',
  'checks/code-checks.ts#checkJargon',
  'checks/code-checks.ts#checkLength',
  'checks/code-checks.ts#checkLinks',
  'checks/code-checks.ts#checkMarkup',
  'checks/code-checks.ts#checkPrices',
  'checks/code-checks.ts#checkStopWords',
  'checks/code-checks.ts#checkStyle',
  'checks/code-checks.ts#countSentences',
  'checks/code-checks.ts#normalizeDraft',
  'checks/code-checks.ts#runCodeChecks',
  // Этап 2: конфиг, логгер, часы (тесты в tests/unit/config и tests/unit/shared).
  'config/env.ts#loadConfig',
  'config/dotenv.ts#loadEnvironment',
  'config/errors.ts#formatFatalError',
  'shared/logger.ts#createLogger',
  'shared/clock.ts#createSystemClock',
  // Этап 2: база (тесты в tests/unit/db).
  'db/connection.ts#openDatabase',
  'db/connection.ts#createUnitOfWork',
  'db/migrations.ts#runMigrations',
  'db/time.ts#assertTimeMs',
  'db/repos/app-state.ts#createAppStateRepo',
  'db/repos/pairing-attempts.ts#createPairingGuard',
  'db/repos/chats.ts#createChatsRepo',
  'db/repos/messages.ts#createMessagesRepo',
  'db/repos/backlog.ts#createBacklogRepo',
  'db/repos/known-chats.ts#createKnownChatsRepo',
  'db/process-lock.ts#acquireProcessLock',
  // Этап 2: WhatsApp без сети (тесты в tests/unit/whatsapp).
  'whatsapp/jid.ts#phoneToJid',
  'whatsapp/jid.ts#jidToPhone',
  'whatsapp/jid.ts#isPersonalJid',
  'whatsapp/jid.ts#normalizeJid',
  'whatsapp/reconnect.ts#decideOnDisconnect',
  'whatsapp/inbound.ts#classifyUpsert',
  // Этап 2: подключение к WhatsApp, QR, замок сессии (тесты на поддельном сокете).
  'whatsapp/connection.ts#startWhatsApp',
  'whatsapp/qr.ts#createQrPresenter',
  'whatsapp/lid-resolver.ts#createLidResolver',
  'whatsapp/lid-resolver.ts#jidOf',
  'whatsapp/socket-config.ts#buildSocketConfig',
  'whatsapp/socket-config.ts#fetchVersionWithTimeout',
  'whatsapp/reconnect-policy.ts#createReconnectPolicy',
  'whatsapp/offline-queue.ts#createOfflineQueueWatch',
  'whatsapp/message-intake.ts#createMessageIntake',
  // Этап 2: сборка приложения и сохранение входящих (тесты в tests/unit).
  'main.ts#main',
  'pipeline/recorder.ts#createInboundRecorder',
]);

type AnyFunction = (...args: unknown[]) => unknown;

interface ExportedFunction {
  module: string;
  name: string;
  fn: AnyFunction;
}

function isPlainFunction(value: unknown): value is AnyFunction {
  return (
    typeof value === 'function' && !Function.prototype.toString.call(value).startsWith('class')
  );
}

async function collectFunctions(): Promise<ExportedFunction[]> {
  const modules = listTsFiles(SRC).filter((module) => !NOT_IMPORTABLE.has(module));
  const perModule = await Promise.all(
    modules.map(async (module) => {
      const exports = (await import(pathToFileURL(join(SRC, module)).href)) as Record<
        string,
        unknown
      >;
      return Object.entries(exports)
        .filter((entry): entry is [string, AnyFunction] => isPlainFunction(entry[1]))
        .map(([name, fn]) => ({ module, name, fn }));
    }),
  );
  return perModule.flat();
}

/** Вызывает функцию без аргументов и возвращает то, чем она упала: синхронно или промисом. */
async function failureOf(fn: AnyFunction): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

const functions = await collectFunctions();
const existingKeys = new Set(functions.map(({ module, name }) => `${module}#${name}`));
const stubs = functions
  .filter(({ module, name }) => !EXCLUDED.has(`${module}#${name}`))
  .map(({ module, name, fn }) => ({ module, name, fn, feature: `${module.slice(0, -3)}.${name}` }));

describe('заготовки модулей', () => {
  it('находит экспортированные функции заготовок', () => {
    expect(stubs.length).toBeGreaterThan(0);
  });

  it.each([...EXCLUDED])('ключ EXCLUDED %s указывает на существующую функцию', (key) => {
    expect(
      existingKeys.has(key),
      `Устаревший ключ в EXCLUDED: ${key}. Модуль удалён или функция переименована`,
    ).toBe(true);
  });

  it.each(stubs)(
    '$module: $name пока бросает NotImplementedError со своей меткой',
    async ({ feature, fn }) => {
      const failure = await failureOf(fn);
      expect(failure).toBeInstanceOf(NotImplementedError);
      expect(failure).toMatchObject({ feature });
    },
  );
});
