import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireProcessLock } from '../../src/db/process-lock.js';
import { runProbeCli, type ProbeCliOptions } from '../../src/probe-cli.js';
import { PROBE_USAGE } from '../../src/whatsapp/probe.js';

// Точка входа пробы во временном корне: настоящие .env, config/models.json и замок data/process.lock, а до сокета
// дело не доходит (сессии нет). К WhatsApp никто не подключается, сеть в тестах запрещена.

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PHONE = '77012345678';
const VALID_ENV = { TEST_MODE: 'true', TEST_ALLOWLIST: '77000000002', WA_ENABLED: 'true' };

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tanbala-probe-cli-'));
  mkdirSync(join(root, 'config'));
  copyFileSync(join(PROJECT_ROOT, 'config', 'models.json'), join(root, 'config', 'models.json'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function run(options: Partial<ProbeCliOptions> = {}): Promise<Run> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runProbeCli({
    args: [PHONE],
    env: VALID_ENV,
    root,
    stdout: (text) => {
      stdout.push(text);
    },
    stderr: (text) => {
      stderr.push(text);
    },
    ...options,
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

describe('probe-cli runProbeCli', () => {
  it('неверный номер: подсказка и выход 1 до чтения настроек и замка', async () => {
    rmSync(join(root, 'config'), { recursive: true });

    const result = await run({ args: ['+7 701'] });

    expect(result).toEqual({ code: 1, stdout: '', stderr: `${PROBE_USAGE}\n` });
    expect(existsSync(join(root, 'data'))).toBe(false);
  });

  it('настройки не прошли проверку: список причин, выход 1, замок не берётся', async () => {
    rmSync(join(root, 'config', 'models.json'));

    const result = await run();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('config/models.json: файл не читается (ENOENT)');
    expect(result.stdout).toBe('');
    expect(existsSync(join(root, 'data'))).toBe(false);
  });

  it('WA_ENABLED=false: отказ до замка и сессии, выход 1', async () => {
    const result = await run({ env: { ...VALID_ENV, WA_ENABLED: 'false' } });

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'WA_ENABLED=false: подключение к WhatsApp выключено, проба не запускается\n',
    });
    expect(existsSync(join(root, 'data'))).toBe(false);
  });

  it('бот запущен (замок data/process.lock занят): выход 1 с понятной причиной', async () => {
    const botLock = acquireProcessLock(join(root, 'data', 'process.lock'));
    try {
      const result = await run();

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Бот запущен: остановите его перед пробой');
      expect(result.stdout).toBe('');
    } finally {
      botLock.release();
    }
  });

  it('сессии нет: выход 1 без QR, папка сессии не создаётся, замок снят', async () => {
    const result = await run();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Сессии нет, QR не запускаю');
    expect(result.stdout).toBe('');
    expect(existsSync(join(root, 'data', 'whatsapp-session'))).toBe(false);
    const nextLock = acquireProcessLock(join(root, 'data', 'process.lock'));
    nextLock.release();
  });

  it('сбой замка, не занятость (путь замка занят папкой): имя ошибки без текста, выход 1', async () => {
    mkdirSync(join(root, 'data', 'process.lock'), { recursive: true });

    const result = await run();

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^Проба остановлена из-за ошибки \w+\n$/);
    expect(result.stderr).not.toContain(root);
  });
});
