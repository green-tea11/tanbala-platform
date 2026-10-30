import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { acquireProcessLock } from '../../src/db/process-lock.js';
import type { WaMessageId } from '../../src/domain/types.js';
import { main } from '../../src/main.js';
import {
  ConsoleApiStartError,
  type ConsoleApiStarter,
  type PanelStarter,
} from '../../src/pipeline/panel-setup.js';
import type { WhatsAppConnection } from '../../src/whatsapp/connection.js';
import { ROOT as PROJECT_ROOT } from '../helpers/source-files.js';

// main с WA_CONSOLE_TOKEN, а порт API консоли занят (или listen отказал): бот останавливается целиком, как при занятом
// порте панели, и ошибка всплывает в cli.ts (код выхода 1, служба перезапустит). Токен в лог не попадает.

const TOKEN = 'console-secret-0123456789-abcdefghij';
const ERROR = 50;

function fakeConnection(stop: () => Promise<void>): WhatsAppConnection {
  return {
    newMessageId: () => 'OUT-1' as WaMessageId,
    sendText: () => Promise.resolve(),
    setTyping: () => Promise.resolve(),
    markRead: () => Promise.resolve(),
    downloadAudio: () => Promise.reject(new Error('нет')),
    resolvePhone: () => Promise.resolve(null),
    businessProfile: () => Promise.resolve({ kind: 'failed' }),
    profilePhoto: () => Promise.resolve(null),
    stop,
  };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tanbala-main-console-port-'));
  mkdirSync(join(root, 'config'));
  mkdirSync(join(root, 'data'));
  copyFileSync(join(PROJECT_ROOT, 'config', 'models.json'), join(root, 'config', 'models.json'));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

describe('main: порт API консоли занят', () => {
  it('бот останавливается целиком: панель закрыта, WhatsApp остановлен, замок снят, ошибка всплывает', async () => {
    const root = tempRoot();
    const logs: string[] = [];
    const panelClosed = vi.fn();
    const startPanel = vi.fn<PanelStarter>((app) => {
      app.addHook('onClose', () => {
        panelClosed();
        return Promise.resolve();
      });
      return Promise.resolve();
    });
    const busy = Object.assign(new Error('listen EADDRINUSE: address already in use'), {
      code: 'EADDRINUSE',
    });
    const startConsoleApi = vi.fn<ConsoleApiStarter>(() => Promise.reject(busy));
    const stop = vi.fn(() => Promise.resolve());

    const error: unknown = await main({
      env: { TEST_MODE: 'true', WA_ENABLED: 'true', WA_CONSOLE_TOKEN: TOKEN },
      root,
      logDestination: { write: (line) => void logs.push(line) },
      startPanel,
      startConsoleApi,
      startWhatsApp: () => Promise.resolve(fakeConnection(stop)),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConsoleApiStartError);
    expect(startConsoleApi).toHaveBeenCalledWith(expect.anything(), 3101);
    expect(panelClosed).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    // Замок свободен: следующий запуск (перезапуск службой) его возьмёт.
    acquireProcessLock(join(root, 'data', 'process.lock')).release();
    const records = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toContainEqual(
      expect.objectContaining({
        level: ERROR,
        errorName: 'ConsoleApiStartError',
        msg: expect.stringContaining(
          'API консоли не запустился на 127.0.0.1:3101 (EADDRINUSE): бот остановлен',
        ) as string,
      }),
    );
    expect(logs.join('')).not.toContain(TOKEN);
  });
});
