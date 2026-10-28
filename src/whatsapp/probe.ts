import { stat } from 'node:fs/promises';
import {
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
  type ConnectionState,
  type UserFacingSocketConfig,
} from 'baileys';
import type { Clock, Logger, ProcessLock } from '../domain/ports.js';
import type { PhoneDigits } from '../domain/types.js';
import type { FetchedVersion, LoadedAuthState, WaSocket } from './connection-types.js';
import { TIMED_OUT, withDeadline } from './deadline.js';
import { phoneToJid } from './jid.js';
import { buildSocketConfig, fetchVersionWithTimeout } from './socket-config.js';

// Проба бизнес-профиля без привязки: один запуск по разрешению владельца. Подключается к WhatsApp по уже привязанной
// сессии, спрашивает бизнес-профиль одного номера и его LID и печатает только признаки (есть ли сайт, почта, категория),
// без номеров, JID и значений. QR не показывает, привязку не считает и не начинает, logout не вызывает.

/** Общий срок пробы: получение версии, подключение и оба запроса. */
export const PROBE_TIMEOUT_MS = 60_000;

/** Номер для пробы: только цифры, от 10 до 15 (с кодом страны, без плюса и пробелов). */
const PROBE_NUMBER = /^\d{10,15}$/;

/** Подсказка при неверном аргументе: точка входа печатает её до чтения .env, проба до замка. Номера в ней нет. */
export const PROBE_USAGE =
  'Нужен один аргумент: номер только из цифр, от 10 до 15 цифр, например: npm run probe:business -- 7XXXXXXXXXX';

const MS_PER_SECOND = 1000;

const MESSAGES = {
  botRunning: 'Бот запущен: остановите его перед пробой',
  noSession: 'Сессии нет, QR не запускаю',
  qr: 'WhatsApp запросил QR: проба прекращена',
  credsNotSaved:
    'Сессия WhatsApp не сохранилась на диск: проверьте свободное место и права на папку сессии, ' +
    'иначе при следующем запуске бота возможны сбои',
} as const;

/** Что значит код закрытия до открытия (DisconnectReason и код 405): короткая причина для владельца. */
const CLOSE_TEXTS: ReadonlyMap<number, string> = new Map([
  [401, 'сессия отозвана в телефоне, нужна новая привязка'],
  [403, 'сервер отказал в доступе, возможна блокировка номера'],
  [405, 'сервер отклонил версию клиента'],
  [408, 'истёк срок ожидания'],
  [428, 'соединение закрыто сервером WhatsApp'],
  [440, 'номер подключён в другом месте с этой же сессией'],
  [500, 'сбой сессии'],
  [503, 'сервер WhatsApp недоступен'],
  [515, 'WhatsApp требует перезапуск соединения'],
]);

/** Части сокета, которыми пользуется проба: чтение бизнес-профиля, сопоставление LID и закрытие. Ни отправки, ни logout. */
export type ProbeSocket = Pick<WaSocket, 'ev' | 'signalRepository' | 'end' | 'getBusinessProfile'>;

/** Куда проба пишет: stdout только JSON с итогом, stderr причины отказа и сбоев. */
export interface ProbeOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface ProbeDeps {
  /** WHATSAPP_SESSION_DIR: та же сессия, что у бота. Её не создают и не меняют, кроме обычного сохранения creds. */
  readonly sessionDir: string;
  /** Пишет только в stderr: stdout отдан под JSON. Номера, JID и значения полей в лог не идут. */
  readonly logger: Logger;
  readonly clock: Clock;
  /** Замок процесса бота (data/process.lock). null: замок занят, бот запущен. */
  readonly acquireLock: () => ProcessLock | null;
  readonly out: ProbeOutput;
  /** По умолчанию PROBE_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /** Швы для тестов: в рабочем режиме не передаются (makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion). */
  readonly createSocket?: (config: UserFacingSocketConfig) => ProbeSocket;
  readonly loadAuthState?: (folder: string) => Promise<LoadedAuthState>;
  readonly fetchVersion?: () => Promise<FetchedVersion>;
}

/** Признаки одного профиля: есть ли поле, без значений. website: сколько сайтов. */
export interface ProfileFlags {
  readonly business: boolean;
  readonly website: number;
  readonly email: boolean;
  readonly category: boolean;
  readonly description: boolean;
  readonly address: boolean;
}

/** Итог запроса: признаки или имя ошибки (status: код ответа WhatsApp, если он числовой). */
export type ProfileSummary = ProfileFlags | { readonly error: string; readonly status?: number };

/** То, что печатается в stdout: для номера и для LID отдельно. */
export interface ProbeReport {
  readonly number: ProfileSummary;
  readonly lid: ProfileSummary;
}

type ProbeResult =
  | { readonly kind: 'done'; readonly report: ProbeReport }
  | { readonly kind: 'qr' }
  | { readonly kind: 'closed'; readonly code: number | undefined };

/** Сессия пробы: итог, который не отклоняется, и закрытие. */
interface ProbeSession {
  readonly result: Promise<ProbeResult>;
  /** Закрывает сокет (end без logout), ждёт сохранения creds; true, если сессия сохранилась. Повтор безопасен. */
  close(): Promise<boolean>;
}

interface CredsSaver {
  save(): void;
  /** Ждёт всё запущенное; true, если ни одно сохранение не упало. */
  settled(): Promise<boolean>;
}

function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const output = (error as { readonly output?: { readonly statusCode?: unknown } }).output;
  return typeof output?.statusCode === 'number' ? output.statusCode : undefined;
}

/**
 * Номер из аргументов командной строки: ровно один аргумент из цифр, от 10 до 15. Другое: null.
 * Граница адаптера: здесь строка из командной строки становится PhoneDigits.
 */
export function parseProbeNumber(args: readonly string[]): PhoneDigits | null {
  const [value] = args;
  return args.length === 1 && value !== undefined && PROBE_NUMBER.test(value)
    ? (value as PhoneDigits)
    : null;
}

// Сессия WhatsApp.

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Сессия бота, если номер привязан (в creds есть me, как проверяет адаптер и служба tanbala.service); иначе null.
 * Папки нет: null без чтения, потому что useMultiFileAuthState создал бы пустую папку.
 */
async function linkedAuth(deps: ProbeDeps): Promise<LoadedAuthState | null> {
  if (!(await isDirectory(deps.sessionDir))) return null;
  const auth = await (deps.loadAuthState ?? useMultiFileAuthState)(deps.sessionDir);
  const id = auth.state.creds.me?.id;
  return typeof id === 'string' && id !== '' ? auth : null;
}

/** creds.update сохраняется по порядку своей цепочкой, как в адаптере; сбой пишется в лог и портит итог. */
function createCredsSaver(auth: LoadedAuthState, logger: Logger): CredsSaver {
  let chain: Promise<void> = Promise.resolve();
  let failed = false;
  return {
    save: () => {
      chain = chain.then(async () => {
        try {
          await auth.saveCreds();
        } catch (error: unknown) {
          failed = true;
          logger.error({ errorName: errorNameOf(error) }, 'Не удалось сохранить сессию WhatsApp');
        }
      });
    },
    settled: async () => {
      await chain;
      return !failed;
    },
  };
}

// Запросы профиля.

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function websiteCount(value: unknown): number {
  return Array.isArray(value) ? (value as readonly unknown[]).filter(hasText).length : 0;
}

/** Признаки ответа getBusinessProfile: нет профиля (обычный аккаунт) business false и нули. */
function flagsOf(raw: unknown): ProfileSummary {
  if (raw === undefined || raw === null) {
    return {
      business: false,
      website: 0,
      email: false,
      category: false,
      description: false,
      address: false,
    };
  }
  if (typeof raw !== 'object') return { error: 'UnexpectedResponse' };
  const profile = raw as Readonly<Record<string, unknown>>;
  return {
    business: true,
    website: websiteCount(profile['website']),
    email: hasText(profile['email']),
    category: hasText(profile['category']),
    description: hasText(profile['description']),
    address: hasText(profile['address']),
  };
}

function failureOf(error: unknown): ProfileSummary {
  const status = statusOf(error);
  return status === undefined
    ? { error: errorNameOf(error) }
    : { error: errorNameOf(error), status };
}

async function summarize(query: () => Promise<unknown>): Promise<ProfileSummary> {
  try {
    return flagsOf(await query());
  } catch (error: unknown) {
    return failureOf(error);
  }
}

async function lidSummary(sock: ProbeSocket, pnJid: string): Promise<ProfileSummary> {
  let lidJid: string | null;
  try {
    lidJid = await sock.signalRepository.lidMapping.getLIDForPN(pnJid);
  } catch (error: unknown) {
    return failureOf(error);
  }
  if (lidJid === null) return { error: 'LID неизвестен' };
  return summarize(() => sock.getBusinessProfile(lidJid));
}

/** Два запроса по очереди: по номеру, затем по LID (если WhatsApp его сообщил). */
async function queryProfiles(sock: ProbeSocket, phone: PhoneDigits): Promise<ProbeReport> {
  const pnJid = phoneToJid(phone);
  const number = await summarize(() => sock.getBusinessProfile(pnJid));
  return { number, lid: await lidSummary(sock, pnJid) };
}

// Подключение.

function closeCode(update: Partial<ConnectionState>): number | undefined {
  return statusOf(update.lastDisconnect?.error);
}

/** Решающее событие подключения: qr, open или close; прочие обновления (receivedPendingNotifications и т.п.): null. */
type Turn = { readonly kind: 'open' } | Exclude<ProbeResult, { readonly kind: 'done' }>;

function turnOf(update: Partial<ConnectionState>): Turn | null {
  if (typeof update.qr === 'string' && update.qr !== '') return { kind: 'qr' };
  if (update.connection === 'open') return { kind: 'open' };
  if (update.connection === 'close') return { kind: 'closed', code: closeCode(update) };
  return null;
}

/**
 * Слушает события одного сокета до решающего: qr (прекратить), open (два запроса), close до open (прекратить).
 * Решает первое из них, остальные пачки и события (сообщения, история) не разбираются. creds.update сохраняется
 * всегда, и после решения.
 */
function converse(sock: ProbeSocket, phone: PhoneDigits, creds: CredsSaver): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    let decided = false;
    sock.ev.process((events) => {
      if (events['creds.update'] !== undefined) creds.save();
      const update = events['connection.update'];
      const turn = update === undefined || decided ? null : turnOf(update);
      if (turn === null) return;
      decided = true;
      // Запросы сами ловят свои сбои; если что-то всё же упадёт, отказ уйдёт в итог и runBusinessProbe его разберёт.
      resolve(
        turn.kind === 'open'
          ? queryProfiles(sock, phone).then((report): ProbeResult => ({ kind: 'done', report }))
          : turn,
      );
    });
  });
}

async function endSocket(sock: ProbeSocket, logger: Logger): Promise<void> {
  try {
    await sock.end(undefined);
  } catch (error: unknown) {
    logger.warn({ errorName: errorNameOf(error) }, 'Сокет WhatsApp не закрылся');
  }
}

/**
 * Версия WhatsApp Web, сокет с настройками бота (buildSocketConfig: не онлайн при подключении, без полной истории,
 * сессия из папки) и ожидание решающего события. Всё внутри общего срока: close() вызывается и после срока, а сокет,
 * который ещё не создан, уже не создаётся.
 */
function openProbeSession(
  deps: ProbeDeps,
  auth: LoadedAuthState,
  phone: PhoneDigits,
): ProbeSession {
  const creds = createCredsSaver(auth, deps.logger);
  let sock: ProbeSocket | null = null;
  let closing = false;
  const result = (async (): Promise<ProbeResult> => {
    const version = await fetchVersionWithTimeout(
      deps.fetchVersion ?? fetchLatestBaileysVersion,
      deps,
    );
    if (closing) return { kind: 'closed', code: undefined };
    const config = buildSocketConfig({
      state: auth.state,
      version,
      deps: { logger: deps.logger, getSentText: () => Promise.resolve(null) },
    });
    sock = (deps.createSocket ?? makeWASocket)(config);
    return converse(sock, phone, creds);
  })();
  let closed: Promise<boolean> | null = null;
  const shutdown = async (): Promise<boolean> => {
    closing = true;
    if (sock !== null) await endSocket(sock, deps.logger);
    return creds.settled();
  };
  return { result, close: () => (closed ??= shutdown()) };
}

// Итог.

function fail(deps: ProbeDeps, message: string): number {
  deps.out.stderr(`${message}\n`);
  return 1;
}

function closedMessage(code: number | undefined): string {
  const head = 'Соединение с WhatsApp закрыто до открытия';
  if (code === undefined) return `${head}: проба прекращена`;
  const text = CLOSE_TEXTS.get(code);
  const reason = text === undefined ? `код ${String(code)}` : `${text} (код ${String(code)})`;
  return `${head}: ${reason}. Проба прекращена`;
}

function timeoutMessage(timeoutMs: number): string {
  const seconds = String(timeoutMs / MS_PER_SECOND);
  return `Проба не уложилась в ${seconds} с: соединение закрыто, результата нет`;
}

/** Печать итога и код выхода: 0 только при удачной пробе и сохранённой сессии. */
function finish(
  deps: ProbeDeps,
  outcome: ProbeResult | typeof TIMED_OUT,
  credsSaved: boolean,
): number {
  if (outcome === TIMED_OUT) return fail(deps, timeoutMessage(timeoutOf(deps)));
  switch (outcome.kind) {
    case 'qr':
      return fail(deps, MESSAGES.qr);
    case 'closed':
      return fail(deps, closedMessage(outcome.code));
    case 'done':
      deps.out.stdout(`${JSON.stringify(outcome.report)}\n`);
      return credsSaved ? 0 : fail(deps, MESSAGES.credsNotSaved);
  }
}

async function runLocked(phone: PhoneDigits, deps: ProbeDeps): Promise<number> {
  const auth = await linkedAuth(deps);
  if (auth === null) return fail(deps, MESSAGES.noSession);
  const session = openProbeSession(deps, auth, phone);
  try {
    const outcome = await withDeadline(deps.clock, timeoutOf(deps), () => session.result);
    return finish(deps, outcome, await session.close());
  } finally {
    await session.close();
  }
}

function timeoutOf(deps: ProbeDeps): number {
  return deps.timeoutMs ?? PROBE_TIMEOUT_MS;
}

/**
 * Проба бизнес-профиля. Порядок: номер из аргумента (неверный: выход 1 до любых действий), замок процесса бота
 * (занят: выход 1), проверка, что сессия привязана (нет: выход 1, QR не запускается), сокет с настройками бота без
 * обработчиков сообщений и с сохранением creds. qr или закрытие до open: выход 1 без повторов и переподключений.
 * open: getBusinessProfile по номеру, затем по LID из lidMapping.getLIDForPN (если WhatsApp его знает). Потом end без
 * logout, ожидание сохранения creds и снятие замка. Общий срок 60 с. В stdout одна строка JSON (признаки полей, без
 * номера, JID и значений), в stderr причины. Привязку по QR не считает и не начинает. Возвращает код выхода.
 */
export async function runBusinessProbe(args: readonly string[], deps: ProbeDeps): Promise<number> {
  const phone = parseProbeNumber(args);
  if (phone === null) return fail(deps, PROBE_USAGE);
  try {
    const lock = deps.acquireLock();
    if (lock === null) return fail(deps, MESSAGES.botRunning);
    try {
      return await runLocked(phone, deps);
    } finally {
      lock.release();
    }
  } catch (error: unknown) {
    // Текст ошибки не печатается: в нём бывают номера и пути.
    return fail(deps, `Проба остановлена из-за ошибки ${errorNameOf(error)}`);
  }
}
