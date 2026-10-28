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
import { trackAuthWrites, type ProbeAuthWrites } from './probe-auth.js';
import {
  createProbeChats,
  type ProbeChats,
  type ProbeChatsSummary,
  type ProbeChatStore,
} from './probe-chats.js';
import { queryProfiles, statusOf, type ProfileReport } from './probe-profile.js';
import { buildSocketConfig, fetchVersionWithTimeout } from './socket-config.js';

// Проба бизнес-профиля без привязки: один запуск по разрешению владельца. Подключается к WhatsApp по уже привязанной
// сессии, спрашивает бизнес-профиль одного номера и его LID и печатает только признаки (есть ли сайт, почта, категория),
// без номеров, JID и значений. QR не показывает, привязку не считает и не начинает, logout не вызывает.
// Сессия та же, что у бота: офлайн-очередь сообщений достаётся пробе, а не боту. Чаты из неё проба пишет в known_chats
// (whatsapp/probe-chats.ts), а число сообщений сообщает владельцу. Поэтому запускать в тихое время, сразу после
// остановки бота, и сразу после пробы снова запускать бота.

/** Общий срок пробы: получение версии, подключение и оба запроса. */
export const PROBE_TIMEOUT_MS = 60_000;

/** Срок закрытия после пробы: выдача накопленных событий, end, запись сессии и чатов. Дальше выход без ожидания. */
export const PROBE_CLOSE_TIMEOUT_MS = 20_000;

/** Номер для пробы: только цифры, от 10 до 15 (с кодом страны, без плюса и пробелов). */
const PROBE_NUMBER = /^\d{10,15}$/;

/** Подсказка при неверном аргументе: точка входа печатает её до чтения .env, проба до замка. Номера в ней нет. */
export const PROBE_USAGE =
  'Нужен один аргумент: номер только из цифр, от 10 до 15 цифр, например: npm run probe:business -- 7XXXXXXXXXX. ' +
  'Запускайте в тихое время сразу после остановки бота и сразу после пробы снова запустите бота: ' +
  'сообщения, которые придут пробе, бот уже не получит';

const MS_PER_SECOND = 1000;

const MESSAGES = {
  botRunning: 'Бот запущен: остановите его перед пробой',
  noSession: 'Сессии нет, QR не запускаю',
  noDatabase: 'База бота не найдена: проба не подключается, иначе чаты не попадут в known_chats',
  databaseFailed: 'База бота не открылась: проба не подключается',
  qr: 'WhatsApp запросил QR: проба прекращена',
  credsNotSaved:
    'Сессия WhatsApp не сохранилась на диск: проверьте свободное место и права на папку сессии, ' +
    'иначе при следующем запуске бота возможны сбои',
  chatsIncomplete:
    'Не все чаты из пробы записаны в known_chats: перед этапом 8 сверьте чаты с перепиской в телефоне',
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

/**
 * Части сокета, которыми пользуется проба: события, чтение бизнес-профиля, сопоставление LID, свой номер и закрытие.
 * Ни отправки, ни logout.
 */
export type ProbeSocket = Pick<
  WaSocket,
  'ev' | 'signalRepository' | 'end' | 'getBusinessProfile' | 'user'
>;

/** Куда проба пишет: stdout только JSON с итогом, stderr причины отказа и сбоев. */
export interface ProbeOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface ProbeDeps {
  /** WHATSAPP_SESSION_DIR: та же сессия, что у бота. Её не создают и не меняют, кроме обычного сохранения сессии. */
  readonly sessionDir: string;
  /** Пишет только в stderr: stdout отдан под JSON. Номера, JID и значения полей в лог не идут. */
  readonly logger: Logger;
  readonly clock: Clock;
  /** Замок процесса бота (data/process.lock). null: замок занят, бот запущен. */
  readonly acquireLock: () => ProcessLock | null;
  /**
   * База бота для known_chats; вызывается под замком, после проверки сессии и до подключения. null: базы нет.
   * Исключение: база не открылась. В обоих случаях проба к WhatsApp не подключается.
   */
  readonly openChatStore: () => ProbeChatStore | null;
  readonly out: ProbeOutput;
  /** По умолчанию PROBE_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /** Швы для тестов: в рабочем режиме не передаются (makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion). */
  readonly createSocket?: (config: UserFacingSocketConfig) => ProbeSocket;
  readonly loadAuthState?: (folder: string) => Promise<LoadedAuthState>;
  readonly fetchVersion?: () => Promise<FetchedVersion>;
}

/**
 * То, что печатается в stdout: для номера и для LID отдельно и сколько сообщений личных чатов пришло пробе
 * (бот их уже не получит).
 */
export interface ProbeReport extends ProfileReport {
  readonly receivedMessages: number;
}

type ProbeResult =
  | { readonly kind: 'done'; readonly profiles: ProfileReport }
  | { readonly kind: 'qr' }
  | { readonly kind: 'closed'; readonly code: number | undefined };

/** Итог закрытия: записи сессии (saved: все удались; timedOut: не закончились за срок закрытия) и чаты. */
interface ProbeClosing {
  readonly saved: boolean;
  readonly timedOut: boolean;
  readonly chats: ProbeChatsSummary;
}

/** Сессия пробы: итог, который не отклоняется, и закрытие. */
interface ProbeSession {
  readonly result: Promise<ProbeResult>;
  /** Закрывает сокет (end без logout) и ждёт записи сессии и чатов в пределах срока. Повтор безопасен. */
  close(): Promise<ProbeClosing>;
}

/** Сокет и запись его чатов: появляются вместе. */
interface ProbeLink {
  readonly sock: ProbeSocket;
  readonly chats: ProbeChats;
}

const NO_CHATS: ProbeChatsSummary = { messages: 0, complete: true };

function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
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

// Сессия WhatsApp и база.

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

/** База для known_chats или причина отказа для stderr (текст ошибки не печатается: в нём бывают пути). */
function openStore(deps: ProbeDeps): ProbeChatStore | string {
  try {
    return deps.openChatStore() ?? MESSAGES.noDatabase;
  } catch (error: unknown) {
    return `${MESSAGES.databaseFailed} (ошибка ${errorNameOf(error)})`;
  }
}

function closeStore(store: ProbeChatStore, logger: Logger): void {
  try {
    store.close();
  } catch (error: unknown) {
    logger.warn({ errorName: errorNameOf(error) }, 'База бота не закрылась');
  }
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

/** Выдаёт накопленные Baileys события обработчику: end() и закрытие стирают буфер без выдачи (как у бота). */
function flushEvents(sock: ProbeSocket, logger: Logger): void {
  try {
    sock.ev.flush();
  } catch (error: unknown) {
    logger.error({ errorName: errorNameOf(error) }, 'Накопленные события WhatsApp не выданы');
  }
}

/**
 * Слушает события одного сокета до решающего: qr (прекратить), open (два запроса), close до open (прекратить).
 * Решает первое из них. Всегда, и после решения: creds.update сохраняется, история и сообщения идут в known_chats,
 * при закрытии буфер Baileys выдаётся.
 */
function converse(
  link: ProbeLink,
  phone: PhoneDigits,
  writes: ProbeAuthWrites,
  logger: Logger,
): Promise<ProbeResult> {
  const { sock, chats } = link;
  return new Promise<ProbeResult>((resolve) => {
    let decided = false;
    sock.ev.process((events) => {
      if (events['creds.update'] !== undefined) writes.saveCreds();
      chats.receive(events);
      const update = events['connection.update'];
      if (update?.connection === 'close') flushEvents(sock, logger);
      const turn = update === undefined || decided ? null : turnOf(update);
      if (turn === null) return;
      decided = true;
      // Запросы сами ловят свои сбои; если что-то всё же упадёт, отказ уйдёт в итог и runBusinessProbe его разберёт.
      resolve(
        turn.kind === 'open'
          ? queryProfiles(sock, phone).then((profiles): ProbeResult => ({ kind: 'done', profiles }))
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
 * Закрытие по порядку: накопленные события выдаются и дописываются в known_chats, пока сокет жив (после end
 * сопоставление @lid закрыто), потом end без logout, ожидание всех записей сессии (creds и ключей) и чатов.
 */
async function closeLink(
  link: ProbeLink,
  writes: ProbeAuthWrites,
  logger: Logger,
): Promise<ProbeClosing> {
  flushEvents(link.sock, logger);
  await link.chats.idle();
  await endSocket(link.sock, logger);
  const saved = await writes.settled();
  link.chats.stop();
  await link.chats.idle();
  return { saved, timedOut: false, chats: link.chats.summary() };
}

/**
 * Версия WhatsApp Web, сокет с настройками бота (buildSocketConfig: не онлайн при подключении, без полной истории,
 * сессия из папки, ключи с учётом записей) и ожидание решающего события. Всё внутри общего срока: close() вызывается
 * и после срока, а сокет, который ещё не создан, уже не создаётся. Закрытие ограничено PROBE_CLOSE_TIMEOUT_MS: не
 * успело, значит сессия считается не сохранённой, а чаты в очереди не записанными.
 */
function openProbeSession(
  deps: ProbeDeps,
  auth: LoadedAuthState,
  phone: PhoneDigits,
  store: ProbeChatStore,
): ProbeSession {
  const writes = trackAuthWrites(auth, deps.logger);
  let link: ProbeLink | null = null;
  let closing = false;
  const result = (async (): Promise<ProbeResult> => {
    const version = await fetchVersionWithTimeout(
      deps.fetchVersion ?? fetchLatestBaileysVersion,
      deps,
    );
    if (closing) return { kind: 'closed', code: undefined };
    const config = buildSocketConfig({
      state: writes.state,
      version,
      deps: { logger: deps.logger, getSentText: () => Promise.resolve(null) },
    });
    const sock = (deps.createSocket ?? makeWASocket)(config);
    const { clock, logger } = deps;
    link = { sock, chats: createProbeChats({ store, sock, logger, clock }) };
    return converse(link, phone, writes, logger);
  })();
  const shutdown = async (): Promise<ProbeClosing> => {
    closing = true;
    const current = link;
    // Сокета нет: нет и записей сессии, Baileys пишет её только через сокет.
    if (current === null)
      return { saved: await writes.settled(), timedOut: false, chats: NO_CHATS };
    const finished = await withDeadline(deps.clock, PROBE_CLOSE_TIMEOUT_MS, () =>
      closeLink(current, writes, deps.logger),
    );
    if (finished !== TIMED_OUT) return finished;
    current.chats.stop();
    // Сокет, до end которого закрытие не дошло, закрывается без ожидания: дальше выход процесса.
    void endSocket(current.sock, deps.logger);
    deps.logger.error(
      { timeoutMs: PROBE_CLOSE_TIMEOUT_MS },
      'Проба не дождалась записи сессии и чатов',
    );
    // Чаты, которые ещё в очереди, итог чатов сам считает незаписанными.
    return { saved: false, timedOut: true, chats: current.chats.summary() };
  };
  let closed: Promise<ProbeClosing> | null = null;
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

/** Записи сессии в stderr: сбой или срок закрытия; true, если сессия сохранилась. */
function reportSession(deps: ProbeDeps, closing: ProbeClosing): boolean {
  if (closing.saved) return true;
  const seconds = String(PROBE_CLOSE_TIMEOUT_MS / MS_PER_SECOND);
  const message = closing.timedOut
    ? `Запись сессии WhatsApp и чатов не закончилась за ${seconds} с: сессия могла сохраниться не полностью`
    : MESSAGES.credsNotSaved;
  deps.out.stderr(`${message}\n`);
  return false;
}

/** Строка о сообщениях, доставшихся пробе: без JID и текста, только число. */
function receivedMessage(chats: ProbeChatsSummary): string {
  const head = `Проба получила сообщений: ${String(chats.messages)}. Бот их не увидит, в телефоне они есть`;
  return chats.complete ? `${head}; чаты записаны для этапа 8` : head;
}

/** Сообщения и чаты пробы в stderr; true, если все чаты записаны. */
function reportChats(deps: ProbeDeps, chats: ProbeChatsSummary): boolean {
  if (chats.messages > 0) deps.out.stderr(`${receivedMessage(chats)}\n`);
  if (!chats.complete) deps.out.stderr(`${MESSAGES.chatsIncomplete}\n`);
  return chats.complete;
}

/** Итог пробы: у удачной JSON в stdout и 0, иначе причина в stderr и 1. */
function outcomeCode(
  deps: ProbeDeps,
  outcome: ProbeResult | typeof TIMED_OUT,
  receivedMessages: number,
): number {
  if (outcome === TIMED_OUT) return fail(deps, timeoutMessage(timeoutOf(deps)));
  switch (outcome.kind) {
    case 'qr':
      return fail(deps, MESSAGES.qr);
    case 'closed':
      return fail(deps, closedMessage(outcome.code));
    case 'done': {
      const report: ProbeReport = { ...outcome.profiles, receivedMessages };
      deps.out.stdout(`${JSON.stringify(report)}\n`);
      return 0;
    }
  }
}

/** Печать итога и код выхода: 0 только при удачной пробе, сохранённой сессии и записанных чатах. */
function finish(
  deps: ProbeDeps,
  outcome: ProbeResult | typeof TIMED_OUT,
  closing: ProbeClosing,
): number {
  const code = outcomeCode(deps, outcome, closing.chats.messages);
  const saved = reportSession(deps, closing);
  const chatsSaved = reportChats(deps, closing.chats);
  return code === 0 && saved && chatsSaved ? 0 : 1;
}

async function runSession(
  phone: PhoneDigits,
  deps: ProbeDeps,
  auth: LoadedAuthState,
  store: ProbeChatStore,
): Promise<number> {
  const session = openProbeSession(deps, auth, phone, store);
  try {
    const outcome = await withDeadline(deps.clock, timeoutOf(deps), () => session.result);
    return finish(deps, outcome, await session.close());
  } finally {
    await session.close();
  }
}

async function runLocked(phone: PhoneDigits, deps: ProbeDeps): Promise<number> {
  const auth = await linkedAuth(deps);
  if (auth === null) return fail(deps, MESSAGES.noSession);
  const store = openStore(deps);
  if (typeof store === 'string') return fail(deps, store);
  try {
    return await runSession(phone, deps, auth, store);
  } finally {
    closeStore(store, deps.logger);
  }
}

function timeoutOf(deps: ProbeDeps): number {
  return deps.timeoutMs ?? PROBE_TIMEOUT_MS;
}

/**
 * Проба бизнес-профиля. Порядок: номер из аргумента (неверный: выход 1 до любых действий), замок процесса бота
 * (занят: выход 1), проверка, что сессия привязана (нет: выход 1, QR не запускается), база бота для known_chats (нет
 * или не открылась: выход 1 без подключения), сокет с настройками бота. Чаты из истории и сообщений, которые
 * достанутся пробе, пишутся в known_chats, как у бота. qr или закрытие до open: выход 1 без повторов и
 * переподключений. open: getBusinessProfile по номеру, затем по LID из lidMapping.getLIDForPN (если WhatsApp его
 * знает). Потом выдача накопленных событий, end без logout, ожидание записей сессии (creds и ключи) и чатов в пределах
 * PROBE_CLOSE_TIMEOUT_MS, закрытие базы и снятие замка. Общий срок 60 с. В stdout одна строка JSON (признаки полей и
 * число сообщений, без номера, JID и значений), в stderr причины и, если пробе пришли сообщения, их число. Привязку
 * по QR не считает и не начинает. Возвращает код выхода.
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
