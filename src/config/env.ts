import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { ApiLimits, LlmPurpose, PhoneDigits } from '../domain/types.js';
import { ConfigError } from './errors.js';

/** Переменные окружения: имя и значение. */
export type EnvVars = Readonly<Record<string, string | undefined>>;

/** ID моделей для трёх вызовов LLM. Источник: config/models.json, меняется без правки кода. */
export type ModelsConfig = Readonly<Record<LlmPurpose, string>>;

/** Расшифровка голосовых через OpenRouter. Модель распознавания речи: открытый вопрос плана. */
export interface VoiceConfig {
  /** OPENROUTER_API_KEY: передаётся явно. */
  readonly apiKey: string;
  readonly model: string;
}

/**
 * Закрытый режим на рабочем номере (решение владельца, тестового номера нет): пока он включён, бот
 * обрабатывает только чаты с номеров из списка, остальные полностью игнорирует.
 */
export type TestMode =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly allowlist: ReadonlySet<PhoneDigits> };

/** Проверенные настройки приложения. Все пути абсолютные, от корня проекта. */
export interface AppConfig {
  /** VENMART_ANTHROPIC_KEY. null: ключ не задан, LLM выключен. */
  readonly anthropicKey: string | null;
  /** MANAGER_WHATSAPP. null: уведомлений нет, только отметка в панели. */
  readonly managerPhone: PhoneDigits | null;
  /** ADMIN_PASSWORD, по умолчанию admin. */
  readonly adminPassword: string;
  /** null: расшифровка голосовых выключена (нет ключа или модели). */
  readonly voice: VoiceConfig | null;
  /** WA_ENABLED. false: к WhatsApp не подключаться и QR не показывать. */
  readonly waEnabled: boolean;
  /** WHATSAPP_SESSION_DIR: папка сессии Baileys, полный доступ к номеру. */
  readonly waSessionDir: string;
  /** DATABASE_PATH: SQLite с перепиской (персональные данные). */
  readonly databasePath: string;
  /** TOKEN_LOG_PATH: лог расхода API. */
  readonly tokenLogPath: string;
  /** Папка knowledge/ с двумя файлами знаний. */
  readonly knowledgeDir: string;
  /** Копия счётчика попыток привязки по QR: .pairing-attempts.json в корне проекта, вне data/. */
  readonly pairingMirrorPath: string;
  /** PANEL_HOST и PANEL_PORT. */
  readonly panel: { readonly host: string; readonly port: number };
  readonly models: ModelsConfig;
  /** API_DAILY_LIMIT и API_DAILY_LIMIT_PER_CHAT: дневной предохранитель расходов. */
  readonly limits: ApiLimits;
  /**
   * BACKLOG_MAX_AGE_HOURS: сообщения за время простоя не старше этого числа часов получают ответ,
   * о более старых менеджеру уходит одно уведомление со списком чатов.
   */
  readonly backlogMaxAgeHours: number;
  /** TEST_MODE и TEST_ALLOWLIST: закрытый режим на рабочем номере. */
  readonly testMode: TestMode;
}

/** Итог loadConfig: настройки и предупреждения для лога (без значений переменных). */
export interface LoadedConfig {
  readonly config: AppConfig;
  readonly warnings: readonly string[];
}

/** Папка данных в корне проекта: сессия WhatsApp, база и лог расхода разрешены только внутри неё. */
const DATA_DIR = 'data';
const KNOWLEDGE_DIR = 'knowledge';
/** Копия счётчика привязки лежит вне data/: удаление data/ не обнуляет лимит попыток. */
const PAIRING_MIRROR_FILE = '.pairing-attempts.json';
const MODELS_FILE = 'config/models.json';

/** Значения по умолчанию совпадают с .env.example: предохранитель не выключается случайно. */
const DEFAULTS = {
  adminPassword: 'admin',
  waSessionDir: './data/whatsapp-session',
  databasePath: './data/tanbala.db',
  tokenLogPath: './data/token-usage.jsonl',
  apiCallsPerDay: 500,
  apiCallsPerChatPerDay: 100,
  backlogMaxAgeHours: 12,
  panelHost: '127.0.0.1',
  panelPort: 3100,
} as const;

/** Потолок порога простоя: год. Больше не нужно, и перевод в мс остаётся точным. */
const MAX_BACKLOG_HOURS = 8760;
const MAX_PORT = 65_535;

const MANAGER_PHONE = /^\d{11,15}$/;
const ALLOWLIST_PHONE = /^77\d{9}$/;
const UNSIGNED_INTEGER = /^\d+$/;
const NO_WHITESPACE = /^\S+$/;
const CLAUDE_MODEL_ID = /^claude-[a-z0-9-]+$/;

/** Переменные, которые SDK Anthropic читает из окружения сам, мимо AppConfig. */
const SDK_CUSTOM_HEADERS = 'ANTHROPIC_CUSTOM_HEADERS';
const SDK_BASE_URL = 'ANTHROPIC_BASE_URL';

/** Причины отказа: без значений переменных, в них бывают ключи и номера. */
const PROBLEMS = {
  managerPhone: 'только цифры с кодом страны, от 11 до 15 цифр, например 7XXXXXXXXXX',
  flag: 'только true или false',
  testModeOff: 'выключение закрытого режима появится на этапе 8, пока только true',
  dataPath: 'путь должен вести внутрь папки data/ в корне проекта',
  positiveInteger: 'целое число больше нуля',
  backlogHours: `целое число часов от 1 до ${MAX_BACKLOG_HOURS}`,
  port: `целое число от 1 до ${MAX_PORT}`,
  host: 'адрес без пробелов',
  model: 'нужен ID модели Claude вида claude-...',
  modelsShape: 'нужен объект с полями reply, review, interest',
  customHeaders:
    'уберите переменную из окружения: SDK Anthropic подмешивает эти заголовки к запросам и может подменить ключ',
} as const;

const WARNINGS = {
  baseUrl: `${SDK_BASE_URL} задана в окружении и не используется: адрес API передаётся в SDK явно`,
  emptyAllowlist: 'закрытый режим, а TEST_ALLOWLIST пуст: бот не обрабатывает ни один чат',
} as const;

function allowlistProblem(position: number): string {
  return `номер ${position} в списке не в формате 77XXXXXXXXX`;
}

/** Номер закрытого режима (77XXXXXXXXX); здесь граница config, где строка становится PhoneDigits. */
function isAllowlistPhone(value: string): value is PhoneDigits {
  return ALLOWLIST_PHONE.test(value);
}

/** Строго внутри dir: сама папка, соседние папки и выход через «..» не годятся. */
function isInsideDir(dir: string, target: string): boolean {
  const path = relative(dir, target);
  return path !== '' && !isAbsolute(path) && path.split(sep)[0] !== '..';
}

function booleanFlag(fallback: boolean) {
  return z
    .enum(['true', 'false'], { error: PROBLEMS.flag })
    .transform((value) => value === 'true')
    .default(fallback);
}

function integerInRange(min: number, max: number, problem: string) {
  return z
    .string()
    .regex(UNSIGNED_INTEGER, problem)
    .transform((value) => Number(value))
    .refine((value) => Number.isSafeInteger(value) && value >= min && value <= max, problem);
}

/** Путь от корня проекта (а не от текущей папки процесса), только внутри data/. */
function dataPath(root: string, fallback: string) {
  const dataDir = resolve(root, DATA_DIR);
  return z
    .string()
    .default(fallback)
    .transform((value, ctx) => {
      const fullPath = resolve(root, value);
      if (!isInsideDir(dataDir, fullPath)) {
        ctx.issues.push({ code: 'custom', message: PROBLEMS.dataPath, input: undefined });
      }
      return fullPath;
    });
}

/** Номера через запятую; неверный называется позицией в списке, сам номер не печатается. */
function allowlist() {
  return z
    .string()
    .optional()
    .transform((value, ctx): ReadonlySet<PhoneDigits> => {
      const items = value === undefined ? [] : value.split(',').map((item) => item.trim());
      items.forEach((item, index) => {
        if (!isAllowlistPhone(item)) {
          ctx.issues.push({
            code: 'custom',
            message: allowlistProblem(index + 1),
            input: undefined,
          });
        }
      });
      return new Set(items.filter(isAllowlistPhone));
    });
}

function envSchema(root: string) {
  const positiveInteger = (): ReturnType<typeof integerInRange> =>
    integerInRange(1, Number.MAX_SAFE_INTEGER, PROBLEMS.positiveInteger);
  return z.object({
    VENMART_ANTHROPIC_KEY: z.string().optional(),
    // Приведение к PhoneDigits после проверки формата: граница config.
    MANAGER_WHATSAPP: z
      .string()
      .regex(MANAGER_PHONE, PROBLEMS.managerPhone)
      .transform((value) => value as PhoneDigits)
      .optional(),
    ADMIN_PASSWORD: z.string().default(DEFAULTS.adminPassword),
    WA_ENABLED: booleanFlag(false),
    // Нет переменной: закрытый режим, на рабочем номере так безопаснее. До этапа 8 его не выключить.
    // TODO(этап 8): разрешить TEST_MODE=false вместе с переходом из main.ts (граница в app_state).
    TEST_MODE: z
      .enum(['true', 'false'], { error: PROBLEMS.flag })
      .refine((value) => value === 'true', PROBLEMS.testModeOff)
      .optional(),
    TEST_ALLOWLIST: allowlist(),
    WHATSAPP_SESSION_DIR: dataPath(root, DEFAULTS.waSessionDir),
    DATABASE_PATH: dataPath(root, DEFAULTS.databasePath),
    TOKEN_LOG_PATH: dataPath(root, DEFAULTS.tokenLogPath),
    API_DAILY_LIMIT: positiveInteger().default(DEFAULTS.apiCallsPerDay),
    API_DAILY_LIMIT_PER_CHAT: positiveInteger().default(DEFAULTS.apiCallsPerChatPerDay),
    BACKLOG_MAX_AGE_HOURS: integerInRange(1, MAX_BACKLOG_HOURS, PROBLEMS.backlogHours).default(
      DEFAULTS.backlogMaxAgeHours,
    ),
    PANEL_HOST: z.string().regex(NO_WHITESPACE, PROBLEMS.host).default(DEFAULTS.panelHost),
    PANEL_PORT: integerInRange(1, MAX_PORT, PROBLEMS.port).default(DEFAULTS.panelPort),
  });
}

type EnvValues = z.output<ReturnType<typeof envSchema>>;

const claudeModelId = z.string({ error: PROBLEMS.model }).regex(CLAUDE_MODEL_ID, PROBLEMS.model);

const modelsSchema = z.object(
  { reply: claudeModelId, review: claudeModelId, interest: claudeModelId },
  { error: PROBLEMS.modelsShape },
);

/** Пустое значение и значение из пробелов значат «переменная не задана»; остальные обрезаются по краям. */
function normalizeEnv(env: EnvVars, names: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(
    names.map((name) => {
      const value = env[name]?.trim();
      return [name, value === '' ? undefined : value];
    }),
  );
}

/**
 * Задана ли переменная, которую SDK Anthropic прочитает сам. Регистр имени не важен:
 * на Windows имена переменных окружения от регистра не зависят, и SDK увидит любой вариант.
 */
function isSetForSdk(env: EnvVars, name: string): boolean {
  return Object.entries(env).some(
    ([key, value]) => key.toUpperCase() === name && value !== undefined && value.trim() !== '',
  );
}

/** SDK подмешивает ANTHROPIC_CUSTOM_HEADERS после ключа и может его подменить: с ней запуск запрещён. */
function sdkProblems(env: EnvVars): string[] {
  return isSetForSdk(env, SDK_CUSTOM_HEADERS)
    ? [`${SDK_CUSTOM_HEADERS}: ${PROBLEMS.customHeaders}`]
    : [];
}

function describeIssues(issues: readonly z.core.$ZodIssue[], prefix: readonly string[]): string[] {
  return issues.map((issue) => [...prefix, ...issue.path.map(String), issue.message].join(': '));
}

function collectWarnings(env: EnvVars, allowlist: ReadonlySet<PhoneDigits>): string[] {
  return [
    ...(isSetForSdk(env, SDK_BASE_URL) ? [WARNINGS.baseUrl] : []),
    ...(allowlist.size === 0 ? [WARNINGS.emptyAllowlist] : []),
  ];
}

function buildConfig(env: EnvValues, models: ModelsConfig, root: string): AppConfig {
  return {
    anthropicKey: env.VENMART_ANTHROPIC_KEY ?? null,
    managerPhone: env.MANAGER_WHATSAPP ?? null,
    adminPassword: env.ADMIN_PASSWORD,
    // Модель OpenRouter не выбрана (этап 7): голос выключен при любом OPENROUTER_API_KEY.
    voice: null,
    waEnabled: env.WA_ENABLED,
    waSessionDir: env.WHATSAPP_SESSION_DIR,
    databasePath: env.DATABASE_PATH,
    tokenLogPath: env.TOKEN_LOG_PATH,
    knowledgeDir: resolve(root, KNOWLEDGE_DIR),
    pairingMirrorPath: resolve(root, PAIRING_MIRROR_FILE),
    panel: { host: env.PANEL_HOST, port: env.PANEL_PORT },
    models,
    limits: {
      apiCallsPerDay: env.API_DAILY_LIMIT,
      apiCallsPerChatPerDay: env.API_DAILY_LIMIT_PER_CHAT,
    },
    backlogMaxAgeHours: env.BACKLOG_MAX_AGE_HOURS,
    // Схема пропускает только TEST_MODE=true: закрытый режим включён всегда (до этапа 8).
    testMode: { enabled: true, allowlist: env.TEST_ALLOWLIST },
  };
}

/**
 * Собирает AppConfig из переменных окружения и config/models.json. Единственное место,
 * где разбираются переменные из .env: остальной код получает готовый AppConfig.
 * Пустое значение и значение из пробелов значат «переменная не задана», тогда берётся значение по умолчанию.
 * Ошибки всех переменных собираются сразу в ConfigError: имя переменной и причина, без значения (там секреты).
 * ANTHROPIC_CUSTOM_HEADERS в окружении => отказ в запуске: SDK подмешивает эти заголовки после ключа и может его подменить.
 * TEST_MODE=false => отказ в запуске: выключение закрытого режима появится на этапе 8.
 * Предупреждения (ANTHROPIC_BASE_URL в окружении; пустой TEST_ALLOWLIST: бот не отвечает никому)
 * возвращаются в warnings: логгера на этом шаге ещё нет, их пишет в лог вызывающий.
 * TODO(этап 3): стандартную переменную ключа SDK не читать никогда: ключ только из VENMART_ANTHROPIC_KEY.
 * TODO(этап 7): voice собирать, только когда есть и ключ OpenRouter, и модель.
 */
export function loadConfig(env: EnvVars, modelsJson: unknown, root: string): LoadedConfig {
  const schema = envSchema(root);
  const parsedEnv = schema.safeParse(normalizeEnv(env, Object.keys(schema.shape)));
  const parsedModels = modelsSchema.safeParse(modelsJson);
  const problems = [
    ...sdkProblems(env),
    ...(parsedEnv.success ? [] : describeIssues(parsedEnv.error.issues, [])),
    ...(parsedModels.success ? [] : describeIssues(parsedModels.error.issues, [MODELS_FILE])),
  ];
  if (!parsedEnv.success || !parsedModels.success || problems.length > 0) {
    throw new ConfigError([...new Set(problems)]);
  }
  return {
    config: buildConfig(parsedEnv.data, parsedModels.data, root),
    warnings: collectWarnings(env, parsedEnv.data.TEST_ALLOWLIST),
  };
}
