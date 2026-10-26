import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../../../src/config/errors.js';
import { startPanel } from '../../../src/panel/server.js';
import { createHarness, PORT, STRONG_PASSWORD } from './harness.js';

/** Подмена listen: тесты не открывают порт и не выходят в сеть. */
function stubListen(app: FastifyInstance, outcome: Promise<string>): ReturnType<typeof vi.fn> {
  const listen = vi.fn(() => outcome);
  Object.assign(app, { listen });
  return listen;
}

describe('startPanel', () => {
  it('127.0.0.1 с паролем admin: запускается на своём адресе и порту', async () => {
    const { app } = createHarness();
    const listen = stubListen(app, Promise.resolve('http://127.0.0.1:3100'));

    await expect(
      startPanel(app, { host: '127.0.0.1', port: PORT, password: 'admin' }),
    ).resolves.toBeUndefined();

    expect(listen).toHaveBeenCalledOnce();
    expect(listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: PORT });
  });

  it.each(['0.0.0.0', '::', 'localhost', '203.0.113.5'])(
    'слабый пароль на %s: отказ до listen, порт не открывается',
    async (host) => {
      const { app } = createHarness();
      const listen = stubListen(app, Promise.resolve('не должно вызываться'));

      await expect(startPanel(app, { host, port: PORT, password: 'admin' })).rejects.toBeInstanceOf(
        ConfigError,
      );
      await expect(
        startPanel(app, { host, port: PORT, password: 'x'.repeat(15) }),
      ).rejects.toBeInstanceOf(ConfigError);

      expect(listen).not.toHaveBeenCalled();
    },
  );

  it('сильный пароль на другом адресе: запускается', async () => {
    const { app } = createHarness({ password: STRONG_PASSWORD });
    const listen = stubListen(app, Promise.resolve('http://0.0.0.0:3100'));

    await startPanel(app, { host: '0.0.0.0', port: PORT, password: STRONG_PASSWORD });

    expect(listen).toHaveBeenCalledWith({ host: '0.0.0.0', port: PORT });
  });

  it('ошибка порта (занят) пробрасывается: main решает, что делать', async () => {
    const { app } = createHarness();
    const failure = new Error('порт занят');
    stubListen(app, Promise.reject(failure));

    await expect(
      startPanel(app, { host: '127.0.0.1', port: PORT, password: 'admin' }),
    ).rejects.toBe(failure);
  });
});

describe('buildPanel', () => {
  it('сборка не слушает порт: сервер не запущен, хватает inject', async () => {
    const { app } = createHarness();

    expect(app.server.listening).toBe(false);
    const response = await app.inject({
      url: '/panel.css',
      headers: { host: `127.0.0.1:${PORT}` },
    });
    expect(response.statusCode).toBe(200);
    expect(app.server.listening).toBe(false);
  });

  it('пустой пароль: предупреждение в лог без значения; обычный пароль без предупреждения', () => {
    const empty = createHarness({ password: '' });
    const normal = createHarness();

    expect(empty.logs()).toContainEqual(
      expect.objectContaining({ level: 40, msg: expect.stringContaining('пустой') as unknown }),
    );
    expect(normal.logs()).toEqual([]);
  });
});
