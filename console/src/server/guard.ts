import { createHash, timingSafeEqual } from 'node:crypto';

/** Адреса сокета, с которых консоль принимает соединения: этот же сервер (Caddy) или ПК. */
const LOOPBACK_PEERS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_NAMES: readonly string[] = ['127.0.0.1', 'localhost'];

/** Соединение с этой же машины: по адресу сокета, а не по X-Forwarded-For. */
export function isLoopbackPeer(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_PEERS.has(address.toLowerCase());
}

export interface HostRules {
  /** Все разрешённые значения Host: домены консоли и локальные имена с портом. */
  readonly allowed: ReadonlySet<string>;
  /** Локальные значения Host: по ним можно ходить по HTTP (ПК, health.sh). */
  readonly local: ReadonlySet<string>;
}

export function hostRules(port: number, domains: readonly string[]): HostRules {
  const local = new Set(LOCAL_NAMES.map((name) => `${name}:${port}`));
  return { local, allowed: new Set([...local, ...domains.map((domain) => domain.toLowerCase())]) };
}

export function normalizedHost(header: string | undefined): string | null {
  const host = header?.trim().toLowerCase();
  return host === undefined || host === '' ? null : host;
}

/**
 * Пришёл ли изменяющий запрос с нашей же страницы: Origin обязателен и равен «протокол://Host».
 * 'null', чужой сайт, другой протокол или порт не проходят.
 */
export function originMatches(origin: string | undefined, protocol: string, host: string): boolean {
  return origin !== undefined && origin.toLowerCase() === `${protocol}://${host}`;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Равенство секретов за постоянное время (по SHA-256, длина не утекает). */
export function constantTimeEqual(first: string, second: string): boolean {
  return timingSafeEqual(sha256(first), sha256(second));
}

/** Тип тела application/json (параметры вроде charset допускаются). */
export function isJsonContentType(header: string | undefined): boolean {
  const media = header?.split(';')[0]?.trim().toLowerCase();
  return media === 'application/json';
}
