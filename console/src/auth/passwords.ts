import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/** Параметры scrypt. N — степень двойки. */
export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** Рабочие параметры: около 32 МиБ и 50–100 мс на проверку. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };

const KEY_LENGTH = 64;
const SALT_BYTES = 16;
/** Явный предел памяти: при N=2^15 стандартных 32 МиБ OpenSSL не хватает. */
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;
const PREFIX = 'scrypt';
/** Границы параметров из базы: испорченная строка не должна заставить считать часами. */
const MIN_N = 2 ** 10;
const MAX_N = 2 ** 16;
const MAX_R = 16;
const MAX_P = 4;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface PasswordHasher {
  /** Хэш вида scrypt$N$r$p$соль$хэш (соль и хэш в base64url). */
  hash(password: string): Promise<string>;
  /** Совпадает ли пароль с хэшем; испорченный хэш: false. */
  verify(password: string, stored: string): Promise<boolean>;
  /**
   * Тот же расчёт для несуществующего имени: по времени ответа нельзя узнать, есть ли такое имя. Всегда false.
   */
  verifyDummy(password: string): Promise<false>;
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAX_MEMORY_BYTES,
  };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, KEY_LENGTH, options, (error, key) => {
      if (error === null) resolve(key);
      else reject(error);
    });
  });
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

interface ParsedHash {
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parseIntStrict(value: string | undefined): number {
  return value !== undefined && /^\d{1,7}$/.test(value) ? Number(value) : NaN;
}

/** Разбирает хэш из базы; неверный вид или параметры вне границ: null. */
export function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;
  const [N, r, p] = [parseIntStrict(parts[1]), parseIntStrict(parts[2]), parseIntStrict(parts[3])];
  const [salt, key] = [parts[4] ?? '', parts[5] ?? ''];
  const paramsValid =
    isPowerOfTwo(N) && N >= MIN_N && N <= MAX_N && r >= 1 && r <= MAX_R && p >= 1 && p <= MAX_P;
  if (!paramsValid || !BASE64URL.test(salt) || !BASE64URL.test(key)) return null;
  const keyBytes = Buffer.from(key, 'base64url');
  if (keyBytes.length !== KEY_LENGTH) return null;
  return { params: { N, r, p }, salt: Buffer.from(salt, 'base64url'), key: keyBytes };
}

function formatHash(params: ScryptParams, salt: Buffer, key: Buffer): string {
  return [
    PREFIX,
    params.N,
    params.r,
    params.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/**
 * scrypt из node:crypto, только асинхронно (событийный цикл не стоит во время расчёта). Сравнение за постоянное
 * время. Параметры проверки берутся из самого хэша, поэтому смена параметров не ломает старые пароли.
 */
export function createScryptHasher(params: ScryptParams = DEFAULT_SCRYPT): PasswordHasher {
  const dummy: ParsedHash = {
    params,
    salt: Buffer.alloc(SALT_BYTES),
    key: Buffer.alloc(KEY_LENGTH),
  };
  const check = async (password: string, parsed: ParsedHash): Promise<boolean> => {
    try {
      const key = await derive(password, parsed.salt, parsed.params);
      return timingSafeEqual(key, parsed.key);
    } catch {
      return false;
    }
  };
  return {
    async hash(password) {
      const salt = randomBytes(SALT_BYTES);
      return formatHash(params, salt, await derive(password, salt, params));
    },
    async verify(password, stored) {
      const parsed = parseHash(stored);
      return parsed === null ? false : check(password, parsed);
    },
    async verifyDummy(password) {
      await check(password, dummy);
      return false;
    },
  };
}
