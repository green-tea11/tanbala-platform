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

  it('ошибки вывода в закрытый терминал (EIO, EPIPE) и брошенная строка лога (EAGAIN, EBUSY) не прерывают остановку', () => {
    expect(CLI).toMatch(
      /code === 'EIO' \|\| code === 'EPIPE' \|\| code === 'EAGAIN' \|\| code === 'EBUSY'/,
    );
    expect(CLI).toMatch(/if \(!isLostOutput\(error\)\) exitWithError\(error\)/);
  });

  it('лог пишет в stdout с ограниченным ожиданием, SIGHUP снимает ожидание вывода (проверка на сервере 30.10.2026)', () => {
    expect(CLI).toContain("process.on('SIGHUP', output.hangUp);");
    expect(CLI).toMatch(
      /main\(\{ env: loadEnvironment\(root, process\.env\), root, logDestination \}\)/,
    );
  });
});
