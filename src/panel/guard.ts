import { createHash, timingSafeEqual } from 'node:crypto';
import { ConfigError } from '../config/errors.js';

/** Единственный адрес, который панель слушает на ПК. */
const LOOPBACK_HOST = '127.0.0.1';
/** Имена, под которыми браузер владельца открывает локальную панель. */
const LOCAL_HOST_NAMES: readonly string[] = [LOOPBACK_HOST, 'localhost'];
/** Решение владельца: не короче 16 символов (admin и пустой пароль короче, поэтому тоже слабые). */
const MIN_STRONG_PASSWORD_LENGTH = 16;
/** Порт HTTP по умолчанию: браузер шлёт Host без него. */
const HTTP_DEFAULT_PORT = 80;

/** Что panel/guard знает о запросе, чтобы решить, чей это заголовок Host. */
interface HostCheckInput {
  /** Заголовок Host запроса как пришёл; нет заголовка => отказ. */
  readonly hostHeader: string | undefined;
  /** PANEL_PORT: локальные имена принимаются только с ним. */
  readonly port: number;
  readonly password: string;
  /**
   * Домены панели за Caddy на VPS, точно как их шлёт браузер в Host (с портом, если он не 443).
   * Действуют только при сильном пароле.
   */
  readonly allowedHosts?: readonly string[];
}

/**
 * Можно ли слушать этот адрес на ПК: только литерал 127.0.0.1, как в плане.
 * ::1, localhost, 0.0.0.0 и :: считаются чужими. Точное сравнение строк, без DNS.
 */
export function isLoopback(host: string): boolean {
  return host === LOOPBACK_HOST;
}

/**
 * Слабый ли пароль панели: admin (без учёта регистра и пробелов по краям), пустой или короче 16 символов.
 * Длина считается без пробелов по краям, поэтому «admin» с пробелами и строка из пробелов тоже слабые.
 */
export function isWeakPassword(password: string): boolean {
  return password.trim().length < MIN_STRONG_PASSWORD_LENGTH;
}

/**
 * Правило плана: пока проект на ПК, панель слушает только 127.0.0.1. Со слабым паролем (isWeakPassword)
 * разрешён только 127.0.0.1; на любом другом адресе (VPS) пароль не короче 16 символов, иначе отказ в запуске
 * (решение владельца, подтверждено 25.10.2026). Бросает ConfigError без значения пароля, если запуск запрещён.
 */
export function assertPanelStartAllowed(input: { host: string; password: string }): void {
  if (isLoopback(input.host) || !isWeakPassword(input.password)) return;
  throw new ConfigError([
    `PANEL_HOST: панель не запускается на адресе, отличном от ${LOOPBACK_HOST}, пока ADMIN_PASSWORD слабый ` +
      `(admin, пустой или короче ${MIN_STRONG_PASSWORD_LENGTH} символов): ` +
      `задайте ADMIN_PASSWORD не короче ${MIN_STRONG_PASSWORD_LENGTH} символов или верните PANEL_HOST=${LOOPBACK_HOST}`,
  ]);
}

/**
 * Проверка заголовка Host на каждом запросе: защита от DNS rebinding и от входа с паролем admin за Caddy.
 * Слабый пароль: принимаются только «127.0.0.1:PORT» и «localhost:PORT» (за Caddy на VPS Host будет доменом,
 * и вход не откроется). Сильный пароль: плюс домены из allowedHosts. Нет заголовка => отказ. Регистр не важен.
 */
export function hostHeaderAllowed(input: HostCheckInput): boolean {
  const host = input.hostHeader?.toLowerCase();
  if (host === undefined || host === '') return false;
  return allowedHostsOf(input).has(host);
}

function allowedHostsOf(input: HostCheckInput): ReadonlySet<string> {
  const local = LOCAL_HOST_NAMES.flatMap((name) =>
    input.port === HTTP_DEFAULT_PORT ? [`${name}:${input.port}`, name] : [`${name}:${input.port}`],
  );
  if (isWeakPassword(input.password)) return new Set(local);
  const domains = (input.allowedHosts ?? []).map((host) => host.trim().toLowerCase());
  return new Set([...local, ...domains.filter((host) => host !== '')]);
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Равенство секретов за постоянное время: timingSafeEqual по SHA-256 от обоих значений, поэтому длина
 * не утекает по времени ответа и строки разной длины не бросают исключение.
 */
export function constantTimeEqual(first: string, second: string): boolean {
  return timingSafeEqual(sha256(first), sha256(second));
}

/** Сравнение введённого пароля с ADMIN_PASSWORD за постоянное время. */
export function passwordMatches(input: string, expected: string): boolean {
  return constantTimeEqual(input, expected);
}
