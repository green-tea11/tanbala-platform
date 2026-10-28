import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EXAMPLE_PATH = new URL('../../.env.example', import.meta.url);
const LOCAL_ENV_PATH = new URL('../../.env', import.meta.url);

const REQUIRED_KEYS = [
  'VENMART_ANTHROPIC_KEY',
  'MANAGER_WHATSAPP',
  'ADMIN_PASSWORD',
  'OPENROUTER_API_KEY',
  'WA_ENABLED',
  'WHATSAPP_SESSION_DIR',
  'DATABASE_PATH',
  'TOKEN_LOG_PATH',
  'API_DAILY_LIMIT',
  'API_DAILY_LIMIT_PER_CHAT',
  'BACKLOG_MAX_AGE_HOURS',
  'TEST_MODE',
  'TEST_ALLOWLIST',
  'PANEL_HOST',
  'PANEL_PORT',
];

/** Разбирает KEY=VALUE. В сообщениях об ошибке только номер строки: в .env лежат секреты. */
function parseEnvFile(path: URL): Map<string, string> {
  const entries = new Map<string, string>();
  readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) return;
      const separator = trimmed.indexOf('=');
      if (separator <= 0) throw new Error(`Строка ${index + 1}: ожидается KEY=VALUE`);
      entries.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
    });
  return entries;
}

function isIgnored(path: string): boolean {
  const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', path], { cwd: ROOT });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git check-ignore завершился с кодом ${String(result.status)}`);
}

describe('.env.example', () => {
  const example = parseEnvFile(EXAMPLE_PATH);

  it('содержит ровно нужные переменные', () => {
    expect([...example.keys()].sort()).toEqual([...REQUIRED_KEYS].sort());
  });

  it.each(['VENMART_ANTHROPIC_KEY', 'OPENROUTER_API_KEY', 'MANAGER_WHATSAPP'])(
    'оставляет %s пустым: значение впишет владелец',
    (key) => {
      expect(example.get(key)).toBe('');
    },
  );

  it('задаёт пароль панели admin и адрес 127.0.0.1 по умолчанию', () => {
    expect(example.get('ADMIN_PASSWORD')).toBe('admin');
    expect(example.get('PANEL_HOST')).toBe('127.0.0.1');
  });

  it('задаёт предохранитель расходов: 500 вызовов API в сутки на бот и 100 на чат', () => {
    expect(example.get('API_DAILY_LIMIT')).toBe('500');
    expect(example.get('API_DAILY_LIMIT_PER_CHAT')).toBe('100');
  });

  it('отвечает на сообщения за время простоя не старше 12 часов', () => {
    expect(example.get('BACKLOG_MAX_AGE_HOURS')).toBe('12');
  });

  it('включает закрытый режим по умолчанию, список номеров заполняет владелец', () => {
    expect(example.get('TEST_MODE')).toBe('true');
    expect(example.get('TEST_ALLOWLIST')).toBe('');
  });

  it('держит WhatsApp выключенным, пока владелец не разрешит подключение', () => {
    expect(example.get('WA_ENABLED')).toBe('false');
  });

  it('связь с почтовым проектом: закрытый блок с тремя переменными, на значения по умолчанию он не влияет', () => {
    const text = readFileSync(EXAMPLE_PATH, 'utf8');

    expect(text).toMatch(/^# INTERNAL_API_TOKEN=$/m);
    expect(text).toMatch(/^# EMAIL_API_URL=http:\/\/127\.0\.0\.1:8000$/m);
    expect(text).toMatch(/^# EMAIL_UI_URL=$/m);
    for (const name of ['INTERNAL_API_TOKEN', 'EMAIL_API_URL', 'EMAIL_UI_URL']) {
      expect(example.has(name)).toBe(false);
    }
  });

  it('объясняет правила связи с почтовым проектом: API только на 127.0.0.1, интерфейс по https, без прокси', () => {
    const text = readFileSync(EXAMPLE_PATH, 'utf8');

    expect(text).toMatch(/^# EMAIL_API_URL: .*только 127\.0\.0\.1 \(не localhost\)/m);
    expect(text).toMatch(/^# EMAIL_UI_URL: .*https, http только для 127\.0\.0\.1 и localhost/m);
    expect(text).toMatch(/^# Прокси Node для fetch \(NODE_USE_ENV_PROXY=1 .*бот не запустится/m);
    expect(text).not.toMatch(/^NODE_USE_ENV_PROXY=|^NODE_OPTIONS=/m);
  });

  it('не упоминает стандартную переменную ключа SDK: проект её не читает', () => {
    expect(readFileSync(EXAMPLE_PATH, 'utf8')).not.toMatch(/ANTHROPIC_API_KEY/);
  });

  it.each(['WHATSAPP_SESSION_DIR', 'DATABASE_PATH', 'TOKEN_LOG_PATH'])(
    'путь из %s спрятан от git',
    (key) => {
      const value = example.get(key) ?? '';
      const probe = key === 'WHATSAPP_SESSION_DIR' ? `${value}/creds.json` : value;
      expect(isIgnored(probe.replace(/^\.\//, ''))).toBe(true);
    },
  );
});

describe('.env', () => {
  it.skipIf(!existsSync(LOCAL_ENV_PATH))('содержит те же переменные, что шаблон', () => {
    const local = parseEnvFile(LOCAL_ENV_PATH);
    expect([...local.keys()].sort()).toEqual([...REQUIRED_KEYS].sort());
  });
});
