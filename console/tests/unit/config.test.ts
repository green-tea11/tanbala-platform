import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnvironment } from '../../src/config/dotenv.js';
import { isNodeEnvProxyOn, loadConfig, parseBackendUrl } from '../../src/config/env.js';
import { ConfigError, formatFatalError } from '../../src/config/errors.js';

const ROOT = resolve('/srv/console');
const LEADS = 'L'.repeat(40);
const WA = 'W'.repeat(40);
const VALID = { LEADS_CONSOLE_TOKEN: LEADS, WA_CONSOLE_TOKEN: WA };

function problemsOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadConfig(env, ROOT);
  } catch (error: unknown) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe('настройки консоли', () => {
  it('значения по умолчанию', () => {
    expect(loadConfig(VALID, ROOT)).toEqual({
      host: '127.0.0.1',
      port: 3200,
      allowedHosts: [],
      leads: { baseUrl: 'http://127.0.0.1:8000', token: LEADS },
      wa: { baseUrl: 'http://127.0.0.1:3101', token: WA },
      databasePath: join(ROOT, 'data', 'console.db'),
      logLevel: 'info',
      localOnlyHealthz: false,
    });
  });

  it('свои значения; имена переменных без учёта регистра', () => {
    const config = loadConfig(
      {
        ...VALID,
        console_port: '3300',
        CONSOLE_ALLOWED_HOSTS: 'Panel.Tanbala.kz, panel2.tanbala.kz:8443',
        LEADS_API_URL: 'http://127.0.0.1:8100/',
        WA_API_URL: 'http://127.0.0.1:3111',
        CONSOLE_DATABASE_PATH: 'data/sub/c.db',
        LOG_LEVEL: 'WARN',
      },
      ROOT,
    );
    expect(config).toMatchObject({
      port: 3300,
      allowedHosts: ['panel.tanbala.kz', 'panel2.tanbala.kz:8443'],
      leads: { baseUrl: 'http://127.0.0.1:8100' },
      wa: { baseUrl: 'http://127.0.0.1:3111' },
      databasePath: join(ROOT, 'data', 'sub', 'c.db'),
      logLevel: 'warn',
    });
  });

  it('отказ: токены совпадают, не заданы или неверного вида — без значений в тексте', () => {
    expect(problemsOf({ LEADS_CONSOLE_TOKEN: LEADS, WA_CONSOLE_TOKEN: LEADS })).toEqual([
      'LEADS_CONSOLE_TOKEN и WA_CONSOLE_TOKEN совпадают: у почты и бота должны быть разные токены',
    ]);
    expect(problemsOf({})).toEqual([
      'LEADS_CONSOLE_TOKEN: не задан: без токена консоль не ходит в приложение',
      'WA_CONSOLE_TOKEN: не задан: без токена консоль не ходит в приложение',
    ]);
    const malformed = problemsOf({
      LEADS_CONSOLE_TOKEN: 'короткий',
      WA_CONSOLE_TOKEN: `${WA} ${WA}`,
    });
    expect(malformed).toHaveLength(2);
    expect(malformed.join()).not.toContain(WA);
  });

  it('отказ: прокси Node для fetch включён', () => {
    expect(problemsOf({ ...VALID, NODE_USE_ENV_PROXY: '1' })).toHaveLength(1);
    expect(
      problemsOf({ ...VALID, NODE_OPTIONS: '--max-old-space-size=128 --use-env-proxy' }),
    ).toHaveLength(1);
    expect(isNodeEnvProxyOn({ NODE_USE_ENV_PROXY: 'false' })).toBe(false);
    expect(isNodeEnvProxyOn({ node_use_env_proxy: 'TRUE' })).toBe(true);
    expect(isNodeEnvProxyOn({ NODE_OPTIONS: '--use_env_proxy=1' })).toBe(true);
  });

  it('отказ: адреса не http://127.0.0.1:<порт>, совпадают или указывают на консоль', () => {
    for (const url of [
      'http://localhost:8000',
      'https://127.0.0.1:8000',
      'http://127.0.0.1',
      'http://127.0.0.1:8000/internal',
      'http://user@127.0.0.1:8000',
      'http://127.0.0.1:70000',
    ]) {
      expect(parseBackendUrl(url)).toBeNull();
    }
    expect(problemsOf({ ...VALID, LEADS_API_URL: 'http://localhost:8000' })).toHaveLength(1);
    expect(problemsOf({ ...VALID, WA_API_URL: 'http://127.0.0.1:8000' })).toEqual([
      'LEADS_API_URL и WA_API_URL совпадают: у почты и бота разные порты',
    ]);
    expect(problemsOf({ ...VALID, WA_API_URL: 'http://127.0.0.1:3200' })).toEqual([
      'WA_API_URL: адрес указывает на саму консоль (CONSOLE_PORT)',
    ]);
  });

  it('отказ: адрес, порт, домены, база вне data/, уровень лога', () => {
    expect(problemsOf({ ...VALID, CONSOLE_HOST: '0.0.0.0' })).toHaveLength(1);
    expect(problemsOf({ ...VALID, CONSOLE_PORT: '0' })).toHaveLength(1);
    expect(problemsOf({ ...VALID, CONSOLE_PORT: 'abc' })).toHaveLength(1);
    expect(
      problemsOf({ ...VALID, CONSOLE_ALLOWED_HOSTS: 'https://panel.tanbala.kz' }),
    ).toHaveLength(1);
    expect(problemsOf({ ...VALID, CONSOLE_ALLOWED_HOSTS: 'localhost' })).toHaveLength(1);
    expect(problemsOf({ ...VALID, CONSOLE_ALLOWED_HOSTS: 'panel.kz:99999' })).toHaveLength(1);
    expect(problemsOf({ ...VALID, CONSOLE_DATABASE_PATH: '../console.db' })).toHaveLength(1);
    expect(problemsOf({ ...VALID, CONSOLE_DATABASE_PATH: 'data' })).toHaveLength(1);
    expect(problemsOf({ ...VALID, LOG_LEVEL: 'verbose' })).toHaveLength(1);
  });
});

describe('.env', () => {
  let dir = '';

  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('читается из корня, с меткой BOM; переменные процесса главнее', () => {
    dir = mkdtempSync(join(tmpdir(), 'console-env-'));
    writeFileSync(join(dir, '.env'), '﻿CONSOLE_PORT=3300\nLOG_LEVEL=debug\n');
    expect(loadEnvironment(dir, { LOG_LEVEL: 'warn', EMPTY: undefined })).toEqual({
      CONSOLE_PORT: '3300',
      LOG_LEVEL: 'warn',
    });
  });

  it('нет файла: только переменные процесса; не читается — ConfigError с кодом', () => {
    dir = mkdtempSync(join(tmpdir(), 'console-env-'));
    expect(loadEnvironment(dir, { A: '1' })).toEqual({ A: '1' });
    mkdirSync(join(dir, 'broken', '.env'), { recursive: true });
    expect(() => loadEnvironment(join(dir, 'broken'), {})).toThrow(ConfigError);
  });
});

describe('текст фатальной ошибки', () => {
  it('ConfigError — список проблем; прочее — только имя и код', () => {
    expect(formatFatalError('Консоль не запущена', new ConfigError(['A: плохо']))).toBe(
      'Консоль не запущена: настройки не прошли проверку.\n- A: плохо\n',
    );
    const error = Object.assign(new Error('секрет в тексте'), { code: 'EACCES' });
    const text = formatFatalError('Консоль не запущена', error);
    expect(text).toContain('Error (EACCES)');
    expect(text).not.toContain('секрет');
    expect(formatFatalError('X', 'строка')).toContain('неизвестного вида');
  });
});
