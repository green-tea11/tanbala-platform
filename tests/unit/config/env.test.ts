import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/env.js';
import { ConfigError } from '../../../src/config/errors.js';
import { ROOT as PROJECT_ROOT } from '../../helpers/source-files.js';

type EnvInput = Readonly<Record<string, string | undefined>>;

// Корень вымышленный: loadConfig только считает пути и не трогает файловую систему.
const ROOT = resolve('/srv/tanbala');
const CLAUDE_MODELS = {
  reply: 'claude-haiku-5-5',
  review: 'claude-haiku-5-5',
  interest: 'claude-haiku-5-5',
  logo: 'claude-haiku-5-5',
};
const TRANSCRIBE_MODEL = 'elevenlabs/scribe-v2';
const MODELS = { ...CLAUDE_MODELS, transcribe: TRANSCRIBE_MODEL };
const PHONE_A = '77011234567';
const PHONE_B = '77027654321';
const SECRET_KEY = 'sk-ant-test-secret-value';
const OPENROUTER_KEY = 'sk-or-v1-test-secret-value';
const EMPTY_ALLOWLIST_WARNING = expect.stringContaining('TEST_ALLOWLIST') as unknown;

function load(env: EnvInput, models: unknown = MODELS): ReturnType<typeof loadConfig> {
  return loadConfig(env, models, ROOT);
}

/** Проблемы из ConfigError; если ошибки нет или она другая, тест падает. */
function problemsFrom(run: () => unknown): readonly string[] {
  let failure: unknown = null;
  try {
    run();
  } catch (error: unknown) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ConfigError);
  return (failure as ConfigError).problems;
}

function problemsOf(env: EnvInput, models: unknown = MODELS): readonly string[] {
  return problemsFrom(() => load(env, models));
}

/** Без параметра по умолчанию: явный undefined тоже доходит до loadConfig. */
function modelProblems(models: unknown): readonly string[] {
  return problemsFrom(() => loadConfig({}, models, ROOT));
}

/** Запуск отклонён из-за переменной name, а её значение в тексте ошибки не показано. */
function expectRejected(env: EnvInput, name: string, hiddenValue?: string): void {
  const problems = problemsOf(env);
  expect(problems.some((problem) => problem.startsWith(`${name}: `))).toBe(true);
  if (hiddenValue !== undefined) {
    expect(problems.join('\n')).not.toContain(hiddenValue);
  }
}

describe('config/env loadConfig: значения по умолчанию', () => {
  it('пустое окружение даёт безопасные настройки и предупреждение о пустом списке', () => {
    const { config, warnings } = load({});

    expect(config).toEqual({
      anthropicKey: null,
      managerPhone: null,
      adminPassword: 'admin',
      voice: null,
      waEnabled: false,
      waSessionDir: join(ROOT, 'data', 'whatsapp-session'),
      databasePath: join(ROOT, 'data', 'tanbala.db'),
      tokenLogPath: join(ROOT, 'data', 'token-usage.jsonl'),
      knowledgeDir: join(ROOT, 'knowledge'),
      pairingMirrorPath: join(ROOT, '.pairing-attempts.json'),
      panel: { host: '127.0.0.1', port: 3100, allowedHosts: [] },
      models: CLAUDE_MODELS,
      limits: { apiCallsPerDay: 500, apiCallsPerChatPerDay: 100 },
      backlogMaxAgeHours: 12,
      testMode: { enabled: true, allowlist: new Set() },
    });
    expect(warnings).toEqual([EMPTY_ALLOWLIST_WARNING]);
  });

  it('пустые значения и значения из пробелов считаются незаданными', () => {
    const blank = {
      WA_ENABLED: '',
      TEST_MODE: '  ',
      API_DAILY_LIMIT: '',
      BACKLOG_MAX_AGE_HOURS: ' ',
      PANEL_HOST: '',
      PANEL_PORT: '',
      PANEL_ALLOWED_HOSTS: ' ',
      DATABASE_PATH: '',
      ADMIN_PASSWORD: '',
    };

    expect(load(blank).config).toEqual(load({}).config);
  });

  it('шаблон .env.example вместе с config/models.json проходит проверку', () => {
    const template = parseEnv(readFileSync(join(PROJECT_ROOT, '.env.example'), 'utf8'));
    const models = JSON.parse(
      readFileSync(join(PROJECT_ROOT, 'config', 'models.json'), 'utf8'),
    ) as unknown;

    const { config, warnings } = loadConfig(template, models, PROJECT_ROOT);

    expect(config.waEnabled).toBe(false);
    expect(config.voice).toBeNull();
    expect(config.testMode).toEqual({ enabled: true, allowlist: new Set() });
    expect(config.databasePath).toBe(join(PROJECT_ROOT, 'data', 'tanbala.db'));
    expect(config.limits).toEqual({ apiCallsPerDay: 500, apiCallsPerChatPerDay: 100 });
    expect(warnings).toEqual([EMPTY_ALLOWLIST_WARNING]);
  });

  it('не меняет переданное окружение', () => {
    const env = Object.freeze({ TEST_ALLOWLIST: ` ${PHONE_A} `, WA_ENABLED: 'true' });

    load(env);

    expect(env).toEqual({ TEST_ALLOWLIST: ` ${PHONE_A} `, WA_ENABLED: 'true' });
  });
});

describe('config/env loadConfig: ключи и пароль', () => {
  it('VENMART_ANTHROPIC_KEY берётся с обрезкой пробелов по краям', () => {
    expect(load({ VENMART_ANTHROPIC_KEY: `  ${SECRET_KEY}\t` }).config.anthropicKey).toBe(
      SECRET_KEY,
    );
  });

  it('стандартная переменная ключа SDK ключом не становится', () => {
    expect(load({ ANTHROPIC_API_KEY: SECRET_KEY }).config.anthropicKey).toBeNull();
  });

  it('ADMIN_PASSWORD берётся как есть, без него пароль admin', () => {
    expect(load({ ADMIN_PASSWORD: 'Strong-Password-2026!' }).config.adminPassword).toBe(
      'Strong-Password-2026!',
    );
    expect(load({}).config.adminPassword).toBe('admin');
  });

  it('OPENROUTER_API_KEY включает расшифровку: ключ с обрезкой пробелов, модель из transcribe', () => {
    expect(load({ OPENROUTER_API_KEY: ` ${OPENROUTER_KEY}\t` }).config.voice).toEqual({
      apiKey: OPENROUTER_KEY,
      model: TRANSCRIBE_MODEL,
    });
  });

  it.each([undefined, '', '   '])('без ключа OpenRouter (%j) расшифровка выключена', (key) => {
    expect(load({ OPENROUTER_API_KEY: key }).config.voice).toBeNull();
  });
});

describe('config/env loadConfig: MANAGER_WHATSAPP', () => {
  it.each([PHONE_A, '123456789012345'])('принимает номер от 11 до 15 цифр: %s', (phone) => {
    expect(load({ MANAGER_WHATSAPP: phone }).config.managerPhone).toBe(phone);
  });

  it.each(['+77011234567', '7701123456', '7701123456789012', '7 701 123 45 67', '8(701)1234567'])(
    'отклоняет номер не из одних цифр или неверной длины, не показывая его: %s',
    (phone) => {
      expectRejected({ MANAGER_WHATSAPP: phone }, 'MANAGER_WHATSAPP', phone);
    },
  );
});

describe('config/env loadConfig: WA_ENABLED и TEST_MODE', () => {
  it('true и false разбираются, по умолчанию WhatsApp выключен, а закрытый режим включён', () => {
    expect(load({ WA_ENABLED: 'true' }).config.waEnabled).toBe(true);
    expect(load({ WA_ENABLED: 'false' }).config.waEnabled).toBe(false);
    expect(load({ TEST_MODE: 'true' }).config.testMode.enabled).toBe(true);
    expect(load({}).config.testMode.enabled).toBe(true);
  });

  it('TEST_MODE=false до этапа 8 отклоняется: выключение закрытого режима ещё не готово', () => {
    const problems = problemsOf({ TEST_MODE: 'false', TEST_ALLOWLIST: PHONE_A });

    expect(problems).toEqual([expect.stringMatching(/^TEST_MODE: .*этап.* 8/)]);
  });

  it.each([
    ['WA_ENABLED', 'yes'],
    ['WA_ENABLED', 'TRUE'],
    ['WA_ENABLED', '1'],
    ['TEST_MODE', 'off'],
    ['TEST_MODE', 'False'],
    ['TEST_MODE', '0'],
  ])('%s=%s отклоняется: только true или false', (name, value) => {
    expectRejected({ [name]: value }, name);
  });
});

describe('config/env loadConfig: TEST_ALLOWLIST', () => {
  it('номера через запятую обрезаются по краям, повторы схлопываются', () => {
    const { config, warnings } = load({ TEST_ALLOWLIST: ` ${PHONE_A} ,${PHONE_B}, ${PHONE_A}` });

    expect(config.testMode).toEqual({ enabled: true, allowlist: new Set([PHONE_A, PHONE_B]) });
    expect(warnings).toEqual([]);
  });

  it('неверный номер называется позицией в списке, сам номер не показывается', () => {
    const problems = problemsOf({ TEST_ALLOWLIST: `${PHONE_A}, 87011234567` });

    expect(problems).toEqual([expect.stringMatching(/^TEST_ALLOWLIST: .*номер 2\b/)]);
    expect(problems.join('\n')).not.toContain('87011234567');
  });

  it('каждый неверный номер даёт отдельную проблему, пустая позиция тоже неверна', () => {
    const problems = problemsOf({ TEST_ALLOWLIST: `7701123456, ${PHONE_A},,+77027654321` });

    expect(problems).toEqual([
      expect.stringMatching(/^TEST_ALLOWLIST: .*номер 1\b/),
      expect.stringMatching(/^TEST_ALLOWLIST: .*номер 3\b/),
      expect.stringMatching(/^TEST_ALLOWLIST: .*номер 4\b/),
    ]);
  });

  it('при TEST_MODE=false и неверном списке названы обе проблемы', () => {
    const problems = problemsOf({ TEST_MODE: 'false', TEST_ALLOWLIST: '123' });

    expect(problems).toEqual([
      expect.stringMatching(/^TEST_MODE: /),
      expect.stringMatching(/^TEST_ALLOWLIST: /),
    ]);
  });
});

describe('config/env loadConfig: числа', () => {
  it('лимиты, порог простоя и порт берутся из окружения', () => {
    const { config } = load({
      API_DAILY_LIMIT: '1000',
      API_DAILY_LIMIT_PER_CHAT: '20',
      BACKLOG_MAX_AGE_HOURS: '24',
      PANEL_PORT: '8080',
    });

    expect(config.limits).toEqual({ apiCallsPerDay: 1000, apiCallsPerChatPerDay: 20 });
    expect(config.backlogMaxAgeHours).toBe(24);
    expect(config.panel.port).toBe(8080);
  });

  it('граничные значения допустимы', () => {
    const low = load({ API_DAILY_LIMIT: '1', BACKLOG_MAX_AGE_HOURS: '1', PANEL_PORT: '1' }).config;
    const high = load({ BACKLOG_MAX_AGE_HOURS: '8760', PANEL_PORT: '65535' }).config;

    expect([low.limits.apiCallsPerDay, low.backlogMaxAgeHours, low.panel.port]).toEqual([1, 1, 1]);
    expect([high.backlogMaxAgeHours, high.panel.port]).toEqual([8760, 65535]);
  });

  it.each([
    ['API_DAILY_LIMIT', '0'],
    ['API_DAILY_LIMIT', '-5'],
    ['API_DAILY_LIMIT', '1.5'],
    ['API_DAILY_LIMIT', '1e3'],
    ['API_DAILY_LIMIT', 'много'],
    ['API_DAILY_LIMIT', '99999999999999999999'],
    ['API_DAILY_LIMIT_PER_CHAT', '0'],
    ['API_DAILY_LIMIT_PER_CHAT', '0x10'],
    ['BACKLOG_MAX_AGE_HOURS', '0'],
    ['BACKLOG_MAX_AGE_HOURS', '2.5'],
    ['BACKLOG_MAX_AGE_HOURS', '12h'],
    ['BACKLOG_MAX_AGE_HOURS', '8761'],
    ['PANEL_PORT', '0'],
    ['PANEL_PORT', '65536'],
    ['PANEL_PORT', '80a'],
  ])('%s=%s отклоняется', (name, value) => {
    expectRejected({ [name]: value }, name);
  });

  it('у одной переменной одна проблема, даже если нарушено несколько условий', () => {
    expect(problemsOf({ API_DAILY_LIMIT: '99999999999999999999' })).toHaveLength(1);
  });
});

describe('config/env loadConfig: PANEL_HOST', () => {
  it('по умолчанию 127.0.0.1, другой адрес пропускается: решает охрана панели', () => {
    expect(load({}).config.panel.host).toBe('127.0.0.1');
    expect(load({ PANEL_HOST: '0.0.0.0' }).config.panel.host).toBe('0.0.0.0');
  });

  it('адрес с пробелом внутри отклоняется', () => {
    expectRejected({ PANEL_HOST: 'local host' }, 'PANEL_HOST');
  });
});

describe('config/env loadConfig: PANEL_ALLOWED_HOSTS', () => {
  it('по умолчанию список пуст: за прокси панель отвечает только на локальные имена', () => {
    expect(load({}).config.panel.allowedHosts).toEqual([]);
  });

  it('домены через запятую, с портом или без, приводятся к нижнему регистру', () => {
    const { config } = load({
      PANEL_ALLOWED_HOSTS: ' Panel.Example.kz , panel2.example.kz:8443,localhost:3100',
    });

    expect(config.panel.allowedHosts).toEqual([
      'panel.example.kz',
      'panel2.example.kz:8443',
      'localhost:3100',
    ]);
  });

  it.each([
    'https://panel.example.kz',
    'panel.example.kz/path',
    'panel example.kz',
    'panel.example.kz:0',
    'panel.example.kz:65536',
    'panel.example.kz:80a',
    '-panel.example.kz',
    'panel.example.kz-',
    'панель.рф',
    'panel.example.kz,,other.example.kz',
    '[::1]:3100',
  ])('значение «%s» отклоняется без показа значения', (value) => {
    expectRejected({ PANEL_ALLOWED_HOSTS: value }, 'PANEL_ALLOWED_HOSTS', value);
  });

  it('проблема называет позицию в списке', () => {
    const problems = problemsOf({ PANEL_ALLOWED_HOSTS: 'panel.example.kz,не домен' });

    expect(problems).toEqual([expect.stringMatching(/^PANEL_ALLOWED_HOSTS: .*2/)]);
  });
});

describe('config/env loadConfig: пути', () => {
  it('относительные пути считаются от корня проекта, а не от текущей папки', () => {
    const { config } = load({
      WHATSAPP_SESSION_DIR: 'data/sessions/main',
      DATABASE_PATH: './data/db/bot.db',
      TOKEN_LOG_PATH: 'data/usage.jsonl',
    });

    expect(config.waSessionDir).toBe(join(ROOT, 'data', 'sessions', 'main'));
    expect(config.databasePath).toBe(join(ROOT, 'data', 'db', 'bot.db'));
    expect(config.tokenLogPath).toBe(join(ROOT, 'data', 'usage.jsonl'));
  });

  it('абсолютный путь внутри data/ принимается', () => {
    const absolute = join(ROOT, 'data', 'other.db');

    expect(load({ DATABASE_PATH: absolute }).config.databasePath).toBe(absolute);
  });

  it('папка знаний и копия счётчика привязки лежат в корне проекта', () => {
    const { config } = load({});

    expect(config.knowledgeDir).toBe(join(ROOT, 'knowledge'));
    expect(config.pairingMirrorPath).toBe(join(ROOT, '.pairing-attempts.json'));
  });

  const outside = [
    '../outside.db',
    './data',
    './data/../tanbala.db',
    './tanbala.db',
    'knowledge/tanbala.db',
    resolve(tmpdir(), 'tanbala.db'),
  ];
  it.each(
    ['WHATSAPP_SESSION_DIR', 'DATABASE_PATH', 'TOKEN_LOG_PATH'].flatMap((name) =>
      outside.map((path) => [name, path]),
    ),
  )('%s=%s вне data/ отклоняется, путь не показывается', (name, path) => {
    expectRejected({ [name]: path }, name, path);
  });
});

describe('config/env loadConfig: config/models.json', () => {
  it('модели Claude передаются как есть, модель расшифровки уходит в voice, лишние поля не мешают', () => {
    const models = {
      reply: 'claude-sonnet-5',
      review: 'claude-haiku-5-5',
      interest: 'claude-3-5-haiku-20241022',
      logo: 'claude-haiku-5-5',
      transcribe: 'openai/whisper-large-v3:free',
      comment: 'черновик',
    };

    const { config } = load({ OPENROUTER_API_KEY: OPENROUTER_KEY }, models);

    expect(config.models).toEqual({
      reply: 'claude-sonnet-5',
      review: 'claude-haiku-5-5',
      interest: 'claude-3-5-haiku-20241022',
      logo: 'claude-haiku-5-5',
    });
    expect(config.voice?.model).toBe('openai/whisper-large-v3:free');
  });

  it.each([undefined, null, 'claude-haiku-5-5', [], 42])(
    'не объект (%s) отклоняется с названием файла',
    (models) => {
      expect(modelProblems(models)).toEqual([expect.stringMatching(/^config\/models\.json: /)]);
    },
  );

  it.each(['interest', 'transcribe'])('отсутствующая модель %s названа по ключу', (key) => {
    const problems = modelProblems({ ...MODELS, [key]: undefined });

    expect(problems).toEqual([expect.stringMatching(`^config/models\\.json: ${key}: `)]);
  });

  it.each(['', '   ', 'elevenlabs/ scribe-v2', 42, null])(
    'модель расшифровки %j отклоняется: нужна непустая строка без пробелов',
    (model) => {
      const problems = modelProblems({ ...MODELS, transcribe: model });

      expect(problems).toEqual([expect.stringMatching(/^config\/models\.json: transcribe: /)]);
    },
  );

  it.each(['gpt-4o', '', 'Claude-Haiku', 'claude haiku', 'claude-', 42])(
    'ID модели не Claude отклоняется: %s',
    (model) => {
      const problems = modelProblems({ ...MODELS, review: model });

      expect(problems).toEqual([expect.stringMatching(/^config\/models\.json: review: /)]);
    },
  );
});

describe('config/env loadConfig: переменные SDK Anthropic', () => {
  it.each(['ANTHROPIC_CUSTOM_HEADERS', 'anthropic_custom_headers'])(
    '%s в окружении: отказ в запуске без показа значения',
    (name) => {
      const problems = problemsOf({ [name]: `X-Api-Key: ${SECRET_KEY}` });

      expect(problems).toEqual([expect.stringMatching(/^ANTHROPIC_CUSTOM_HEADERS: /)]);
      expect(problems.join('\n')).not.toContain(SECRET_KEY);
    },
  );

  it('пустая ANTHROPIC_CUSTOM_HEADERS считается незаданной', () => {
    expect(() => load({ ANTHROPIC_CUSTOM_HEADERS: ' ' })).not.toThrow();
  });

  it.each(['ANTHROPIC_BASE_URL', 'Anthropic_Base_Url'])(
    '%s в окружении: только предупреждение, без адреса',
    (name) => {
      const { warnings } = load({ [name]: 'https://proxy.example.com', TEST_ALLOWLIST: PHONE_A });

      expect(warnings).toEqual([expect.stringContaining('ANTHROPIC_BASE_URL')]);
      expect(warnings.join('\n')).not.toContain('proxy.example.com');
    },
  );
});

describe('config/env loadConfig: ошибки', () => {
  it('все проблемы собираются сразу, по одной на переменную', () => {
    const problems = problemsOf(
      { MANAGER_WHATSAPP: 'нет', PANEL_PORT: '0', TEST_ALLOWLIST: '123' },
      { ...MODELS, reply: 'gpt-4o' },
    );

    expect(problems).toHaveLength(4);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^MANAGER_WHATSAPP: /),
        expect.stringMatching(/^PANEL_PORT: /),
        expect.stringMatching(/^TEST_ALLOWLIST: /),
        expect.stringMatching(/^config\/models\.json: reply: /),
      ]),
    );
  });

  it('ни проблемы, ни текст ошибки не содержат ключей и номеров', () => {
    let failure: unknown = null;
    try {
      load({
        VENMART_ANTHROPIC_KEY: SECRET_KEY,
        OPENROUTER_API_KEY: OPENROUTER_KEY,
        MANAGER_WHATSAPP: `+${PHONE_A}`,
        PANEL_PORT: 'x',
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ConfigError);
    const error = failure as ConfigError;
    const visible = `${error.message}\n${error.problems.join('\n')}`;
    expect(visible).not.toContain(SECRET_KEY);
    expect(visible).not.toContain(OPENROUTER_KEY);
    expect(visible).not.toContain(PHONE_A);
  });
});
