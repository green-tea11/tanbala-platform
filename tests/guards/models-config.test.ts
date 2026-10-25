import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = JSON.parse(
  readFileSync(new URL('../../config/models.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('config/models.json', () => {
  it('задаёт модели ровно для трёх вызовов: ответ, проверка, интерес', () => {
    expect(Object.keys(config).sort()).toEqual(['interest', 'reply', 'review']);
  });

  it.each(['reply', 'review', 'interest'])(
    'модель для вызова %s похожа на ID Claude',
    (purpose) => {
      expect(config[purpose]).toMatch(/^claude-[a-z0-9-]+$/);
    },
  );
});
