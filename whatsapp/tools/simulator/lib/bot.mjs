// Сборка бота из его dist/: модули, временный корень проекта и окружение симулятора.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Переменные, которые бот защищает от подмены окружением процесса (config/dotenv.ts): их ставит только симулятор. */
const GUARDED = new Set(['TEST_MODE', 'TEST_ALLOWLIST', 'WA_ENABLED']);
/** Переменные самого симулятора: боту не нужны. */
const SIM_ONLY = /^(SIM_|BOT_ROOT$)/u;
/** Похожее на секрет по имени переменной: значения маскируются во всех файлах вывода. */
const SECRET_NAME = /(KEY|TOKEN|PASSWORD|SECRET)(?!.*_(PATH|DIR|URL|PORT|HOST)$)/iu;
/** Токен поддельной почты: 32+ видимых знака ASCII, как требует config/env.ts. */
const FAKE_INTERNAL_TOKEN = `sim-fake-internal-token-${'x'.repeat(24)}`;

async function importDist(botRoot, file) {
  const path = join(botRoot, 'dist', ...file.split('/'));
  if (!existsSync(path)) {
    throw new Error(`Нет ${path}: соберите бота (npm run build в ${botRoot}) или задайте BOT_ROOT`);
  }
  return import(pathToFileURL(path).href);
}

/** Модули бота из dist (те же файлы, что запускает служба). */
export async function loadBot(botRoot) {
  const [main, dotenv, env, modelsFile, anthropic, connection, inbound, intake, lid, directory] =
    await Promise.all([
      importDist(botRoot, 'main.js'),
      importDist(botRoot, 'config/dotenv.js'),
      importDist(botRoot, 'config/env.js'),
      importDist(botRoot, 'config/models-file.js'),
      importDist(botRoot, 'llm/anthropic.js'),
      importDist(botRoot, 'whatsapp/connection.js'),
      importDist(botRoot, 'whatsapp/inbound.js'),
      importDist(botRoot, 'whatsapp/message-intake.js'),
      importDist(botRoot, 'whatsapp/lid-resolver.js'),
      importDist(botRoot, 'company-api/directory.js'),
    ]);
  const require = createRequire(join(botRoot, 'package.json'));
  return {
    main: main.main,
    loadEnvironment: dotenv.loadEnvironment,
    loadConfig: env.loadConfig,
    readModelsJson: modelsFile.readModelsJson,
    createAnthropicLlm: anthropic.createAnthropicLlm,
    LINKED_AT_SKEW_MS: connection.LINKED_AT_SKEW_MS,
    classifyUpsert: inbound.classifyUpsert,
    createMessageIntake: intake.createMessageIntake,
    createLidResolver: lid.createLidResolver,
    createCompanyDirectory: directory.createCompanyDirectory,
    Database: require('better-sqlite3'),
    toJsonSchema: await zodToJsonSchema(botRoot),
  };
}

/** z.toJSONSchema из того же экземпляра zod, что у бота (ESM-сборка); нет: схемы в prompts.md не попадут. */
async function zodToJsonSchema(botRoot) {
  const path = join(botRoot, 'node_modules', 'zod', 'index.js');
  if (!existsSync(path)) return null;
  try {
    const zod = await import(pathToFileURL(path).href);
    return typeof zod.toJSONSchema === 'function' ? (schema) => zod.toJSONSchema(schema) : null;
  } catch {
    return null;
  }
}

/**
 * Временный корень проекта: data/ (база, замок процесса, лог токенов), копия config/models.json и knowledge/*.md
 * из BOT_ROOT. От него main считает все пути, поэтому настоящие data/tanbala.db, сессия и замок бота недостижимы.
 */
export function createSimRoot(botRoot) {
  const root = mkdtempSync(join(tmpdir(), 'tanbala-sim-'));
  mkdirSync(join(root, 'config'));
  mkdirSync(join(root, 'data'));
  mkdirSync(join(root, 'knowledge'));
  copyFileSync(join(botRoot, 'config', 'models.json'), join(root, 'config', 'models.json'));
  // SIM_KNOWLEDGE_DIR: знания из другой папки (проверка правки knowledge/ до выкладки).
  const knowledge = process.env.SIM_KNOWLEDGE_DIR ?? join(botRoot, 'knowledge');
  for (const name of readdirSync(knowledge)) {
    if (name.endsWith('.md')) copyFileSync(join(knowledge, name), join(root, 'knowledge', name));
  }
  return root;
}

/**
 * Окружение бота в симуляторе: .env из BOT_ROOT тем же loadEnvironment, что у cli.ts, поверх него переменные процесса
 * (кроме защищённых и SIM_*), поверх всего переопределения симулятора. Значения не печатаются.
 */
export function buildEnv({ bot, botRoot, processEnv, phone, managerPhone, fake }) {
  const fileEnv = bot.loadEnvironment(botRoot, {});
  const env = { ...fileEnv };
  for (const [name, value] of Object.entries(processEnv)) {
    if (value === undefined || GUARDED.has(name.toUpperCase()) || SIM_ONLY.test(name)) continue;
    env[name] = value;
  }
  const secrets = Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string' && value.trim().length >= 6)
    .map(([, value]) => value.trim());
  delete env.WA_CONSOLE_TOKEN;
  delete env.CONSOLE_API_PORT;
  Object.assign(env, {
    // main подключает конвейер ответов только при WA_ENABLED=true; подключение подменено швом startWhatsApp.
    WA_ENABLED: 'true',
    TEST_MODE: 'true',
    TEST_ALLOWLIST: phone,
    WHATSAPP_SESSION_DIR: './data/sim-no-session',
    DATABASE_PATH: './data/sim.db',
    TOKEN_LOG_PATH: './data/token-usage.jsonl',
  });
  if (managerPhone === null) delete env.MANAGER_WHATSAPP;
  else env.MANAGER_WHATSAPP = managerPhone;
  if (fake) {
    Object.assign(env, {
      VENMART_ANTHROPIC_KEY: 'sim-fake-anthropic-key',
      OPENROUTER_API_KEY: 'sim-fake-openrouter-key',
      INTERNAL_API_TOKEN: FAKE_INTERNAL_TOKEN,
      EMAIL_API_URL: 'http://127.0.0.1:8000',
      EMAIL_UI_URL: 'http://127.0.0.1:8001',
    });
  }
  return { env, secrets };
}

/** Путь строго внутри папки. */
export function isInside(dir, target) {
  const path = relative(resolve(dir), resolve(target));
  return path !== '' && !isAbsolute(path) && path.split(/[\\/]/u)[0] !== '..';
}
