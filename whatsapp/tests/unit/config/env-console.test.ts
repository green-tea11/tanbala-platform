import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/env.js';
import { ConfigError } from '../../../src/config/errors.js';

// Внутренний API консоли: WA_CONSOLE_TOKEN и CONSOLE_API_PORT.

type EnvInput = Readonly<Record<string, string | undefined>>;

const ROOT = resolve('/srv/tanbala');
const MODELS = {
  reply: 'claude-haiku-5-5',
  review: 'claude-haiku-5-5',
  interest: 'claude-haiku-5-5',
  logo: 'claude-haiku-5-5',
  transcribe: 'elevenlabs/scribe-v2',
};
const CONSOLE_TOKEN = 'console-secret-0123456789-abcdefghij';
const INTERNAL_TOKEN = 'internal-secret-0123456789-abcdefgh';

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

describe('config/env: API консоли', () => {
  it.each([undefined, '', '   '])(
    'токен %j: API консоли выключен, поля consoleApi нет',
    (token) => {
      const config = load({ WA_CONSOLE_TOKEN: token });

      expect(config.consoleApi).toBeUndefined();
      expect('consoleApi' in config).toBe(false);
    },
  );

  it('токен задан: порт по умолчанию 3101, пробелы по краям обрезаются', () => {
    expect(load({ WA_CONSOLE_TOKEN: ` ${CONSOLE_TOKEN}\t` }).consoleApi).toEqual({
      token: CONSOLE_TOKEN,
      port: 3101,
    });
  });

  it('свой порт', () => {
    expect(
      load({ WA_CONSOLE_TOKEN: CONSOLE_TOKEN, CONSOLE_API_PORT: '3201' }).consoleApi?.port,
    ).toBe(3201);
  });

  it('токен рядом с токеном почтового проекта, если они разные', () => {
    const config = load({ WA_CONSOLE_TOKEN: CONSOLE_TOKEN, INTERNAL_API_TOKEN: INTERNAL_TOKEN });

    expect(config.consoleApi?.token).toBe(CONSOLE_TOKEN);
    expect(config.companyApi?.token).toBe(INTERNAL_TOKEN);
  });

  it.each([
    ['короче 32', 'k'.repeat(31)],
    ['длиннее 512', 'k'.repeat(513)],
    ['с пробелом внутри', `${'k'.repeat(20)} ${'k'.repeat(20)}`],
    ['не ASCII', `${'k'.repeat(31)}ж`],
  ])('токен %s: запуск отклонён, значение в тексте не показано', (_label, token) => {
    const problems = problemsOf({ WA_CONSOLE_TOKEN: token });

    expect(problems).toEqual([expect.stringMatching(/^WA_CONSOLE_TOKEN: /)]);
    expect(problems.join('\n')).not.toContain(token);
  });

  it('токен консоли равен INTERNAL_API_TOKEN: запуск отклонён без значений', () => {
    const problems = problemsOf({
      WA_CONSOLE_TOKEN: CONSOLE_TOKEN,
      INTERNAL_API_TOKEN: ` ${CONSOLE_TOKEN}`,
    });

    expect(problems).toEqual([
      expect.stringMatching(/^WA_CONSOLE_TOKEN: должен отличаться от INTERNAL_API_TOKEN/),
    ]);
    expect(problems.join('\n')).not.toContain(CONSOLE_TOKEN);
  });

  it('порт консоли равен PANEL_PORT: запуск отклонён', () => {
    expect(problemsOf({ WA_CONSOLE_TOKEN: CONSOLE_TOKEN, CONSOLE_API_PORT: '3100' })).toEqual([
      expect.stringMatching(/^CONSOLE_API_PORT: должен отличаться от PANEL_PORT/),
    ]);
    expect(problemsOf({ WA_CONSOLE_TOKEN: CONSOLE_TOKEN, PANEL_PORT: '3101' })).toEqual([
      expect.stringMatching(/^CONSOLE_API_PORT: /),
    ]);
  });

  it('без токена совпадение портов не мешает: API консоли не запускается', () => {
    expect(load({ CONSOLE_API_PORT: '3100' }).consoleApi).toBeUndefined();
  });

  it.each(['0', '65536', 'abc', '3101.5'])(
    'неверный CONSOLE_API_PORT %s: отказ и без токена',
    (port) => {
      expect(problemsOf({ CONSOLE_API_PORT: port })).toEqual([
        expect.stringMatching(/^CONSOLE_API_PORT: /),
      ]);
    },
  );

  it('несколько проблем сразу: токен и порт', () => {
    const problems = problemsOf({ WA_CONSOLE_TOKEN: 'short', CONSOLE_API_PORT: '0' });

    expect(problems).toHaveLength(2);
  });
});
