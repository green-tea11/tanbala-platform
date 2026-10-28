import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/env.js';
import { ConfigError } from '../../../src/config/errors.js';
import { ROOT as PROJECT_ROOT } from '../../helpers/source-files.js';

// Связь с почтовым проектом: INTERNAL_API_TOKEN, EMAIL_API_URL, EMAIL_UI_URL.

type EnvInput = Readonly<Record<string, string | undefined>>;

const ROOT = resolve('/srv/tanbala');
const MODELS = {
  reply: 'claude-haiku-5-5',
  review: 'claude-haiku-5-5',
  interest: 'claude-haiku-5-5',
  logo: 'claude-haiku-5-5',
  transcribe: 'elevenlabs/scribe-v2',
};
const TOKEN = 'k'.repeat(32);
const SECRET_TOKEN = 'secret-token-value-0123456789-abcdef';

function load(env: EnvInput): ReturnType<typeof loadConfig>['config'] {
  return loadConfig(env, MODELS, ROOT).config;
}

function problemsOf(env: EnvInput): readonly string[] {
  let failure: unknown = null;
  try {
    load(env);
  } catch (error: unknown) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ConfigError);
  return (failure as ConfigError).problems;
}

/** Запуск отклонён из-за переменной name, её значение в тексте не показано. */
function expectRejected(env: EnvInput, name: string, hiddenValue: string): void {
  const problems = problemsOf(env);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatch(new RegExp(`^${name}: `));
  expect(problems.join('\n')).not.toContain(hiddenValue);
}

describe('config/env: связь с почтовым проектом, значения по умолчанию', () => {
  it('без токена функция выключена: companyApi и emailUiUrl равны null', () => {
    const config = load({});

    expect(config.companyApi).toBeNull();
    expect(config.emailUiUrl).toBeNull();
  });

  it.each([undefined, '', '   '])('токен %j считается незаданным: функция выключена', (token) => {
    expect(load({ INTERNAL_API_TOKEN: token }).companyApi).toBeNull();
  });

  it('с токеном адрес API по умолчанию http://127.0.0.1:8000', () => {
    expect(load({ INTERNAL_API_TOKEN: TOKEN }).companyApi).toEqual({
      baseUrl: 'http://127.0.0.1:8000',
      token: TOKEN,
    });
  });

  it('адрес API проверяется и без токена: ошибка в адресе не ждёт включения функции', () => {
    expectRejected(
      { EMAIL_API_URL: 'https://127.0.0.1:8000' },
      'EMAIL_API_URL',
      'https://127.0.0.1:8000',
    );
  });

  it('шаблон .env.example проходит проверку, функция в нём выключена', () => {
    const template = parseEnv(readFileSync(join(PROJECT_ROOT, '.env.example'), 'utf8'));
    const models = JSON.parse(
      readFileSync(join(PROJECT_ROOT, 'config', 'models.json'), 'utf8'),
    ) as unknown;

    const { config } = loadConfig(template, models, PROJECT_ROOT);

    expect(config.companyApi).toBeNull();
    expect(config.emailUiUrl).toBeNull();
  });
});

describe('config/env: INTERNAL_API_TOKEN', () => {
  it.each([32, 33, 100, 512])('принимает видимые ASCII без пробелов длиной %i', (length) => {
    const token = 'aZ0!~'.repeat(Math.ceil(length / 5)).slice(0, length);

    expect(load({ INTERNAL_API_TOKEN: token }).companyApi?.token).toBe(token);
  });

  it('значение обрезается по краям, как у остальных переменных', () => {
    expect(load({ INTERNAL_API_TOKEN: `  ${TOKEN}\t` }).companyApi?.token).toBe(TOKEN);
  });

  it.each([
    ['короче 32', 'a'.repeat(31)],
    ['длиннее 512', 'a'.repeat(513)],
    ['с пробелом внутри', `${'a'.repeat(20)} ${'b'.repeat(20)}`],
    ['с кириллицей', `${'a'.repeat(31)}ж`],
    ['с табуляцией внутри', `${'a'.repeat(20)}\t${'b'.repeat(20)}`],
    ['с переносом строки внутри', `${'a'.repeat(20)}\n${'b'.repeat(20)}`],
  ])('отклоняет токен %s, не показывая значения', (_case, token) => {
    expectRejected({ INTERNAL_API_TOKEN: token }, 'INTERNAL_API_TOKEN', token);
  });

  it('проблема называет допустимую длину', () => {
    expect(problemsOf({ INTERNAL_API_TOKEN: 'short' })[0]).toMatch(/32.*512/);
  });

  it('ни проблемы, ни текст ошибки не содержат значения токена', () => {
    let failure: unknown = null;
    try {
      load({ INTERNAL_API_TOKEN: `${SECRET_TOKEN} с пробелом` });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ConfigError);
    const error = failure as ConfigError;
    expect(`${error.message}\n${error.problems.join('\n')}`).not.toContain(SECRET_TOKEN);
  });
});

describe('config/env: EMAIL_API_URL', () => {
  const accepted: readonly (readonly [string, string])[] = [
    ['http://127.0.0.1:8000', 'http://127.0.0.1:8000'],
    ['http://127.0.0.1:8000/', 'http://127.0.0.1:8000'],
    ['http://127.0.0.1', 'http://127.0.0.1'],
    ['http://localhost:9000', 'http://localhost:9000'],
    ['HTTP://LOCALHOST:9000/', 'http://localhost:9000'],
    [' http://127.0.0.1:8000 ', 'http://127.0.0.1:8000'],
  ];

  it.each(accepted)('принимает %s и хранит как %s', (value, expected) => {
    const config = load({ INTERNAL_API_TOKEN: TOKEN, EMAIL_API_URL: value });

    expect(config.companyApi?.baseUrl).toBe(expected);
  });

  it.each([
    ['https вместо http', 'https://127.0.0.1:8000'],
    ['чужой хост', 'http://mail.example.kz:8000'],
    ['0.0.0.0', 'http://0.0.0.0:8000'],
    ['адрес в локальной сети', 'http://192.168.1.10:8000'],
    ['localhost с точкой на конце', 'http://localhost.:8000'],
    ['поддомен localhost', 'http://api.localhost:8000'],
    ['IPv6 с отображённым IPv4', 'http://[::ffff:7f00:1]:8000'],
    ['IPv6 loopback: проект B ждёт Host 127.0.0.1 или localhost', 'http://[::1]:8000'],
    ['логин', 'http://user@127.0.0.1:8000'],
    ['логин и пароль', 'http://user:pass@127.0.0.1:8000'],
    ['только пароль', 'http://:pass@127.0.0.1:8000'],
    ['путь', 'http://127.0.0.1:8000/api'],
    ['двойной слэш', 'http://127.0.0.1:8000//'],
    ['параметры', 'http://127.0.0.1:8000/?a=1'],
    ['пустые параметры', 'http://127.0.0.1:8000?'],
    ['якорь', 'http://127.0.0.1:8000/#x'],
    ['пустой якорь', 'http://127.0.0.1:8000#'],
    ['без схемы', '127.0.0.1:8000'],
    ['чужая схема', 'ftp://127.0.0.1'],
    ['схема без двойного слэша', 'http:127.0.0.1:8000'],
    ['порт вне диапазона', 'http://127.0.0.1:99999'],
    ['обратный слэш', 'http://127.0.0.1:8000\\'],
    ['пробел внутри', 'http://127.0.0.1: 8000'],
    ['мусор', 'не адрес'],
  ])('отклоняет: %s', (_case, value) => {
    expectRejected({ INTERNAL_API_TOKEN: TOKEN, EMAIL_API_URL: value }, 'EMAIL_API_URL', value);
  });

  it('проблема объясняет правило по-русски', () => {
    expect(problemsOf({ EMAIL_API_URL: 'https://example.kz' })[0]).toMatch(/127\.0\.0\.1/);
  });

  it('пустое значение берёт адрес по умолчанию', () => {
    expect(load({ INTERNAL_API_TOKEN: TOKEN, EMAIL_API_URL: ' ' }).companyApi?.baseUrl).toBe(
      'http://127.0.0.1:8000',
    );
  });
});

describe('config/env: EMAIL_UI_URL', () => {
  it.each([
    ['https://mail.example.kz', 'https://mail.example.kz'],
    ['https://mail.example.kz/', 'https://mail.example.kz'],
    ['https://mail.example.kz//', 'https://mail.example.kz'],
    ['http://127.0.0.1:8000/', 'http://127.0.0.1:8000'],
    ['http://localhost:8000', 'http://localhost:8000'],
    ['https://example.kz/mail/', 'https://example.kz/mail'],
    ['https://example.kz/a%20b/c/', 'https://example.kz/a%20b/c'],
    ['  HTTPS://Mail.Example.kz:8443/ui/  ', 'https://mail.example.kz:8443/ui'],
  ])('принимает %s и хранит как %s', (value, expected) => {
    expect(load({ EMAIL_UI_URL: value }).emailUiUrl).toBe(expected);
  });

  it('адрес интерфейса не включает функцию без токена', () => {
    const config = load({ EMAIL_UI_URL: 'https://mail.example.kz' });

    expect(config.companyApi).toBeNull();
    expect(config.emailUiUrl).toBe('https://mail.example.kz');
  });

  it.each([undefined, '', '  '])('значение %j: адреса нет', (value) => {
    expect(load({ EMAIL_UI_URL: value }).emailUiUrl).toBeNull();
  });

  it.each([
    ['чужая схема', 'ftp://mail.example.kz'],
    ['без схемы', 'mail.example.kz'],
    ['логин', 'https://user@mail.example.kz'],
    ['логин и пароль', 'https://user:pass@mail.example.kz'],
    ['параметры', 'https://mail.example.kz/?a=1'],
    ['пустые параметры', 'https://mail.example.kz?'],
    ['якорь', 'https://mail.example.kz/#top'],
    ['пустой якорь', 'https://mail.example.kz#'],
    ['обратный слэш', 'https://mail.example.kz\\ui'],
    ['пробел внутри', 'https://mail.example.kz/a b'],
    ['мусор', 'не адрес'],
  ])('отклоняет: %s', (_case, value) => {
    expectRejected({ EMAIL_UI_URL: value }, 'EMAIL_UI_URL', value);
  });
});

describe('config/env: несколько проблем связи с почтовым проектом', () => {
  it('все три переменные проверяются сразу, по одной проблеме на каждую', () => {
    const problems = problemsOf({
      INTERNAL_API_TOKEN: 'short',
      EMAIL_API_URL: 'https://example.kz',
      EMAIL_UI_URL: 'ftp://example.kz',
    });

    expect(problems).toHaveLength(3);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^INTERNAL_API_TOKEN: /),
        expect.stringMatching(/^EMAIL_API_URL: /),
        expect.stringMatching(/^EMAIL_UI_URL: /),
      ]),
    );
  });
});
