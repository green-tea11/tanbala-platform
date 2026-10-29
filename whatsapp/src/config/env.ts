import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { ApiLimits, LlmPurpose, PhoneDigits } from '../domain/types.js';
import {
  EMAIL_API_DEFAULT_URL,
  INTERNAL_API_TOKEN_PATTERN,
  isNodeEnvProxyOn,
  parseEmailApiUrl,
  parseEmailUiUrl,
} from './company-settings.js';
import { ConfigError } from './errors.js';

/** Переменные окружения: имя и значение. */
export type EnvVars = Readonly<Record<string, string | undefined>>;

/** ID моделей Claude по видам вызова. Источник: config/models.json, меняется без правки кода. */
export type ModelsConfig = Readonly<Record<LlmPurpose, string>>;

/** Расшифровка голосовых через OpenRouter. */
export interface VoiceConfig {
  /** OPENROUTER_API_KEY: передаётся явно. */
  readonly apiKey: string;
  /** ID модели OpenRouter из config/models.json (ключ transcribe). */
  readonly model: string;
}

/**
 * TEST_MODE и TEST_ALLOWLIST. Закрытый режим на рабочем номере (enabled true, решение владельца, тестового номера
 * нет): бот обрабатывает только чаты с номеров из списка, остальные полностью игнорирует. Рабочий режим (enabled
 * false, этап 8): бот отвечает всем, кроме чатов, которые были на номере до перехода (pipeline/working-mode.ts);
 * номера из списка работают как в закрытом режиме, правило перехода их не трогает.
 */
export interface TestMode {
  readonly enabled: boolean;
  readonly allowlist: ReadonlySet<PhoneDigits>;
}

/** Внутренний API почтового проекта: адрес (только эта машина) и токен. Токен в логи и тексты ошибок не попадает. */
export interface CompanyApiConfig {
  /** EMAIL_API_URL после проверки: http, хост только 127.0.0.1, без пути и хвостового «/». */
  readonly baseUrl: string;
  /** INTERNAL_API_TOKEN: от 32 до 512 видимых символов ASCII. */
  readonly token: string;
}

/** Проверенные настройки приложения. Все пути абсолютные, от корня проекта. */
export interface AppConfig {
  /** VENMART_ANTHROPIC_KEY. null: ключ не задан, LLM выключен. */
  readonly anthropicKey: string | null;
  /** MANAGER_WHATSAPP. null: уведомлений нет, только отметка в панели. */
  readonly managerPhone: PhoneDigits | null;
  /** ADMIN_PASSWORD, по умолчанию admin. */
  readonly adminPassword: string;
  /** null: OPENROUTER_API_KEY не задан, расшифровка голосовых выключена. */
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
  /**
   * PANEL_HOST и PANEL_PORT; PANEL_ALLOWED_HOSTS: домены панели за Caddy на VPS (в нижнем регистре, с портом, если он
   * не 443). Пусто по умолчанию. Действуют только при сильном пароле: решает panel/guard.ts.
   */
  readonly panel: {
    readonly host: string;
    readonly port: number;
    readonly allowedHosts: readonly string[];
  };
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
  /** INTERNAL_API_TOKEN и EMAIL_API_URL. null: токен не задан, определение компании выключено. */
  readonly companyApi: CompanyApiConfig | null;
  /** EMAIL_UI_URL без хвостового «/»: адрес интерфейса почтового проекта для ссылок менеджеру; null: не задан. */
  readonly emailUiUrl: string | null;
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
  emailApiUrl: EMAIL_API_DEFAULT_URL,
} as const;

/** Потолок порога простоя: год. Больше не нужно, и перевод в мс остаётся точным. */
const MAX_BACKLOG_HOURS = 8760;
const MAX_PORT = 65_535;

const MANAGER_PHONE = /^\d{11,15}$/;
const ALLOWLIST_PHONE = /^77\d{9}$/;
const UNSIGNED_INTEGER = /^\d+$/;
const NO_WHITESPACE = /^\S+$/;
/** Домен для заголовка Host: латиница, цифры, точки и дефисы (не по краям), необязательный порт. */
const PANEL_HOST_NAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::(\d{1,5}))?$/i;
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
  panelHosts: 'домены через запятую вида panel.example.kz или panel.example.kz:8443',
  model: 'нужен ID модели Claude вида claude-...',
  transcribeModel: 'нужен ID модели OpenRouter без пробелов, например elevenlabs/scribe-v2',
  modelsShape: 'нужен объект с полями reply, review, interest, logo, transcribe',
  customHeaders:
    'уберите переменную из окружения: SDK Anthropic подмешивает эти заголовки к запросам и может подменить ключ',
  internalApiToken: 'от 32 до 512 видимых символов ASCII без пробелов',
  emailApiUrl:
    'адрес только по http, хост только 127.0.0.1 (localhost нельзя: он может указать на ::1), без логина, пароля, пути, параметров и якоря',
  emailUiUrl:
    'адрес по https (http только для 127.0.0.1 и localhost), без логина, пароля, параметров и якоря',
  envProxy:
    'включён прокси Node для fetch (NODE_USE_ENV_PROXY или --use-env-proxy в NODE_OPTIONS), токен мог бы уйти через прокси: выключите прокси для бота или уберите токен',
} as const;

const WARNINGS = {
  baseUrl: `${SDK_BASE_URL} задана в окружении и не используется: адрес API передаётся в SDK явно`,
  emptyAllowlist: 'закрытый режим, а TEST_ALLOWLIST пуст: бот не обрабатывает ни один чат',
} as const;

function allowlistProblem(position: number): string {
  return `номер ${position} в списке не в формате 77XXXXXXXXX`;
}

function panelHostProblem(position: number): string {
  return `${PROBLEMS.panelHosts}: позиция ${position} не домен`;
}

/** Домен с необязательным портом от 1 до 65535 (схема и путь не годятся: в Host их нет). */
function isPanelHost(value: string): boolean {
  const match = PANEL_HOST_NAME.exec(value);
  if (match === null) return false;
  const port = match[1];
  return port === undefined || (Number(port) >= 1 && Number(port) <= MAX_PORT);
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

/** Адрес, который parse приводит к виду без хвостового «/»; неверный: проблема без значения (в адресе бывают данные). */
function normalizedUrl(parse: (value: string) => string | null, problem: string) {
  return z.string().transform((value, ctx): string => {
    const normalized = parse(value);
    if (normalized === null) {
      ctx.issues.push({ code: 'custom', message: problem, input: undefined });
      return value;
    }
    return normalized;
  });
}

/** Домены панели через запятую; неверный называется позицией в списке, сам значение не печатается. */
function panelHosts() {
  return z
    .string()
    .optional()
    .transform((value, ctx): readonly string[] => {
      const items =
        value === undefined ? [] : value.split(',').map((item) => item.trim().toLowerCase());
      items.forEach((item, index) => {
        if (!isPanelHost(item)) {
          ctx.issues.push({
            code: 'custom',
            message: panelHostProblem(index + 1),
            input: undefined,
          });
        }
      });
      return items.filter(isPanelHost);
    });
}

function envSchema(root: string) {
  const positiveInteger = (): ReturnType<typeof integerInRange> =>
    integerInRange(1, Number.MAX_SAFE_INTEGER, PROBLEMS.positiveInteger);
  return z.object({
    VENMART_ANTHROPIC_KEY: z.string().optional(),
    OPENROUTER_API_KEY: z.string().optional(),
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
    PANEL_ALLOWED_HOSTS: panelHosts(),
    // Пусто: связь с почтовым проектом выключена. Токен не показывается ни в проблемах, ни в логе.
    INTERNAL_API_TOKEN: z
      .string()
      .regex(INTERNAL_API_TOKEN_PATTERN, PROBLEMS.internalApiToken)
      .optional(),
    EMAIL_API_URL: normalizedUrl(parseEmailApiUrl, PROBLEMS.emailApiUrl).default(
      DEFAULTS.emailApiUrl,
    ),
    EMAIL_UI_URL: normalizedUrl(parseEmailUiUrl, PROBLEMS.emailUiUrl).optional(),
  });
}

type EnvValues = z.output<ReturnType<typeof envSchema>>;

const claudeModelId = z.string({ error: PROBLEMS.model }).regex(CLAUDE_MODEL_ID, PROBLEMS.model);

/** Модель расшифровки не Claude: ID OpenRouter вида провайдер/модель, проверяется только на пустоту и пробелы. */
const transcribeModelId = z
  .string({ error: PROBLEMS.transcribeModel })
  .regex(NO_WHITESPACE, PROBLEMS.transcribeModel);

const modelsSchema = z.object(
  {
    reply: claudeModelId,
    review: claudeModelId,
    interest: claudeModelId,
    logo: claudeModelId,
    transcribe: transcribeModelId,
  },
  { error: PROBLEMS.modelsShape },
);

type ModelsValues = z.output<typeof modelsSchema>;

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

/** Задан токен внутреннего API, а fetch пошёл бы через прокси из окружения: запуск запрещён, токен не должен уйти. */
function proxyProblems(env: EnvVars, token: string | undefined): string[] {
  return token !== undefined && isNodeEnvProxyOn(env)
    ? [`INTERNAL_API_TOKEN: ${PROBLEMS.envProxy}`]
    : [];
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

function buildConfig(env: EnvValues, models: ModelsValues, root: string): AppConfig {
  const { transcribe, ...claudeModels } = models;
  return {
    anthropicKey: env.VENMART_ANTHROPIC_KEY ?? null,
    managerPhone: env.MANAGER_WHATSAPP ?? null,
    adminPassword: env.ADMIN_PASSWORD,
    voice:
      env.OPENROUTER_API_KEY === undefined
        ? null
        : { apiKey: env.OPENROUTER_API_KEY, model: transcribe },
    waEnabled: env.WA_ENABLED,
    waSessionDir: env.WHATSAPP_SESSION_DIR,
    databasePath: env.DATABASE_PATH,
    tokenLogPath: env.TOKEN_LOG_PATH,
    knowledgeDir: resolve(root, KNOWLEDGE_DIR),
    pairingMirrorPath: resolve(root, PAIRING_MIRROR_FILE),
    panel: { host: env.PANEL_HOST, port: env.PANEL_PORT, allowedHosts: env.PANEL_ALLOWED_HOSTS },
    models: claudeModels,
    limits: {
      apiCallsPerDay: env.API_DAILY_LIMIT,
      apiCallsPerChatPerDay: env.API_DAILY_LIMIT_PER_CHAT,
    },
    backlogMaxAgeHours: env.BACKLOG_MAX_AGE_HOURS,
    // Схема пропускает только TEST_MODE=true: закрытый режим включён всегда (до этапа 8).
    testMode: { enabled: true, allowlist: env.TEST_ALLOWLIST },
    companyApi:
      env.INTERNAL_API_TOKEN === undefined
        ? null
        : { baseUrl: env.EMAIL_API_URL, token: env.INTERNAL_API_TOKEN },
    emailUiUrl: env.EMAIL_UI_URL ?? null,
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
 * voice собирается при непустом OPENROUTER_API_KEY, модель из ключа transcribe в config/models.json
 * (обязателен всегда, как модели Claude); без ключа voice null и расшифровка выключена.
 * Связь с почтовым проектом: INTERNAL_API_TOKEN пуст => companyApi null и определение компании выключено; непустой:
 * от 32 до 512 видимых символов ASCII без пробелов; вместе с прокси Node для fetch (NODE_USE_ENV_PROXY=1 или true,
 * --use-env-proxy в NODE_OPTIONS) отказ в запуске. EMAIL_API_URL (по умолчанию http://127.0.0.1:8000): только http
 * и хост 127.0.0.1, без логина, пароля, пути, параметров и якоря: токен не должен уйти с этой машины. EMAIL_UI_URL
 * (необязательно): https, а http только для 127.0.0.1 и localhost, без логина, пароля, параметров и якоря, хвостовой
 * «/» убирается.
 * TODO(этап 3): стандартную переменную ключа SDK не читать никогда: ключ только из VENMART_ANTHROPIC_KEY.
 */
export function loadConfig(env: EnvVars, modelsJson: unknown, root: string): LoadedConfig {
  const schema = envSchema(root);
  const normalized = normalizeEnv(env, Object.keys(schema.shape));
  const parsedEnv = schema.safeParse(normalized);
  const parsedModels = modelsSchema.safeParse(modelsJson);
  const problems = [
    ...sdkProblems(env),
    ...proxyProblems(env, normalized['INTERNAL_API_TOKEN']),
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
