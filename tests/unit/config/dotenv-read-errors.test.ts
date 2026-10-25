import { describe, expect, it, vi } from 'vitest';
import { loadEnvironment } from '../../../src/config/dotenv.js';
import { ConfigError } from '../../../src/config/errors.js';

// Ошибки чтения, которые не воспроизвести на настоящей файловой системе: readFileSync подменён.
const readFileSync = vi.hoisted(() => vi.fn<(path: string, encoding: string) => string>());

vi.mock('node:fs', () => ({ readFileSync }));

const SECRET_IN_MESSAGE = "EACCES: permission denied, open '/home/owner/.env' sk-ant-secret";

function problemsOnRead(failure: unknown): readonly string[] {
  readFileSync.mockImplementation(() => {
    throw failure;
  });
  let caught: unknown = null;
  try {
    loadEnvironment('/srv/tanbala', {});
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  return (caught as ConfigError).problems;
}

describe('config/dotenv loadEnvironment: ошибки чтения .env', () => {
  it('показывает код ошибки, но не её текст (в нём путь и что угодно ещё)', () => {
    const problems = problemsOnRead(
      Object.assign(new Error(SECRET_IN_MESSAGE), { code: 'EACCES' }),
    );

    expect(problems).toEqual(['.env: файл не читается (EACCES)']);
  });

  it('ошибка без кода: общая причина без текста', () => {
    const problems = problemsOnRead(new Error(SECRET_IN_MESSAGE));

    expect(problems).toEqual(['.env: файл не читается (неизвестная ошибка)']);
  });

  it('файла нет (ENOENT): пустой набор, без ошибки', () => {
    readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    expect(loadEnvironment('/srv/tanbala', { A: '1' })).toEqual({ A: '1' });
  });
});
