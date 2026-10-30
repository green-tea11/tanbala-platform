import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger } from 'pino';

/** Чем заменяются скрытые значения. */
const CENSOR = '[скрыто]';

/**
 * Ключи, значения которых в лог не попадают: пароли, токены, cookie, токен CSRF, тексты и номера.
 * Ключ на верхнем уровне и уровнем ниже (в том числе в привязках child), плюс заголовки запроса.
 */
const SENSITIVE_KEYS = [
  'password',
  'passwordHash',
  'token',
  'csrf',
  'csrfToken',
  'cookie',
  'authorization',
  'text',
  'note',
  'answer',
  'task',
  'body',
  'phone',
  'email',
  'fileBase64',
] as const;

const HEADER_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'req.headers["x-console-token"]',
  'headers.cookie',
  'headers.authorization',
  'headers["x-csrf-token"]',
  'headers["x-console-token"]',
  'headers["set-cookie"]',
];

const REDACT_PATHS: readonly string[] = [
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`]),
  ...HEADER_PATHS,
];

export interface CreateLoggerOptions {
  /** trace, debug, info, warn, error, fatal или silent. */
  readonly level: string;
  /** Приёмник строк; по умолчанию stdout (журнал systemd). Тесты передают свой. */
  readonly destination?: DestinationStream;
}

/**
 * Логгер консоли: JSON по строке в stdout, секреты и тексты скрыты. Запрос записывается только методом и путём,
 * без строки запроса (в ней бывают имя клиента и цифры номера из поиска).
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      base: { app: 'tanbala-console' },
      redact: { paths: [...REDACT_PATHS], censor: CENSOR },
      serializers: {
        req: (req: { method?: string; url?: string }) => ({
          method: req.method,
          path: typeof req.url === 'string' ? req.url.split('?')[0] : undefined,
        }),
      },
    },
    options.destination,
  );
}
