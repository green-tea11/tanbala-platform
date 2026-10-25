import net from 'node:net';
import tls from 'node:tls';
import { describe, expect, it } from 'vitest';
import { scrubSecretEnv } from '../helpers/secret-env.js';

describe('сеть в тестах', () => {
  it('fetch отклоняется: случайный вызов API не уйдёт и не потратит бюджет', async () => {
    await expect(fetch('https://api.anthropic.com/v1/messages')).rejects.toThrow(
      'Сеть в тестах запрещена',
    );
  });

  it('TCP-соединение не открывается: к WhatsApp из тестов не подключиться', () => {
    expect(() => net.connect({ host: 'web.whatsapp.com', port: 443 })).toThrow(
      'Сеть в тестах запрещена',
    );
  });

  it('TLS-соединение тоже не открывается', () => {
    expect(() => tls.connect({ host: 'api.anthropic.com', port: 443 })).toThrow(
      'Сеть в тестах запрещена',
    );
  });

  it('очистка окружения убирает ключи API в любом регистре и не трогает остальное', () => {
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_AUTH_TOKEN: 'token',
      Anthropic_Custom_Headers: 'X-Api-Key: other',
      VENMART_ANTHROPIC_KEY: 'key',
      openrouter_api_key: 'key',
      PATH: '/usr/bin',
    };
    expect(scrubSecretEnv(env).sort()).toEqual([
      'ANTHROPIC_AUTH_TOKEN',
      'Anthropic_Custom_Headers',
      'VENMART_ANTHROPIC_KEY',
      'openrouter_api_key',
    ]);
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('ключи API не видны тестам и дочерним процессам', () => {
    const exposed = Object.keys(process.env).filter(
      (name) =>
        /^ANTHROPIC_/.test(name) ||
        name === 'VENMART_ANTHROPIC_KEY' ||
        name === 'OPENROUTER_API_KEY',
    );
    expect(exposed).toEqual([]);
  });
});
