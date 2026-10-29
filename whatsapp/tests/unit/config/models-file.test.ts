import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../../src/config/errors.js';
import { readModelsJson } from '../../../src/config/models-file.js';
import { ROOT as PROJECT_ROOT } from '../../helpers/source-files.js';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tanbala-models-'));
  await mkdir(join(root, 'config'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function problemsOf(run: () => unknown): readonly string[] {
  let failure: unknown = null;
  try {
    run();
  } catch (error: unknown) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ConfigError);
  return (failure as ConfigError).problems;
}

describe('config/models-file readModelsJson', () => {
  it('читает JSON из config/models.json в корне проекта', async () => {
    await writeFile(join(root, 'config', 'models.json'), '{"reply":"claude-a","n":1}');

    expect(readModelsJson(root)).toEqual({ reply: 'claude-a', n: 1 });
  });

  it('метка порядка байтов UTF-8 (Блокнот Windows) не мешает', async () => {
    const bom = String.fromCharCode(0xfeff);
    await writeFile(join(root, 'config', 'models.json'), `${bom}{"reply":"claude-a"}`);

    expect(readModelsJson(root)).toEqual({ reply: 'claude-a' });
  });

  it('файла нет: ConfigError с кодом ошибки, без пути и содержимого', () => {
    const problems = problemsOf(() => readModelsJson(root));

    expect(problems).toEqual([
      expect.stringMatching(/^config\/models\.json: файл не читается \(ENOENT\)$/),
    ]);
    expect(problems.join('')).not.toContain(root);
  });

  it('не JSON: ConfigError без текста файла', async () => {
    await writeFile(join(root, 'config', 'models.json'), '{"reply": секрет');

    const problems = problemsOf(() => readModelsJson(root));

    expect(problems).toEqual(['config/models.json: файл не в формате JSON']);
    expect(problems.join('')).not.toContain('секрет');
  });

  it('вместо файла папка: ConfigError с кодом чтения', async () => {
    await mkdir(join(root, 'config', 'models.json'));

    const problems = problemsOf(() => readModelsJson(root));

    expect(problems[0]).toMatch(/^config\/models\.json: файл не читается \(E[A-Z]+\)$/);
  });

  it.each([
    ['ошибка без кода', () => new Error('boom')],
    ['код не строка', () => Object.assign(new Error('boom'), { code: 5 })],
  ])('%s: «неизвестная ошибка», текст ошибки не показывается', (_case, makeError) => {
    const problems = problemsOf(() =>
      readModelsJson(root, () => {
        throw makeError();
      }),
    );

    expect(problems).toEqual(['config/models.json: файл не читается (неизвестная ошибка)']);
  });

  it('читает через переданное чтение: путь от корня проекта', () => {
    const paths: string[] = [];

    const data = readModelsJson(root, (path) => {
      paths.push(path);
      return '{"a":1}';
    });

    expect(data).toEqual({ a: 1 });
    expect(paths).toEqual([join(root, 'config', 'models.json')]);
  });

  it('настоящий config/models.json проекта читается', () => {
    expect(readModelsJson(PROJECT_ROOT)).toMatchObject({ reply: expect.any(String) as unknown });
  });
});
