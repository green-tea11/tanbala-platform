import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Шаблон .env: блок API консоли закрыт комментарием, как блок связи с почтовым проектом. Значения по умолчанию он не
// меняет: без WA_CONSOLE_TOKEN API консоли не запускается. Ключи шаблона сверяет env-example.test.ts.

const EXAMPLE_PATH = new URL('../../.env.example', import.meta.url);

describe('.env.example: API консоли', () => {
  const text = readFileSync(EXAMPLE_PATH, 'utf8');

  it('закрытый блок с токеном и портом по умолчанию', () => {
    expect(text).toMatch(/^# WA_CONSOLE_TOKEN=$/m);
    expect(text).toMatch(/^# CONSOLE_API_PORT=3101$/m);
    expect(text).not.toMatch(/^WA_CONSOLE_TOKEN=|^CONSOLE_API_PORT=/m);
  });

  it('объясняет правила: только 127.0.0.1, токен не равен INTERNAL_API_TOKEN, порт не равен PANEL_PORT', () => {
    expect(text).toMatch(/^# Внутренний API для единой панели .*только на 127\.0\.0\.1/m);
    expect(text).toMatch(/^# совпадать с INTERNAL_API_TOKEN нельзя/m);
    expect(text).toMatch(/^# CONSOLE_API_PORT: .*не равен PANEL_PORT/m);
  });
});
