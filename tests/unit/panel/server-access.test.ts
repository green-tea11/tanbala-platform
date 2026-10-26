import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  createHarness,
  HOST_HEADER,
  makeChat,
  sessionCookieOf,
  setCookieLines,
  STRONG_PASSWORD,
  WEAK_PASSWORD,
  type Harness,
} from './harness.js';

// Правило владельца «на VPS только HTTPS»: панель принимает соединения только с этого компьютера (браузер на ПК или
// локальный Caddy), а запрос по домену из PANEL_ALLOWED_HOSTS обязан прийти по HTTPS (X-Forwarded-Proto от Caddy).

const DOMAIN = 'panel.example.kz';
const DOMAIN_ORIGIN = `https://${DOMAIN}`;
const FOREIGN_PEER = '203.0.113.5';
const FOREIGN_PEERS = [
  FOREIGN_PEER,
  '198.51.100.7',
  '10.0.0.5',
  '192.168.0.10',
  '127.0.0.2',
  '::ffff:10.0.0.5',
  '2001:db8::1',
];
/** Запрос с домена так, как его присылает Caddy по HTTPS. */
const VIA_HTTPS = {
  host: DOMAIN,
  origin: DOMAIN_ORIGIN,
  headers: { 'x-forwarded-proto': 'https' },
};

/** Отказ без подробностей: 403, простой текст, без cookie. Причину ответ не называет. */
function expectRejectedPlainly(response: LightMyRequestResponse, label: string): void {
  expect(response.statusCode, label).toBe(403);
  expect(response.headers['content-type'], label).toBe('text/plain; charset=utf-8');
  expect(response.body, label).toBe('Запрос отклонён');
  expect(setCookieLines(response), label).toEqual([]);
}

function auditActions(h: Harness): unknown[] {
  return h.logs().map((line) => line['action']);
}

describe('панель: соединение только с этого компьютера', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    'адрес сокета %s: страница входа открывается, вход работает',
    async (remoteAddress) => {
      const h = createHarness();

      const page = await h.request({ url: '/login', remoteAddress });
      const login = await h.request({
        url: '/login',
        form: { password: WEAK_PASSWORD },
        remoteAddress,
      });

      expect(page.statusCode).toBe(200);
      expect(login.statusCode).toBe(303);
    },
  );

  it.each(FOREIGN_PEERS)(
    'чужой адрес сокета %s: 403 без подробностей на входе, списке, чате, CSS и несуществующей странице',
    async (remoteAddress) => {
      const h = createHarness({ data: { chats: [makeChat(1)] } });
      const { cookie } = await h.login();
      h.chats.listForPanel.mockClear();

      for (const url of ['/login', '/chats', '/chats/1', '/panel.css', '/no-such-page']) {
        expectRejectedPlainly(await h.request({ url, cookie, remoteAddress }), url);
      }
      expect(h.chats.listForPanel).not.toHaveBeenCalled();
      expect(h.chats.getById).not.toHaveBeenCalled();
    },
  );

  it('подделанные X-Forwarded-For (127.0.0.1) и X-Forwarded-Proto чужой сокет не спасают', async () => {
    const h = createHarness();

    const response = await h.request({
      url: '/login',
      remoteAddress: FOREIGN_PEER,
      headers: { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https' },
    });

    expectRejectedPlainly(response, '/login');
  });

  it('верный пароль с чужого адреса: 403, сессия не выдаётся', async () => {
    const h = createHarness();

    const response = await h.request({
      url: '/login',
      form: { password: WEAK_PASSWORD },
      remoteAddress: FOREIGN_PEER,
    });

    expectRejectedPlainly(response, 'вход');
    expect(sessionCookieOf(response)).toBeNull();
  });

  it('домен и HTTPS в заголовках чужому сокету не помогают, даже с сильным паролем', async () => {
    const h = createHarness({ password: STRONG_PASSWORD, allowedHosts: [DOMAIN] });

    const response = await h.request({
      url: '/login',
      ...VIA_HTTPS,
      remoteAddress: FOREIGN_PEER,
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': FOREIGN_PEER },
    });

    expectRejectedPlainly(response, 'домен');
  });

  it('чужой адрес отклоняется раньше проверки пароля: попытки входа не попадают в аудит и счётчик', async () => {
    const h = createHarness();
    for (let i = 0; i < 6; i += 1) {
      const response = await h.request({
        url: '/login',
        form: { password: 'неверный-пароль-123' },
        remoteAddress: FOREIGN_PEER,
      });
      expect(response.statusCode).toBe(403);
    }

    const actions = auditActions(h);

    expect(actions).not.toContain('login_failed');
    expect(actions).not.toContain('login_blocked');
    expect(h.rawLog()).not.toContain('неверный-пароль-123');
  });

  it('отказ записан в аудит предупреждением без адреса', async () => {
    const h = createHarness();

    await h.request({ url: '/login', remoteAddress: FOREIGN_PEER });

    expect(h.logs()).toContainEqual(
      expect.objectContaining({ action: 'peer_rejected', level: 40 }),
    );
    expect(h.rawLog()).not.toContain(FOREIGN_PEER);
  });

  it('заголовки безопасности стоят и на отказе', async () => {
    const h = createHarness();

    const response = await h.request({ url: '/login', remoteAddress: FOREIGN_PEER });

    expect(String(response.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('панель: домен за Caddy только по HTTPS', () => {
  const create = (): Harness =>
    createHarness({ password: STRONG_PASSWORD, allowedHosts: [DOMAIN] });

  it('домен по обычному HTTP (X-Forwarded-Proto нет): 403 на входе, списке чатов и CSS', async () => {
    const h = create();
    const { cookie } = await h.login();
    h.chats.listForPanel.mockClear();

    for (const url of ['/login', '/chats', '/panel.css']) {
      expectRejectedPlainly(await h.request({ url, host: DOMAIN, cookie }), url);
    }
    expect(h.chats.listForPanel).not.toHaveBeenCalled();
  });

  it.each(['http', 'ftp', ''])('X-Forwarded-Proto «%s» это не HTTPS: 403', async (proto) => {
    const h = create();

    const response = await h.request({
      url: '/login',
      host: DOMAIN,
      headers: { 'x-forwarded-proto': proto },
    });

    expectRejectedPlainly(response, `proto «${proto}»`);
  });

  it('вход по паролю с домена по HTTP: 403 до проверки пароля, сессии нет', async () => {
    const h = create();

    const response = await h.request({
      url: '/login',
      form: { password: STRONG_PASSWORD },
      host: DOMAIN,
      origin: `http://${DOMAIN}`,
    });

    expectRejectedPlainly(response, 'вход по HTTP');
    expect(auditActions(h)).not.toContain('login');
  });

  it('домен по HTTPS через локальный прокси: страница входа открывается, вход даёт сессию с Secure', async () => {
    const h = create();

    const page = await h.request({ url: '/login', ...VIA_HTTPS });
    const login = await h.request({
      url: '/login',
      form: { password: STRONG_PASSWORD },
      ...VIA_HTTPS,
    });

    expect(page.statusCode).toBe(200);
    expect(login.statusCode).toBe(303);
    expect(setCookieLines(login)[0]).toMatch(/; Secure$/);
  });

  it('понижение до HTTP: сессия, выданная по HTTPS, на домене без HTTPS не работает', async () => {
    const h = create();
    const login = await h.request({
      url: '/login',
      form: { password: STRONG_PASSWORD },
      ...VIA_HTTPS,
    });
    const cookie = sessionCookieOf(login) ?? '';

    const secure = await h.request({ url: '/chats', cookie, ...VIA_HTTPS });
    const downgraded = await h.request({ url: '/chats', cookie, host: DOMAIN });

    expect(secure.statusCode).toBe(200);
    expectRejectedPlainly(downgraded, 'без HTTPS');
  });

  it('локальный прокси с адресом ::ffff:127.0.0.1 (двойной стек) тоже доверенный: HTTPS от него принимается', async () => {
    const h = create();

    const response = await h.request({
      url: '/login',
      ...VIA_HTTPS,
      remoteAddress: '::ffff:127.0.0.1',
    });

    expect(response.statusCode).toBe(200);
  });

  it.each([HOST_HEADER, 'localhost:3100'])(
    'локальный Host «%s» по обычному HTTP работает, как раньше',
    async (host) => {
      const h = create();

      const page = await h.request({ url: '/login', host });
      const login = await h.request({
        url: '/login',
        form: { password: STRONG_PASSWORD },
        host,
        origin: `http://${host}`,
      });

      expect(page.statusCode).toBe(200);
      expect(login.statusCode).toBe(303);
      expect(setCookieLines(login)[0]).not.toContain('Secure');
    },
  );

  it('локальный Host с X-Forwarded-Proto: http тоже работает: правило только для доменов', async () => {
    const h = create();

    const response = await h.request({ url: '/login', headers: { 'x-forwarded-proto': 'http' } });

    expect(response.statusCode).toBe(200);
  });

  it('слабый пароль: домен по-прежнему закрыт, HTTPS его не открывает', async () => {
    const h = createHarness({ allowedHosts: [DOMAIN] });

    const response = await h.request({ url: '/login', ...VIA_HTTPS });

    expect(response.statusCode).toBe(403);
  });

  it('отказ по HTTP записан в аудит предупреждением без пароля', async () => {
    const h = create();

    await h.request({
      url: '/login',
      form: { password: STRONG_PASSWORD },
      host: DOMAIN,
      origin: `http://${DOMAIN}`,
    });

    expect(h.logs()).toContainEqual(
      expect.objectContaining({ action: 'http_rejected', level: 40 }),
    );
    expect(h.rawLog()).not.toContain(STRONG_PASSWORD);
  });
});
