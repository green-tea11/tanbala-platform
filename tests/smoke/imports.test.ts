import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listTsFiles, SRC } from '../helpers/source-files.js';

// Побочный эффект при импорте разрешён только точке входа cli.ts.
const ENTRY_POINT = 'cli.ts';

const modules = listTsFiles(SRC).filter((path) => path !== ENTRY_POINT);

describe('импорт модулей src', () => {
  it('находит модули заготовок, включая ключевые', () => {
    expect(modules).toEqual(
      expect.arrayContaining([
        'main.ts',
        'shared/todo.ts',
        'whatsapp/connection.ts',
        'llm/anthropic.ts',
        'panel/server.ts',
      ]),
    );
  });

  // Сеть заблокирована в tests/setup/no-network.ts: попытка подключиться при импорте уронит тест.
  it.each(modules)('%s импортируется без сети и без ошибок', async (path) => {
    await expect(import(pathToFileURL(join(SRC, path)).href)).resolves.toBeDefined();
  });
});
