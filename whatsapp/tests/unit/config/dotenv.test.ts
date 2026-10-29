import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnvironment } from '../../../src/config/dotenv.js';
import { ConfigError } from '../../../src/config/errors.js';

/** Метка порядка байтов UTF-8 кодом, а не невидимым символом в исходнике. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

let root: string;

function writeDotEnv(text: string): void {
  writeFileSync(join(root, '.env'), text, 'utf8');
}

/** Проблемы из ConfigError loadEnvironment; если ошибки нет или она другая, тест падает. */
function problemsOf(processEnv: Readonly<Record<string, string | undefined>>): readonly string[] {
  let failure: unknown = null;
  try {
    loadEnvironment(root, processEnv);
  } catch (error: unknown) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ConfigError);
  return (failure as ConfigError).problems;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tanbala-dotenv-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('config/dotenv loadEnvironment', () => {
  it('без файла .env остаются только переменные процесса', () => {
    expect(loadEnvironment(root, { PATH: '/usr/bin', PANEL_PORT: '3100' })).toEqual({
      PATH: '/usr/bin',
      PANEL_PORT: '3100',
    });
  });

  it('без файла и без переменных получается пустое окружение', () => {
    expect(loadEnvironment(root, {})).toEqual({});
  });

  it('читает .env из корня: комментарии пропускаются, кавычки снимаются', () => {
    writeDotEnv('# настройки\nWA_ENABLED=false\nADMIN_PASSWORD="пароль с пробелом"\nEMPTY=\n');

    expect(loadEnvironment(root, {})).toEqual({
      WA_ENABLED: 'false',
      ADMIN_PASSWORD: 'пароль с пробелом',
      EMPTY: '',
    });
  });

  it('переменные процесса главнее значений из .env', () => {
    writeDotEnv('PANEL_HOST=127.0.0.1\nPANEL_PORT=3100\n');

    expect(loadEnvironment(root, { PANEL_PORT: '8080' })).toEqual({
      PANEL_HOST: '127.0.0.1',
      PANEL_PORT: '8080',
    });
  });

  it('пустая переменная процесса тоже главнее: её задали явно', () => {
    writeDotEnv('MANAGER_WHATSAPP=77011234567\n');

    expect(loadEnvironment(root, { MANAGER_WHATSAPP: '' })).toEqual({ MANAGER_WHATSAPP: '' });
  });

  it('незаданная (undefined) переменная процесса значение из .env не затирает', () => {
    writeDotEnv('PANEL_HOST=127.0.0.1\n');

    expect(loadEnvironment(root, { PANEL_HOST: undefined })).toEqual({ PANEL_HOST: '127.0.0.1' });
  });

  it('метка порядка байтов в начале файла (Блокнот Windows) не портит первое имя', () => {
    writeDotEnv(BYTE_ORDER_MARK + 'VENMART_ANTHROPIC_KEY=\nWA_ENABLED=false\r\n');

    expect(Object.keys(loadEnvironment(root, {}))).toEqual(['VENMART_ANTHROPIC_KEY', 'WA_ENABLED']);
  });

  it('не меняет переданное окружение процесса и возвращает новый объект', () => {
    writeDotEnv('WA_ENABLED=false\nTEST_MODE=true\n');
    const processEnv = Object.freeze({ TEST_MODE: 'true' });

    const env = loadEnvironment(root, processEnv);

    expect(env).not.toBe(processEnv);
    expect(processEnv).toEqual({ TEST_MODE: 'true' });
  });

  it('нечитаемый .env (папка вместо файла): ConfigError с именем файла, без содержимого', () => {
    mkdirSync(join(root, '.env'));

    expect(problemsOf({})).toEqual([expect.stringMatching(/^\.env: /)]);
  });
});

describe('config/dotenv loadEnvironment: закрытый режим и подключение', () => {
  // Глобальная переменная Windows не должна молча перебить .env и снять закрытый режим.
  it.each([
    ['TEST_MODE', 'true', 'false'],
    ['TEST_ALLOWLIST', '77011234567', '77011234567,77027654321'],
    ['WA_ENABLED', 'false', 'true'],
  ])(
    '%s в процессе и в .env с разными значениями: ConfigError без значений',
    (name, inFile, inProcess) => {
      writeDotEnv(`${name}=${inFile}\n`);

      const problems = problemsOf({ [name]: inProcess });

      expect(problems).toEqual([expect.stringMatching(new RegExp(`^${name}: `))]);
      expect(problems.join('\n')).not.toMatch(/77011234567|77027654321|true|false/);
    },
  );

  it('пустая переменная процесса против значения в .env: тоже конфликт', () => {
    writeDotEnv('TEST_ALLOWLIST=77011234567\n');

    expect(problemsOf({ TEST_ALLOWLIST: '' })).toEqual([
      expect.stringMatching(/^TEST_ALLOWLIST: /),
    ]);
  });

  it('имя в процессе в другом регистре (Windows не различает регистр) тоже ловится', () => {
    writeDotEnv('WA_ENABLED=false\n');

    expect(problemsOf({ wa_enabled: 'true' })).toEqual([expect.stringMatching(/^WA_ENABLED: /)]);
  });

  it('все конфликты перечисляются сразу', () => {
    writeDotEnv('TEST_MODE=true\nWA_ENABLED=false\n');

    expect(problemsOf({ TEST_MODE: 'false', WA_ENABLED: 'true' })).toHaveLength(2);
  });

  it('одинаковые значения (с пробелами по краям) конфликтом не считаются', () => {
    writeDotEnv('TEST_MODE=true\nWA_ENABLED=false\n');

    expect(loadEnvironment(root, { TEST_MODE: ' true ', WA_ENABLED: 'false' })).toMatchObject({
      WA_ENABLED: 'false',
    });
  });

  it('переменная только в .env ошибкой не считается', () => {
    writeDotEnv('TEST_MODE=true\n');

    expect(loadEnvironment(root, { PANEL_PORT: '3100' })).toEqual({
      TEST_MODE: 'true',
      PANEL_PORT: '3100',
    });
  });

  // Глобальная переменная Windows не должна молча включить рабочий режим или WhatsApp, если в .env строки нет.
  it.each([
    ['TEST_MODE', 'false'],
    ['TEST_ALLOWLIST', '77011234567'],
    ['WA_ENABLED', 'true'],
  ])('%s только в процессе, в .env её нет: ConfigError без значения', (name, inProcess) => {
    writeDotEnv('PANEL_PORT=3100\n');

    const problems = problemsOf({ [name]: inProcess });

    expect(problems).toEqual([expect.stringMatching(new RegExp(`^${name}: .*\\.env`))]);
    expect(problems.join('\n')).not.toMatch(/77011234567|true|false/);
  });

  it('файла .env нет, а защищённая переменная в процессе (пустая, в другом регистре): ConfigError', () => {
    expect(problemsOf({ test_mode: 'false', TEST_ALLOWLIST: '' })).toEqual([
      expect.stringMatching(/^TEST_MODE: /),
      expect.stringMatching(/^TEST_ALLOWLIST: /),
    ]);
  });

  it('незаданная (undefined) защищённая переменная процесса ошибкой не считается', () => {
    expect(loadEnvironment(root, { WA_ENABLED: undefined })).toEqual({});
  });
});
