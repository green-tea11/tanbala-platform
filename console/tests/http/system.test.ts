import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLACEHOLDER_PAGE } from '../../src/server/static.js';
import { leadsSpend, leadsSummary, waSpend, waStatus } from '../helpers/fixtures.js';
import type { AuditBody, SessionsBody, SpendReportBody, SystemBody } from '../helpers/bodies.js';
import { harnessPerTest } from '../helpers/harness.js';

const start = harnessPerTest();

describe('«Система» (только владелец)', () => {
  it('состояние бота и почты', async () => {
    const harness = await start();
    harness.backends.on('GET wa:/status', waStatus());
    harness.backends.on('GET leads:/summary', leadsSummary());
    const session = await harness.signIn('owner', 'owner');
    const body = (await harness.request('GET', '/api/system', { session })).json<SystemBody>();
    expect(body.botStatus.apiCalls).toEqual({ today: 12, dailyLimit: 500, perChatLimit: 100 });
    expect(body.leadsSummary.testSends).toEqual({ today: 0, perDay: 30 });
  });

  it('расход по дням: период по умолчанию 30 дней, деньги по таблице цен почты', async () => {
    const harness = await start();
    harness.backends.on('GET leads:/spend', leadsSpend());
    harness.backends.on('GET wa:/spend', waSpend());
    const session = await harness.signIn('owner', 'owner');
    const body = (
      await harness.request('GET', '/api/system/spend', { session })
    ).json<SpendReportBody>();
    expect(body.from).toBe('2026-10-01');
    expect(body.to).toBe('2026-10-30');
    expect(body.leads.days.map((day) => [day.day, day.usd])).toEqual([
      ['2026-10-02', 0.1],
      ['2026-10-30', 0.00055],
    ]);
    expect(body.leads.total.usd).toBe(0.10055);
    expect(body.bot.total).toEqual({
      usd: 0.003,
      tokens: 1200,
      unpricedTokens: 100,
      calls: 3,
      notCountedCalls: 4,
    });
    expect(body.prices['claude-haiku-5-5']).toBeDefined();
  });

  it('расход: период больше 62 дней или перевёрнутый — 400', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    for (const query of ['from=2026-01-01&to=2026-10-30', 'from=2026-10-30&to=2026-10-01']) {
      const response = await harness.request('GET', `/api/system/spend?${query}`, { session });
      expect(response.statusCode).toBe(400);
    }
    expect(harness.backends.calls).toEqual([]);
  });

  it('журнал действий по страницам, свежие сверху', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    for (let index = 0; index < 55; index += 1) {
      harness.context.record({ actor: 'owner', action: `test_${index}` });
    }
    const first = (
      await harness.request('GET', '/api/system/audit', { session })
    ).json<AuditBody>();
    expect(first).toMatchObject({ total: 56, page: 1, pages: 2, pageSize: 50 });
    expect(first.items[0]?.action).toBe('test_54');
    expect(first.items[0]?.at).toBe('2026-10-30T06:00:00.000Z');
    const second = (
      await harness.request('GET', '/api/system/audit?page=2', { session })
    ).json<AuditBody>();
    expect(second.items).toHaveLength(6);
  });

  it('пользователи только для чтения: без хэшей паролей, с числом сессий', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    await harness.addUser('aigerim', 'manager');
    const response = await harness.request('GET', '/api/system/users', { session });
    expect(response.json()).toEqual({
      items: [
        {
          name: 'aigerim',
          role: 'manager',
          active: true,
          createdAt: '2026-10-30T06:00:00.000Z',
          updatedAt: '2026-10-30T06:00:00.000Z',
          sessions: 0,
        },
        {
          name: 'owner',
          role: 'owner',
          active: true,
          createdAt: '2026-10-30T06:00:00.000Z',
          updatedAt: '2026-10-30T06:00:00.000Z',
          sessions: 1,
        },
      ],
    });
    expect(response.body).not.toContain('scrypt');
  });

  it('сессии: список с устройством и IP, закрыть одну, «выйти везде» кроме текущей', async () => {
    const harness = await start();
    const owner = await harness.signIn('owner', 'owner');
    await harness.addUser('aigerim', 'manager');
    const manager = await harness.login('aigerim', undefined, {
      'user-agent': 'Телефон\u0000 Android',
    });
    const other = await harness.login('owner');
    const list = (
      await harness.request('GET', '/api/system/sessions', { session: owner })
    ).json<SessionsBody>();
    expect(list.items).toHaveLength(3);
    const managerRow = list.items.find((item) => item.user === 'aigerim');
    if (managerRow === undefined) throw new Error('нет сессии менеджера');
    expect(managerRow).toMatchObject({
      role: 'manager',
      device: 'Телефон Android',
      ip: '127.0.0.1',
    });
    expect(list.items.filter((item) => item.current)).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(owner.csrf);

    const revoke = await harness.request('POST', `/api/system/sessions/${managerRow.id}/revoke`, {
      session: owner,
    });
    expect(revoke.json()).toEqual({ result: 'revoked', message: 'Сессия закрыта.' });
    expect((await harness.request('GET', '/api/session', { session: manager })).statusCode).toBe(
      403,
    );
    const again = await harness.request('POST', `/api/system/sessions/${managerRow.id}/revoke`, {
      session: owner,
    });
    expect(again.statusCode).toBe(404);

    const all = await harness.request('POST', '/api/system/sessions/revoke-all', {
      session: owner,
    });
    expect(all.json()).toMatchObject({ result: 'revoked', count: 1 });
    expect((await harness.request('GET', '/api/session', { session: other })).statusCode).toBe(403);
    expect((await harness.request('GET', '/api/session', { session: owner })).statusCode).toBe(200);
    const actions = harness.context.audit.page(1, 3).items.map((item) => item.action);
    expect(actions).toEqual(['session_revoke_all', 'session_revoke', 'session_revoke']);
  });
});

describe('статика интерфейса', () => {
  let webDist = '';

  beforeAll(() => {
    webDist = mkdtempSync(join(tmpdir(), 'console-web-'));
    mkdirSync(join(webDist, 'assets'));
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>SPA</title>');
    writeFileSync(join(webDist, 'assets', 'app-1a2b.js'), 'console.log(1)');
    writeFileSync(join(webDist, 'favicon.svg'), '<svg/>');
    writeFileSync(join(webDist, 'notes.exe'), 'MZ');
  });

  afterAll(() => {
    rmSync(webDist, { recursive: true, force: true });
  });

  it('index.html без сессии на любой адрес экрана, no-store', async () => {
    const harness = await start({ staticDir: webDist });
    for (const url of ['/', '/chats/12', '/leads/companies/5?x=1']) {
      const response = await harness.request('GET', url);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toBe('<!doctype html><title>SPA</title>');
    }
  });

  it('/assets/* — immutable, тип по таблице; неизвестный тип и выход из папки — 404', async () => {
    const harness = await start({ staticDir: webDist });
    const asset = await harness.request('GET', '/assets/app-1a2b.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const icon = await harness.request('GET', '/favicon.svg');
    expect(icon.headers['content-type']).toBe('image/svg+xml');
    expect(icon.headers['cache-control']).toBe('no-store');
    for (const url of [
      '/notes.exe',
      '/assets/missing.js',
      '/assets/..%2F..%2Fpackage.json',
      '/%2e%2e/package.json',
      '/assets%5c..%5cindex.html',
      '/internal/console/status',
    ]) {
      const response = await harness.request('GET', url);
      expect({ url, status: response.statusCode }).toEqual({ url, status: 404 });
    }
  });

  it('ссылка за пределы папки не отдаётся', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'console-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'секрет');
    try {
      symlinkSync(join(outside, 'secret.txt'), join(webDist, 'link.txt'));
    } catch {
      rmSync(outside, { recursive: true, force: true });
      return; // На Windows без прав ссылки не создаются: проверка только там, где можно.
    }
    const harness = await start({ staticDir: webDist });
    const response = await harness.request('GET', '/link.txt');
    expect(response.statusCode).toBe(404);
    rmSync(outside, { recursive: true, force: true });
  });

  it('нет web/dist: страница-заглушка; неизвестный /api — 403 без сессии и 404 с сессией', async () => {
    const harness = await start();
    const page = await harness.request('GET', '/');
    expect(page.body).toBe(PLACEHOLDER_PAGE);
    expect((await harness.request('GET', '/api/nope')).statusCode).toBe(403);
    const session = await harness.signIn('owner', 'owner');
    expect((await harness.request('GET', '/api/nope', { session })).statusCode).toBe(404);
    expect((await harness.request('POST', '/api/nope', { session })).statusCode).toBe(404);
    expect((await harness.request('POST', '/nope')).statusCode).toBe(404);
  });
});
