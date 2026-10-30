import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { EnvVars } from './dotenv.js';
import { ConfigError } from './errors.js';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

/** Адрес и токен одного приложения за консолью (почта или бот). */
export interface BackendConfig {
  /** http://127.0.0.1:<порт> без хвостового «/». */
  readonly baseUrl: string;
  readonly token: string;
}

/** Настройки консоли: единственное место, где разбираются переменные окружения. */
export interface ConsoleConfig {
  readonly host: string;
  readonly port: number;
  /** Домены консоли за Caddy, как их шлёт браузер в Host (например panel.tanbala.kz); только по HTTPS. */
  readonly allowedHosts: readonly string[];
  readonly leads: BackendConfig;
  readonly wa: BackendConfig;
  readonly databasePath: string;
  readonly logLevel: LogLevel;
}

const LOOPBACK_HOST = '127.0.0.1';
const DATA_DIR = 'data';
const MAX_PORT = 65_535;
const DEFAULTS = {
  port: 3200,
  leadsUrl: 'http://127.0.0.1:8000',
  waUrl: 'http://127.0.0.1:3101',
  databasePath: 'data/console.db',
  logLevel: 'info' as LogLevel,
} as const;

const LOG_LEVELS: readonly LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
];
/** Токен консоли: 32–512 видимых символов ASCII без пробелов (как требует контракт CONSOLE_API). */
export const CONSOLE_TOKEN_PATTERN = /^[\x21-\x7E]{32,512}$/;
/** Адрес приложения: только http и только 127.0.0.1 с портом (localhost может указать на ::1). */
const BACKEND_URL = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/;
const UNSIGNED_INTEGER = /^\d{1,5}$/;
/** Домен для заголовка Host: латиница, цифры, точки и дефисы (не по краям), необязательный порт. */
const HOST_NAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::(\d{1,5}))?$/;
const LOCAL_NAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost']);
const ENV_PROXY_ON = /^(?:1|true)$/i;
const USE_ENV_PROXY_FLAG = /(?:^|\s)--use[-_]env[-_]proxy(?:=\S*)?(?=\s|$)/i;

const PROBLEMS = {
  host: `только ${LOOPBACK_HOST}: консоль стоит за Caddy на этой же машине`,
  port: `целое число от 1 до ${MAX_PORT}`,
  allowedHosts:
    'домены через запятую вида panel.tanbala.kz (127.0.0.1 и localhost разрешены всегда)',
  backendUrl: `адрес вида http://${LOOPBACK_HOST}:<порт>, без пути, логина и параметров`,
  token: 'от 32 до 512 видимых символов ASCII без пробелов',
  tokenMissing: 'не задан: без токена консоль не ходит в приложение',
  sameTokens:
    'LEADS_CONSOLE_TOKEN и WA_CONSOLE_TOKEN совпадают: у почты и бота должны быть разные токены',
  sameUrls: 'LEADS_API_URL и WA_API_URL совпадают: у почты и бота разные порты',
  selfUrl: 'адрес указывает на саму консоль (CONSOLE_PORT)',
  databasePath: 'путь должен вести внутрь папки data/ консоли',
  logLevel: `одно из: ${LOG_LEVELS.join(', ')}`,
  envProxy:
    'включён прокси Node для fetch (NODE_USE_ENV_PROXY или --use-env-proxy в NODE_OPTIONS): токены могли бы уйти через прокси, выключите его',
} as const;

/** Значение переменной без пробелов по краям; пустое значит «не задана». Регистр имени не важен (Windows). */
function read(env: EnvVars, name: string): string | undefined {
  const entry = Object.entries(env).find(([key]) => key.toUpperCase() === name);
  const value = entry?.[1]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_PORT;
}

/**
 * Включён ли прокси Node для fetch: NODE_USE_ENV_PROXY равна 1 или true, в NODE_OPTIONS есть --use-env-proxy или
 * node запущен с этим флагом (execArgv). Тогда fetch пошёл бы через HTTP_PROXY, и токены ушли бы с этой машины.
 */
export function isNodeEnvProxyOn(env: EnvVars, execArgv: readonly string[] = []): boolean {
  const all = (name: string): string[] =>
    Object.entries(env).flatMap(([key, value]) =>
      key.toUpperCase() === name && value !== undefined ? [value.trim()] : [],
    );
  return (
    all('NODE_USE_ENV_PROXY').some((value) => ENV_PROXY_ON.test(value)) ||
    all('NODE_OPTIONS').some((value) => USE_ENV_PROXY_FLAG.test(value)) ||
    execArgv.some((arg) => USE_ENV_PROXY_FLAG.test(arg))
  );
}

/** Адрес приложения в виде http://127.0.0.1:<порт>; неверный: null. */
export function parseBackendUrl(value: string): string | null {
  const match = BACKEND_URL.exec(value);
  const port = Number(match?.[1]);
  return match !== null && isPort(port) ? `http://${LOOPBACK_HOST}:${port}` : null;
}

function parseAllowedHosts(value: string | undefined): readonly string[] | null {
  if (value === undefined) return [];
  const items = value.split(',').map((item) => item.trim().toLowerCase());
  const valid = items.every((item) => {
    const match = HOST_NAME.exec(item);
    if (match === null) return false;
    const port = match[1];
    const name = item.split(':')[0] ?? '';
    return !LOCAL_NAMES.has(name) && (port === undefined || isPort(Number(port)));
  });
  return valid ? [...new Set(items)] : null;
}

/** Строго внутри dir: сама папка и выход через «..» не годятся. */
function isInsideDir(dir: string, target: string): boolean {
  const path = relative(dir, target);
  return path !== '' && !isAbsolute(path) && path.split(sep)[0] !== '..';
}

/** Путь к базе консоли от корня консоли, только внутри data/. Неверный: null. */
export function resolveDatabasePath(env: EnvVars, root: string): string | null {
  const fullPath = resolve(root, read(env, 'CONSOLE_DATABASE_PATH') ?? DEFAULTS.databasePath);
  return isInsideDir(resolve(root, DATA_DIR), fullPath) ? fullPath : null;
}

interface Collected<T> {
  readonly value: T;
  readonly problems: readonly string[];
}

function collectPort(env: EnvVars): Collected<number> {
  const raw = read(env, 'CONSOLE_PORT');
  if (raw === undefined) return { value: DEFAULTS.port, problems: [] };
  const port = UNSIGNED_INTEGER.test(raw) ? Number(raw) : NaN;
  return isPort(port)
    ? { value: port, problems: [] }
    : { value: DEFAULTS.port, problems: [`CONSOLE_PORT: ${PROBLEMS.port}`] };
}

function collectBackend(
  env: EnvVars,
  prefix: 'LEADS' | 'WA',
  fallbackUrl: string,
): Collected<BackendConfig> {
  const urlName = `${prefix}_API_URL`;
  const tokenName = `${prefix}_CONSOLE_TOKEN`;
  const baseUrl = parseBackendUrl(read(env, urlName) ?? fallbackUrl);
  const token = read(env, tokenName);
  const problems = [
    ...(baseUrl === null ? [`${urlName}: ${PROBLEMS.backendUrl}`] : []),
    ...(token === undefined ? [`${tokenName}: ${PROBLEMS.tokenMissing}`] : []),
    ...(token !== undefined && !CONSOLE_TOKEN_PATTERN.test(token)
      ? [`${tokenName}: ${PROBLEMS.token}`]
      : []),
  ];
  return { value: { baseUrl: baseUrl ?? fallbackUrl, token: token ?? '' }, problems };
}

function crossProblems(port: number, leads: BackendConfig, wa: BackendConfig): string[] {
  const own = `http://${LOOPBACK_HOST}:${port}`;
  return [
    ...(leads.token !== '' && leads.token === wa.token ? [PROBLEMS.sameTokens] : []),
    ...(leads.baseUrl === wa.baseUrl ? [PROBLEMS.sameUrls] : []),
    ...(leads.baseUrl === own ? [`LEADS_API_URL: ${PROBLEMS.selfUrl}`] : []),
    ...(wa.baseUrl === own ? [`WA_API_URL: ${PROBLEMS.selfUrl}`] : []),
  ];
}

function collectLogLevel(env: EnvVars): Collected<LogLevel> {
  const raw = read(env, 'LOG_LEVEL')?.toLowerCase();
  if (raw === undefined) return { value: DEFAULTS.logLevel, problems: [] };
  const level = LOG_LEVELS.find((item) => item === raw);
  return level === undefined
    ? { value: DEFAULTS.logLevel, problems: [`LOG_LEVEL: ${PROBLEMS.logLevel}`] }
    : { value: level, problems: [] };
}

/**
 * Собирает настройки консоли из окружения. Ошибки всех переменных собираются сразу в ConfigError: имя и причина,
 * без значения (в значениях токены). Отказ в запуске: токены не заданы, неверного вида или совпадают; адрес почты
 * или бота не http://127.0.0.1:<порт>; включён прокси Node для fetch; база вне data/.
 */
export function loadConfig(
  env: EnvVars,
  root: string,
  execArgv: readonly string[] = [],
): ConsoleConfig {
  const host = read(env, 'CONSOLE_HOST') ?? LOOPBACK_HOST;
  const port = collectPort(env);
  const allowedHosts = parseAllowedHosts(read(env, 'CONSOLE_ALLOWED_HOSTS'));
  const leads = collectBackend(env, 'LEADS', DEFAULTS.leadsUrl);
  const wa = collectBackend(env, 'WA', DEFAULTS.waUrl);
  const databasePath = resolveDatabasePath(env, root);
  const logLevel = collectLogLevel(env);
  const problems = [
    ...(host === LOOPBACK_HOST ? [] : [`CONSOLE_HOST: ${PROBLEMS.host}`]),
    ...port.problems,
    ...(allowedHosts === null ? [`CONSOLE_ALLOWED_HOSTS: ${PROBLEMS.allowedHosts}`] : []),
    ...leads.problems,
    ...wa.problems,
    ...crossProblems(port.value, leads.value, wa.value),
    ...(databasePath === null ? [`CONSOLE_DATABASE_PATH: ${PROBLEMS.databasePath}`] : []),
    ...logLevel.problems,
    ...(isNodeEnvProxyOn(env, execArgv) ? [PROBLEMS.envProxy] : []),
  ];
  if (problems.length > 0 || allowedHosts === null || databasePath === null) {
    throw new ConfigError(problems);
  }
  return {
    host,
    port: port.value,
    allowedHosts,
    leads: leads.value,
    wa: wa.value,
    databasePath,
    logLevel: logLevel.value,
  };
}
