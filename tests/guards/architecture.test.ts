import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SRC = join(ROOT, 'src');

// Внешняя библиотека подключается только в своей папке-адаптере.
// Остальной код работает через интерфейсы из src/domain и тестируется на моках.
const BOUNDARIES: Readonly<Record<string, string>> = {
  baileys: 'src/whatsapp/',
  '@anthropic-ai/sdk': 'src/llm/',
  'better-sqlite3': 'src/db/',
  fastify: 'src/panel/',
};

const ENV_READERS = ['src/config/', 'src/cli.ts'];

interface SourceFile {
  path: string;
  text: string;
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return entry.name.endsWith('.ts') ? [relative(ROOT, full).split(sep).join('/')] : [];
  });
}

const sources: readonly SourceFile[] = existsSync(SRC)
  ? listSourceFiles(SRC).map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }))
  : [];

function importedModules(text: string): string[] {
  const pattern = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
  return [...text.matchAll(pattern)].map((match) => match[1] ?? '');
}

function violationsOf(check: (file: SourceFile) => string[]): string[] {
  return sources.flatMap(check);
}

describe('архитектура src', () => {
  it('внешние библиотеки подключаются только в своих адаптерах', () => {
    const violations = violationsOf(({ path, text }) =>
      importedModules(text).flatMap((specifier) =>
        Object.entries(BOUNDARIES)
          .filter(([pkg, home]) => {
            const isPackage = specifier === pkg || specifier.startsWith(`${pkg}/`);
            return isPackage && !path.startsWith(home);
          })
          .map(([pkg, home]) => `${path}: ${pkg} можно только в ${home}`),
      ),
    );
    expect(violations).toEqual([]);
  });

  it('process.env читается только в src/config и src/cli.ts', () => {
    const violations = violationsOf(({ path, text }) => {
      const readsEnv = /process\.env|\benv\b[^;]*=\s*process\b/.test(text);
      const allowed = ENV_READERS.some((reader) => path.startsWith(reader));
      return readsEnv && !allowed ? [path] : [];
    });
    expect(violations).toEqual([]);
  });

  it('стандартная переменная ключа SDK не встречается: ключ только из VENMART_ANTHROPIC_KEY', () => {
    const violations = violationsOf(({ path, text }) =>
      text.includes('ANTHROPIC_API_KEY') ? [path] : [],
    );
    expect(violations).toEqual([]);
  });

  it('модули экспортируют только именованное: без export default', () => {
    const violations = violationsOf(({ path, text }) =>
      /export\s+default\b/.test(text) ? [path] : [],
    );
    expect(violations).toEqual([]);
  });
});
