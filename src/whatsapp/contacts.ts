import type {
  BusinessProfileResult,
  Clock,
  ImageInput,
  Logger,
  WhatsAppContacts,
} from '../domain/ports.js';
import type { Jid } from '../domain/types.js';
import { readLimitedBytes } from '../shared/read-limited.js';
import { cleanUntrusted, INVISIBLE } from '../shared/untrusted-text.js';
import type { WaSocket } from './connection-types.js';
import { TIMED_OUT, withDeadline } from './deadline.js';

// Профиль собеседника для определения компании (шаги а и д): бизнес-профиль и фото. Только запросы на чтение:
// из сокета берутся только getBusinessProfile и profilePictureUrl, ничего не отправляется.

/** Сколько ждать бизнес-профиль у WhatsApp. */
export const BUSINESS_PROFILE_TIMEOUT_MS = 10_000;
/** Срок ожидания адреса фото: передаётся в сам запрос WhatsApp. */
export const PHOTO_URL_TIMEOUT_MS = 10_000;
/** Сколько качать фото с сервера WhatsApp целиком (запрос и тело). */
export const PHOTO_DOWNLOAD_TIMEOUT_MS = 10_000;

/** Сайтов из бизнес-профиля не больше пяти, каждый до 300 символов; почта до 200. */
export const MAX_WEBSITES = 5;
export const MAX_WEBSITE_CHARS = 300;
export const MAX_EMAIL_CHARS = 200;

/** Фото отдаёт только сервер WhatsApp: хост на этом суффиксе, схема https. */
const PHOTO_HOST_SUFFIX = '.whatsapp.net';

const PHOTO_TYPES: readonly ImageInput['mimeType'][] = ['image/jpeg', 'image/png', 'image/webp'];

/** Части сокета, которыми пользуется модуль: только чтение профиля. */
export type ContactsSocket = Pick<WaSocket, 'getBusinessProfile' | 'profilePictureUrl'>;

/** fetch для скачивания фото. В тестах подменяется. */
export type ProfileFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ContactsDeps {
  /**
   * Сокет для запроса про этот адрес. null: нет подключения или адрес не прошёл проверку (личный чат, закрытый
   * режим): тогда запросов нет. Проверку делает адаптер подключения (whatsapp/connection.ts).
   */
  readonly socketFor: (jid: Jid) => Promise<ContactsSocket | null>;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Для тестов. По умолчанию глобальный fetch на момент вызова. */
  readonly fetch?: ProfileFetch;
}

/** Почему фото не получено (для лога, без адреса). */
type PhotoFailure =
  | { readonly reason: 'http_status'; readonly status: number }
  | {
      readonly reason: 'url_rejected' | 'timeout' | 'content_type' | 'too_large' | 'empty';
    };

type PhotoOutcome =
  | { readonly ok: true; readonly image: ImageInput }
  | { readonly ok: false; readonly failure: PhotoFailure };

const FAILED: BusinessProfileResult = { kind: 'failed' };

function rejected(failure: PhotoFailure): PhotoOutcome {
  return { ok: false, failure };
}

/** Для лога: класс ошибки без текста (в тексте бывают адреса и номера). */
function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Код ответа WhatsApp из ошибки Boom (output.statusCode): 401 not-authorized, 404 item-not-found. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const output = (error as { readonly output?: { readonly statusCode?: unknown } }).output;
  return typeof output?.statusCode === 'number' ? output.statusCode : undefined;
}

// Бизнес-профиль.

function textOrNull(raw: unknown, maxChars: number): string | null {
  return cleanUntrusted(typeof raw === 'string' ? raw : null, INVISIBLE, maxChars);
}

function websitesOf(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return (raw as readonly unknown[])
    .flatMap((item) => textOrNull(item, MAX_WEBSITE_CHARS) ?? [])
    .slice(0, MAX_WEBSITES);
}

/** Ответ getBusinessProfile: нет профиля (обычный аккаунт) personal, объект business, всё остальное failed. */
function toBusinessProfile(raw: unknown): BusinessProfileResult {
  if (raw === undefined || raw === null) return { kind: 'personal' };
  if (typeof raw !== 'object') return FAILED;
  const { website, email } = raw as { readonly website?: unknown; readonly email?: unknown };
  return {
    kind: 'business',
    websites: websitesOf(website),
    email: textOrNull(email, MAX_EMAIL_CHARS),
  };
}

async function fetchBusinessProfile(deps: ContactsDeps, jid: Jid): Promise<BusinessProfileResult> {
  const { clock, logger } = deps;
  try {
    const sock = await deps.socketFor(jid);
    if (sock === null) {
      logger.debug(
        {},
        'Бизнес-профиль WhatsApp не запрошен: нет подключения или адрес не разрешён',
      );
      return FAILED;
    }
    const raw = await withDeadline(clock, BUSINESS_PROFILE_TIMEOUT_MS, () =>
      sock.getBusinessProfile(jid),
    );
    if (raw === TIMED_OUT) {
      logger.warn({ errorName: 'TimeoutError' }, 'Бизнес-профиль WhatsApp не получен вовремя');
      return FAILED;
    }
    return toBusinessProfile(raw);
  } catch (error: unknown) {
    logger.warn({ errorName: errorNameOf(error) }, 'Бизнес-профиль WhatsApp не получен');
    return FAILED;
  }
}

// Фото профиля.

/** Адрес фото от WhatsApp: только https на поддомене .whatsapp.net, без логина, пароля и порта. */
function photoUrlOf(raw: string): URL | null {
  try {
    const url = new URL(raw);
    const allowed =
      url.protocol === 'https:' &&
      url.hostname.endsWith(PHOTO_HOST_SUFFIX) &&
      url.username === '' &&
      url.password === '' &&
      url.port === '';
    return allowed ? url : null;
  } catch {
    return null;
  }
}

function mimeTypeOf(header: string | null): ImageInput['mimeType'] | null {
  const type = header?.split(';')[0]?.trim().toLowerCase();
  return PHOTO_TYPES.find((candidate) => candidate === type) ?? null;
}

function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

/** Качает фото: только 200, только jpeg, png или webp, не больше maxBytes; редиректы не выполняются. */
async function downloadPhoto(
  fetchPhoto: ProfileFetch,
  url: URL,
  maxBytes: number,
  signal: AbortSignal,
): Promise<PhotoOutcome> {
  const response = await fetchPhoto(url.href, { signal, redirect: 'error' });
  if (response.status !== 200) {
    discard(response);
    return rejected({ reason: 'http_status', status: response.status });
  }
  const mimeType = mimeTypeOf(response.headers.get('content-type'));
  if (mimeType === null) {
    discard(response);
    return rejected({ reason: 'content_type' });
  }
  const data = await readLimitedBytes(response, maxBytes, signal);
  if (data === null) return rejected({ reason: 'too_large' });
  if (data.byteLength === 0) return rejected({ reason: 'empty' });
  return { ok: true, image: { data, mimeType } };
}

async function downloadFrom(
  deps: ContactsDeps,
  address: string,
  maxBytes: number,
): Promise<PhotoOutcome> {
  const url = photoUrlOf(address);
  if (url === null) return rejected({ reason: 'url_rejected' });
  const fetchPhoto: ProfileFetch = deps.fetch ?? ((target, init) => fetch(target, init));
  const outcome = await withDeadline(deps.clock, PHOTO_DOWNLOAD_TIMEOUT_MS, (signal) =>
    downloadPhoto(fetchPhoto, url, maxBytes, signal),
  );
  return outcome === TIMED_OUT ? rejected({ reason: 'timeout' }) : outcome;
}

function logPhotoFailure(logger: Logger, failure: PhotoFailure): void {
  const context =
    failure.reason === 'http_status'
      ? { reason: failure.reason, status: failure.status }
      : { reason: failure.reason };
  // Слишком большое фото: заданный вызывающим предел, не сбой.
  logger[failure.reason === 'too_large' ? 'info' : 'warn'](
    context,
    'Фото профиля WhatsApp не получено',
  );
}

/** Сбой запроса адреса или скачивания: 401 и 404 от WhatsApp значат «фото нет или оно скрыто», это не авария. */
function logPhotoError(logger: Logger, error: unknown): void {
  const status = statusOf(error);
  if (status === 401 || status === 404) {
    logger.info({ status }, 'Фото профиля WhatsApp недоступно: его нет или оно скрыто');
    return;
  }
  const errorName = errorNameOf(error);
  logger.warn(
    status === undefined ? { errorName } : { errorName, status },
    'Фото профиля WhatsApp не получено',
  );
}

async function fetchProfilePhoto(
  deps: ContactsDeps,
  jid: Jid,
  maxBytes: number,
): Promise<ImageInput | null> {
  const { logger } = deps;
  try {
    const sock = await deps.socketFor(jid);
    if (sock === null) {
      logger.debug({}, 'Фото профиля WhatsApp не запрошено: нет подключения или адрес не разрешён');
      return null;
    }
    const address = await sock.profilePictureUrl(jid, 'image', PHOTO_URL_TIMEOUT_MS);
    if (typeof address !== 'string') {
      logger.debug({}, 'Фото профиля WhatsApp: фото нет');
      return null;
    }
    const outcome = await downloadFrom(deps, address, maxBytes);
    if (outcome.ok) return outcome.image;
    logPhotoFailure(logger, outcome.failure);
    return null;
  } catch (error: unknown) {
    logPhotoError(logger, error);
    return null;
  }
}

/**
 * Профиль собеседника в WhatsApp (порт WhatsAppContacts). Ничего не бросает: сбой приходит значением и пишется в лог
 * без адреса, номера и данных профиля (только имя ошибки, статус и причина).
 * businessProfile: нет сокета => failed; getBusinessProfile не дольше 10 с; undefined => personal; объект =>
 * business с сайтами (строки, очищены как недоверенные, до 5 штук по 300 символов) и почтой (до 200 символов или
 * null); исключение, не объект и таймаут => failed.
 * profilePhoto: profilePictureUrl(jid, 'image', 10000); нет адреса => null; адрес только https на поддомене
 * .whatsapp.net (иначе null: адрес приходит от WhatsApp, но проверка не лишняя); скачивание не дольше 10 с без
 * редиректов, только статус 200 и тип image/jpeg, image/png или image/webp, не больше maxBytes (поток обрывается);
 * любые сбои, в том числе 401 not-authorized и 404 item-not-found от WhatsApp (фото скрыто или его нет), дают null.
 */
export function createWhatsAppContacts(deps: ContactsDeps): WhatsAppContacts {
  return {
    businessProfile: (jid) => fetchBusinessProfile(deps, jid),
    profilePhoto: (jid, maxBytes) => fetchProfilePhoto(deps, jid, maxBytes),
  };
}
