import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listTsFiles, SRC } from '../helpers/source-files.js';

// Внешняя библиотека подключается только в своей папке-адаптере.
// Остальной код работает через интерфейсы из src/domain и тестируется на моках.
const BOUNDARIES: Readonly<Record<string, string>> = {
  baileys: 'src/whatsapp/',
  '@anthropic-ai/sdk': 'src/llm/',
  'better-sqlite3': 'src/db/',
  fastify: 'src/panel/',
};

const ENV_READERS = ['src/config/', 'src/cli.ts'];

// Единая точка исходящих: вызовы отправки только в outbox и в адаптере WhatsApp.
const SENDERS = ['src/messaging/outbox.ts', 'src/whatsapp/connection.ts'];

// Точка входа одна: только она что-то запускает при импорте.
const ENTRY_POINT = 'src/cli.ts';

interface SourceFile {
  path: string;
  text: string;
}

const sources: readonly SourceFile[] = listTsFiles(SRC).map((file) => ({
  path: `src/${file}`,
  text: readFileSync(join(SRC, file), 'utf8'),
}));

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

  it('окружение читается только в src/config и src/cli.ts', () => {
    const envAccess =
      /process\.env|process\[['"]env['"]\]|\benv\b[^;]*=\s*process\b|from\s+['"](?:node:)?process['"]|loadEnvFile/;
    const violations = violationsOf(({ path, text }) => {
      const allowed = ENV_READERS.some((reader) => path.startsWith(reader));
      return envAccess.test(text) && !allowed ? [path] : [];
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

  it('сообщения отправляются только через outbox и адаптер WhatsApp', () => {
    const violations = violationsOf(({ path, text }) =>
      /\.(?:sendText|sendMessage)\(/.test(text) && !SENDERS.includes(path) ? [path] : [],
    );
    expect(violations).toEqual([]);
  });

  it('только точка входа запускает код при импорте: верхнеуровневые await и void', () => {
    const violations = violationsOf(({ path, text }) =>
      /^(?:await|void)\s/m.test(text) && path !== ENTRY_POINT ? [path] : [],
    );
    expect(violations).toEqual([]);
  });
});
