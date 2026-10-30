import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { WaMessageId } from '../../src/domain/types.js';
import { main, type MainOptions, type RunningApp } from '../../src/main.js';
import type {
  ConsoleApiApp,
  ConsoleApiStarter,
  PanelStarter,
} from '../../src/pipeline/panel-setup.js';
import type { WhatsAppConnection, WhatsAppDeps } from '../../src/whatsapp/connection.js';
import { ROOT as PROJECT_ROOT } from '../helpers/source-files.js';

// main с WA_CONSOLE_TOKEN: API консоли собирается из тех же служб, стартует после панели и закрывается первым,
// состояние WhatsApp приходит из событий сокета через WhatsAppDeps.onConnectionUpdate. Порт не занимается (швы).

const TOKEN = 'console-secret-0123456789-abcdefghij';
const CONSOLE_HOST = '127.0.0.1:3101';
const BASE_ENV = { TEST_MODE: 'true', TEST_ALLOWLIST: '77000000002', WA_CONSOLE_TOKEN: TOKEN };

interface Run {
  readonly app: RunningApp;
  readonly consoleApp: () => ConsoleApiApp;
  readonly order: string[];
  readonly logs: string[];
  readonly whatsappDeps: () => WhatsAppDeps;
}

function fakeConnection(): WhatsAppConnection {
  return {
    newMessageId: () => 'OUT-1' as WaMessageId,
    sendText: () => Promise.resolve(),
    setTyping: () => Promise.resolve(),
    markRead: () => Promise.resolve(),
    downloadAudio: () => Promise.reject(new Error('нет')),
    resolvePhone: () => Promise.resolve(null),
    businessProfile: () => Promise.resolve({ kind: 'failed' }),
    profilePhoto: () => Promise.resolve(null),
    stop: () => Promise.resolve(),
  };
}

async function run(
  env: Readonly<Record<string, string>>,
  extra: Partial<MainOptions> = {},
): Promise<Run> {
  const root = mkdtempSync(join(tmpdir(), 'tanbala-main-console-'));
  mkdirSync(join(root, 'config'));
  mkdirSync(join(root, 'data'));
  copyFileSync(join(PROJECT_ROOT, 'config', 'models.json'), join(root, 'config', 'models.json'));
  const order: string[] = [];
  const logs: string[] = [];
  let consoleApp: ConsoleApiApp | null = null;
  let whatsappDeps: WhatsAppDeps | null = null;
  const startPanel = vi.fn<PanelStarter>((app) => {
    order.push('panel');
    app.addHook('onClose', () => {
      order.push('panel:close');
      return Promise.resolve();
    });
    return Promise.resolve();
  });
  const startConsoleApi = vi.fn<ConsoleApiStarter>((app, port) => {
    order.push(`console:${String(port)}`);
    consoleApp = app;
    app.addHook('onClose', () => {
      order.push('console:close');
      return Promise.resolve();
    });
    return Promise.resolve();
  });
  const app = await main({
    env,
    root,
    logDestination: { write: (line) => void logs.push(line) },
    startPanel,
    startConsoleApi,
    startWhatsApp: (deps) => {
      whatsappDeps = deps;
      order.push('whatsapp');
      return Promise.resolve(fakeConnection());
    },
    ...extra,
  });
  onTestFinished(async () => {
    await app.stop();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    app,
    order,
    logs,
    consoleApp: () => {
      if (consoleApp === null) throw new Error('API консоли не запускался');
      return consoleApp;
    },
    whatsappDeps: () => {
      if (whatsappDeps === null) throw new Error('WhatsApp не запускался');
      return whatsappDeps;
    },
  };
}

async function status(r: Run): Promise<Record<string, unknown>> {
  const response = await r.consoleApp().inject({
    url: '/internal/console/status',
    headers: { host: CONSOLE_HOST, 'x-console-token': TOKEN },
  });
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body) as Record<string, unknown>;
}

describe('main: API консоли', () => {
  it('WhatsApp включён: порядок запуска WhatsApp, панель, консоль; состояние сокета из его событий', async () => {
    const r = await run({ ...BASE_ENV, WA_ENABLED: 'true' });

    expect(r.order).toEqual(['whatsapp', 'panel', 'console:3101']);
    expect((await status(r))['whatsapp']).toMatchObject({ enabled: true, state: 'connecting' });
    r.whatsappDeps().onConnectionUpdate?.('open');
    expect((await status(r))['whatsapp']).toMatchObject({ enabled: true, state: 'open' });
    r.whatsappDeps().onConnectionUpdate?.('closed');
    expect((await status(r))['whatsapp']).toMatchObject({ state: 'closed' });
    expect(r.logs.join('')).not.toContain(TOKEN);
  });

  it('WhatsApp выключен: состояние disabled, чтение из настоящей базы', async () => {
    const r = await run({ ...BASE_ENV, WA_ENABLED: 'false' });

    const body = await status(r);
    const chats = await r.consoleApp().inject({
      url: '/internal/console/chats?waiting=1',
      headers: { host: CONSOLE_HOST, 'x-console-token': TOKEN },
    });

    expect(body).toMatchObject({
      whatsapp: { enabled: false, state: 'disabled', since: null },
      testMode: true,
      allowlistSize: 1,
      apiCalls: { today: 0, dailyLimit: 500, perChatLimit: 100 },
    });
    expect(JSON.parse(chats.body)).toEqual({
      items: [],
      total: 0,
      page: 1,
      pages: 1,
      pageSize: 30,
    });
  });

  it('остановка: сначала API консоли, затем панель', async () => {
    const r = await run({ ...BASE_ENV, WA_ENABLED: 'false' });

    await r.app.stop();

    expect(r.order.slice(-2)).toEqual(['console:close', 'panel:close']);
  });

  it('без WA_CONSOLE_TOKEN API консоли не запускается', async () => {
    const startConsoleApi = vi.fn<ConsoleApiStarter>(() => Promise.resolve());
    const r = await run({ TEST_MODE: 'true', WA_ENABLED: 'false' }, { startConsoleApi });

    expect(startConsoleApi).not.toHaveBeenCalled();
    expect(r.order).toEqual(['panel']);
  });
});
