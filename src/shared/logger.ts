import { pino, type LogFn, type Logger as PinoLogger } from 'pino';
import type { Logger } from '../domain/ports.js';

/** Куда писать строки лога (JSON по строке на запись). */
export interface LogDestination {
  write(line: string): void;
}

export interface CreateLoggerOptions {
  /** trace, debug, info, warn, error, fatal или silent. */
  readonly level: string;
  /** Приёмник строк; по умолчанию stdout. Тесты передают свой. */
  readonly destination?: LogDestination;
}

/** Чем заменяются скрытые значения. */
const CENSOR = '[скрыто]';
/** Чем заменяется циклическая ссылка в объекте записи. */
const CIRCULAR = '[цикл]';
/** Запись, которую не удалось замаскировать: лучше потерять её, чем вывести номер или ключ. */
const MASK_FAILED = 'запись лога скрыта: её не удалось замаскировать';
/** Глубже этого уровня значения не выводятся: маскировка не уходит в бесконечную вложенность. */
const MAX_MASK_DEPTH = 10;

/** JID с номером или LID: ...@s.whatsapp.net, ...@lid и родственные серверы WhatsApp (с устройством «:N»). */
const JID_PATTERN = /[\w.:-]+@(?:s\.whatsapp\.net|c\.us|g\.us|hosted\.lid|hosted|lid)\b/g;
/** Номер телефона или другой длинный идентификатор: 7 и больше цифр подряд. */
const LONG_DIGITS_PATTERN = /\d{7,}/g;
/**
 * Имена в строке узла Baileys: binaryNodeToString пишет атрибуты как k='v' без экранирования,
 * например notify='Имя' и participant_username='...'. Первая ветка дотягивает значение до кавычки,
 * за которой идёт следующий атрибут, конец тега или строки (апостроф внутри имени не оставит хвост);
 * вторая закрывает простой случай '[^']*'.
 */
const NAME_ATTRIBUTE_PATTERN =
  /\b(notify|\w*username)='(?:.*?'(?=\s+[\w:-]+='|\s*\/?>|\s*$)|[^']*')/gi;
/** Ключ с таким окончанием скрывается всегда: remoteJidUsername, participant_username и подобные. */
const USERNAME_SUFFIX = 'username';

/**
 * Ключи, значения которых не попадают в лог: ключи, пароли и токены, текст, имена из профиля и username,
 * узлы протокола (в них имена и номера), номера и адреса, сайты, почта и домены компаний клиентов (данные
 * бизнес-профиля и почтового проекта). Общий ключ name не скрывается: под ним имена ошибок и модулей.
 */
const SENSITIVE_KEYS = [
  'apiKey',
  'anthropicKey',
  'authToken',
  'authorization',
  'token',
  'secret',
  'password',
  'adminPassword',
  'text',
  'caption',
  'conversation',
  'body',
  'vcard',
  'pushName',
  'notify',
  'verifiedBizName',
  'verifiedName',
  'username',
  'remoteJidUsername',
  'participantUsername',
  'node',
  'xml',
  'fullErrorNode',
  'phone',
  'managerPhone',
  'chatPhone',
  'testAllowlist',
  'jid',
  'remoteJid',
  'remoteJidAlt',
  'participant',
  'participantAlt',
  'replyJid',
  'lidJid',
  'pnJid',
  'chatJid',
  'pn',
  'lid',
  'websites',
  'email',
  'domain',
] as const;

/** Для маскировки на любой глубине: имена без учёта регистра. */
const SENSITIVE_KEY_SET: ReadonlySet<string> = new Set(
  SENSITIVE_KEYS.map((key) => key.toLowerCase()),
);

/**
 * redact pino: ключ на верхнем уровне и уровнем ниже, в том числе в привязках child.
 * Глубже пути pino не достают: там работает маскировка в hooks.logMethod.
 */
const REDACT_PATHS: readonly string[] = SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`]);

type Mask = (value: unknown) => unknown;

function maskText(text: string): string {
  return text
    .replace(NAME_ATTRIBUTE_PATTERN, `$1='${CENSOR}'`)
    .replace(JID_PATTERN, CENSOR)
    .replace(LONG_DIGITS_PATTERN, CENSOR);
}

function isSensitiveKey(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return SENSITIVE_KEY_SET.has(lowerKey) || lowerKey.endsWith(USERNAME_SUFFIX);
}

function hasToJson(value: object): value is { toJSON(): unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function';
}

function maskEntries(source: object, mask: Mask): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source).map(([key, item]) => [key, isSensitiveKey(key) ? CENSOR : mask(item)]),
  );
}

function defineHidden(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, configurable: true });
}

/** Копия ошибки того же класса (pino и его сериализатор err видят Error) с замаскированными полями. */
function maskError(error: Error, mask: Mask): Error {
  const copy = Object.create(Object.getPrototypeOf(error) as object | null) as Error;
  defineHidden(copy, 'message', maskText(error.message));
  if (error.stack !== undefined) {
    defineHidden(copy, 'stack', maskText(error.stack));
  }
  if (error.cause !== undefined) {
    defineHidden(copy, 'cause', mask(error.cause));
  }
  return Object.assign(copy, maskEntries(error, mask));
}

/** Объект для лога так, как его увидел бы JSON.stringify: массивы, ошибки, toJSON, свои поля. */
function maskObject(value: object, mask: Mask): unknown {
  if (Array.isArray(value)) {
    return value.map(mask);
  }
  if (value instanceof Error) {
    return maskError(value, mask);
  }
  if (hasToJson(value)) {
    return mask(value.toJSON());
  }
  return maskEntries(value, mask);
}

/** Копия значения: строки замаскированы, чувствительные ключи скрыты; исходный объект не меняется. */
function maskValue(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return maskText(value);
  }
  if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) {
    return value;
  }
  if (depth >= MAX_MASK_DEPTH) {
    return CENSOR;
  }
  if (ancestors.has(value)) {
    return CIRCULAR;
  }
  ancestors.add(value);
  try {
    return maskObject(value, (item) => maskValue(item, depth + 1, ancestors));
  } finally {
    ancestors.delete(value);
  }
}

function maskArguments(args: readonly unknown[]): unknown[] {
  try {
    return args.map((arg) => maskValue(arg, 0, new WeakSet()));
  } catch {
    return [MASK_FAILED];
  }
}

/**
 * hooks.logMethod: маскирует все аргументы записи, и объект, и строку сообщения с подстановками.
 * formatters.log видит только объект, а пути redact не достают вложенные объекты и строки Baileys.
 * Хук задаётся корневому логгеру, дочерние (в том числе логгер Baileys) его наследуют.
 */
function maskLogArguments(this: PinoLogger, args: Parameters<LogFn>, method: LogFn): void {
  method.apply(this, maskArguments(args) as Parameters<LogFn>);
}

/**
 * Создаёт логгер приложения на pino 10. level: trace, debug, info, warn, error, fatal или silent.
 * Текст сообщений, имена из профиля и username, узлы протокола, номера, ключи и пароль панели скрываются
 * (redact и маскировка по ключам на любой глубине); во всех строках записи маскируются JID, 7 и больше
 * цифр подряд и атрибуты notify='...' и *username='...' из строк узлов Baileys.
 * Привязки child проходят только redact по ключам: JID и номера в привязки не передавать.
 * Baileys получает logger.child({ module: 'baileys' }, { level: 'warn' }): на debug и trace он пишет протокол
 * и содержимое сообщений.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      redact: { paths: [...REDACT_PATHS], censor: CENSOR },
      hooks: { logMethod: maskLogArguments },
    },
    options.destination,
  );
}
