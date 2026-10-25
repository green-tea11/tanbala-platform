import net from 'node:net';
import { describe, expect, it } from 'vitest';

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
});
