import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../helpers/source-files.js';

// cli.ts не покрыт юнит-тестами (точка входа с побочными эффектами), поэтому сигналы проверяются по тексту.
// SIGHUP: окно терминала закрыли или SSH-сессия оборвалась во время привязки по QR (сервер, 30.10.2026).
const CLI = readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf8');

describe('cli.ts: корректная остановка по сигналам', () => {
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'])(
    '%s ведёт к app.stop, а не к мгновенному выходу',
    (signal) => {
      expect(CLI).toContain(`process.on('${signal}', onSignal);`);
    },
  );

  it('ошибки вывода в закрытый терминал (EIO, EPIPE) не прерывают остановку', () => {
    expect(CLI).toMatch(/code === 'EIO' \|\| code === 'EPIPE'/);
    expect(CLI).toMatch(/if \(!isLostOutput\(error\)\) exitWithError\(error\)/);
  });
});
