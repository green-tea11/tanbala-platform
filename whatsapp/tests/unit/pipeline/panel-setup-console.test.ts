import { describe, expect, it, vi, type Mock } from 'vitest';
import { createAppStateRepo } from '../../../src/db/repos/app-state.js';
import { createChatCompaniesRepo } from '../../../src/db/repos/chat-companies.js';
import { createChatsRepo } from '../../../src/db/repos/chats.js';
import { createConsoleReads } from '../../../src/db/repos/console-details.js';
import { createHandoffsRepo } from '../../../src/db/repos/handoffs.js';
import { createManagerNotificationsRepo } from '../../../src/db/repos/manager-notifications.js';
import { createMessagesRepo } from '../../../src/db/repos/messages.js';
import { createRejectedDraftsRepo } from '../../../src/db/repos/rejected-drafts.js';
import type { Clock } from '../../../src/domain/ports.js';
import type { PhoneDigits } from '../../../src/domain/types.js';
import type { HandoffService } from '../../../src/handoff/handoff.js';
import type { Outbox } from '../../../src/messaging/outbox.js';
import {
  assemblePanel,
  type ConsoleApiApp,
  type ConsoleApiStarter,
  type PanelApp,
  type PanelConfig,
  type PanelSetupContext,
  type PanelStarter,
} from '../../../src/pipeline/panel-setup.js';
import { createWhatsAppStateTracker } from '../../../src/pipeline/whatsapp-state.js';
import { createLogger } from '../../../src/shared/logger.js';
import { PN_A, useMigratedDb } from '../db/fixture.js';
import { csrfOf, OFF_COMPANY, sessionCookieOf } from '../panel/harness.js';

// Сборка панели с API консоли: запуск и остановка вместе с панелью, одно окно дубля, без токена консоли нет.

const TOKEN = 'console-secret-0123456789-abcdefghij';
const PANEL_PORT = 3187;
const CONSOLE_PORT = 3188;
const T0 = Date.UTC(2026, 9, 30, 10, 0);
const PANEL_HOST = `127.0.0.1:${PANEL_PORT}`;
const CONSOLE_HOST = `127.0.0.1:${CONSOLE_PORT}`;

const BASE_CONFIG: PanelConfig = {
  adminPassword: 'admin',
  panel: { host: '127.0.0.1', port: PANEL_PORT, allowedHosts: [] },
  waEnabled: true,
  testMode: { enabled: true, allowlist: new Set(['77000000001' as PhoneDigits]) },
  managerPhone: null,
  companyApi: null,
  anthropicKey: null,
  limits: { apiCallsPerDay: 500, apiCallsPerChatPerDay: 100 },
  tokenLogPath: 'нет-такого-файла.jsonl',
};

interface Setup {
  readonly context: PanelSetupContext;
  readonly startPanel: Mock<PanelStarter>;
  readonly startConsoleApi: Mock<ConsoleApiStarter>;
  readonly events: string[];
  readonly lines: string[];
  readonly outbox: {
    canSendFromPanel: Mock<Outbox['canSendFromPanel']>;
    sendFromPanel: Mock<Outbox['sendFromPanel']>;
  };
  readonly tracker: ReturnType<typeof createWhatsAppStateTracker>;
  panel(): PanelApp;
  console(): ConsoleApiApp;
}

function setup(config: Partial<PanelConfig> = {}): Setup {
  const db = useMigratedDb();
  const chats = createChatsRepo(db);
  chats.upsertByIdentity({ replyJid: PN_A, lidJid: null, pnJid: PN_A }, 'Алия', T0);
  const lines: string[] = [];
  const logger = createLogger({
    level: 'info',
    destination: { write: (line) => void lines.push(line) },
  });
  const clock: Clock = { now: () => T0, sleep: () => Promise.resolve() };
  const events: string[] = [];
  let panelApp: PanelApp | null = null;
  let consoleApp: ConsoleApiApp | null = null;
  const startPanel = vi.fn<PanelStarter>((app) => {
    panelApp = app;
    events.push('panel:start');
    app.addHook('onClose', () => {
      events.push('panel:close');
      return Promise.resolve();
    });
    return Promise.resolve();
  });
  const startConsoleApi = vi.fn<ConsoleApiStarter>((app) => {
    consoleApp = app;
    events.push('console:start');
    app.addHook('onClose', () => {
      events.push('console:close');
      return Promise.resolve();
    });
    return Promise.resolve();
  });
  const outbox = {
    canSendFromPanel: vi.fn<Outbox['canSendFromPanel']>(() => true),
    sendFromPanel: vi.fn<Outbox['sendFromPanel']>(() => Promise.resolve('sent' as const)),
  };
  const handoff: HandoffService = {
    handOff: vi.fn(() => Promise.resolve()),
    returnToBot: vi.fn(() => Promise.resolve()),
  };
  const tracker = createWhatsAppStateTracker(clock);
  const context: PanelSetupContext = {
    config: { ...BASE_CONFIG, ...config },
    logger,
    clock,
    storage: {
      chats,
      messages: createMessagesRepo(db),
      handoffs: createHandoffsRepo(db),
      notifications: createManagerNotificationsRepo(db),
      rejectedDrafts: createRejectedDraftsRepo(db),
      appState: createAppStateRepo(db),
      chatCompanies: createChatCompaniesRepo(db, logger),
      consoleReads: createConsoleReads(db),
    },
    services: { outbox: outbox as unknown as Outbox, handoff },
    company: { summary: () => OFF_COMPANY },
    startPanel,
    whatsappState: tracker,
    startConsoleApi,
  };
  return {
    context,
    startPanel,
    startConsoleApi,
    events,
    lines,
    outbox,
    tracker,
    panel: () => {
      if (panelApp === null) throw new Error('Панель не запускалась');
      return panelApp;
    },
    console: () => {
      if (consoleApp === null) throw new Error('API консоли не запускался');
      return consoleApp;
    },
  };
}

const WITH_CONSOLE: Partial<PanelConfig> = { consoleApi: { token: TOKEN, port: CONSOLE_PORT } };

function consoleGet(app: ConsoleApiApp, url: string) {
  return app.inject({ url, headers: { host: CONSOLE_HOST, 'x-console-token': TOKEN } });
}

describe('assemblePanel: API консоли', () => {
  it('без WA_CONSOLE_TOKEN API консоли не собирается и не запускается', async () => {
    const s = setup();
    const panel = assemblePanel(s.context);

    await panel.start();
    await panel.close();

    expect(s.startPanel).toHaveBeenCalledTimes(1);
    expect(s.startConsoleApi).not.toHaveBeenCalled();
    expect(s.events).toEqual(['panel:start', 'panel:close']);
  });

  it('с токеном: запуск после панели на своём порту, лог без токена; остановка: сначала консоль, потом панель', async () => {
    const s = setup(WITH_CONSOLE);
    const panel = assemblePanel(s.context);

    await panel.start();
    await panel.close();
    await panel.close();

    expect(s.startConsoleApi).toHaveBeenCalledWith(expect.anything(), CONSOLE_PORT);
    expect(s.events).toEqual(['panel:start', 'console:start', 'console:close', 'panel:close']);
    const log = s.lines.join('');
    expect(log).toContain(`API консоли запущен: 127.0.0.1:${CONSOLE_PORT}`);
    expect(log).not.toContain(TOKEN);
  });

  it('API консоли не запустился (порт занят): бот и панель работают, ошибка в логе', async () => {
    const s = setup(WITH_CONSOLE);
    s.startConsoleApi.mockRejectedValueOnce(new Error('listen EADDRINUSE'));
    const panel = assemblePanel(s.context);

    await expect(panel.start()).resolves.toBeUndefined();
    await panel.close();

    const errors = s.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((r) => r['level'] === 50);
    expect(errors).toContainEqual(
      expect.objectContaining({
        msg: expect.stringContaining('API консоли не запустился') as string,
      }),
    );
  });

  it('состояние WhatsApp по событиям сокета; при WA_ENABLED=false — disabled', async () => {
    const enabled = setup(WITH_CONSOLE);
    await assemblePanel(enabled.context).start();
    enabled.tracker.update('open');
    const disabled = setup({ ...WITH_CONSOLE, waEnabled: false });
    await assemblePanel(disabled.context).start();

    const open = JSON.parse(
      (await consoleGet(enabled.console(), '/internal/console/status')).body,
    ) as Record<string, unknown>;
    const off = JSON.parse(
      (await consoleGet(disabled.console(), '/internal/console/status')).body,
    ) as Record<string, unknown>;

    expect(open['whatsapp']).toEqual({
      enabled: true,
      state: 'open',
      since: new Date(T0).toISOString(),
    });
    expect(off['whatsapp']).toEqual({ enabled: false, state: 'disabled', since: null });
    expect(open).toMatchObject({
      testMode: true,
      allowlistSize: 1,
      managerConfigured: false,
      companyFeature: false,
      llmConfigured: false,
    });
  });

  it('одно окно дубля: ответ из старой панели, затем тот же текст из консоли — дубль', async () => {
    const s = setup(WITH_CONSOLE);
    await assemblePanel(s.context).start();
    const panel = s.panel();
    const form = 'application/x-www-form-urlencoded';
    const login = await panel.inject({
      method: 'POST',
      url: '/login',
      headers: { host: PANEL_HOST, origin: `http://${PANEL_HOST}`, 'content-type': form },
      payload: 'password=admin',
    });
    const cookie = sessionCookieOf(login) ?? '';
    const csrf = csrfOf(
      (await panel.inject({ url: '/chats', headers: { host: PANEL_HOST, cookie } })).body,
    );
    await panel.inject({
      method: 'POST',
      url: '/chats/1/reply',
      headers: { host: PANEL_HOST, origin: `http://${PANEL_HOST}`, cookie, 'content-type': form },
      payload: new URLSearchParams({ csrf, text: 'Добрый день' }).toString(),
    });

    const json = await s.console().inject({
      method: 'POST',
      url: '/internal/console/chats/1/reply',
      headers: {
        host: CONSOLE_HOST,
        'x-console-token': TOKEN,
        'x-console-user': 'owner',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ text: 'Добрый день' }),
    });

    expect(JSON.parse(json.body)).toEqual({ result: 'duplicate' });
    expect(s.outbox.sendFromPanel).toHaveBeenCalledTimes(1);
  });
});
