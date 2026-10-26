import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../../src/config/errors.js';
import {
  assertPanelStartAllowed,
  constantTimeEqual,
  hostHeaderAllowed,
  isLoopback,
  isWeakPassword,
  passwordMatches,
} from '../../../src/panel/guard.js';

const STRONG = 'correct-horse-battery';
const PORT = 3100;

describe('isLoopback', () => {
  it('только литерал 127.0.0.1', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
  });

  it.each([
    '::1',
    'localhost',
    '0.0.0.0',
    '::',
    '127.0.0.2',
    '127.0.0.1 ',
    ' 127.0.0.1',
    '127.0.0.1.example.com',
    '[::1]',
    '192.168.0.10',
    '',
  ])('«%s» считается чужим адресом', (host) => {
    expect(isLoopback(host)).toBe(false);
  });
});

describe('isWeakPassword', () => {
  it.each(['admin', 'ADMIN', '  Admin  ', '', '   ', 'x'.repeat(15), 'я'.repeat(15)])(
    '«%s» слабый',
    (password) => {
      expect(isWeakPassword(password)).toBe(true);
    },
  );

  it.each(['x'.repeat(16), STRONG, 'пароль_из_шестнадцати_знаков'])('«%s» годится', (password) => {
    expect(isWeakPassword(password)).toBe(false);
  });

  it('пробелы по краям длину не добавляют', () => {
    expect(isWeakPassword(`${' '.repeat(10)}${'x'.repeat(10)}${' '.repeat(10)}`)).toBe(true);
    expect(isWeakPassword(`admin${' '.repeat(30)}`)).toBe(true);
  });
});

describe('assertPanelStartAllowed', () => {
  it.each(['admin', 'ADMIN', '', 'коротко', STRONG])(
    '127.0.0.1 запускается с любым паролем («%s»)',
    (password) => {
      expect(() => {
        assertPanelStartAllowed({ host: '127.0.0.1', password });
      }).not.toThrow();
    },
  );

  it.each(['0.0.0.0', '::', '::1', 'localhost', '192.168.0.10', '203.0.113.5'])(
    'на %s пароль admin запрещён',
    (host) => {
      expect(() => {
        assertPanelStartAllowed({ host, password: 'admin' });
      }).toThrow(ConfigError);
    },
  );

  it.each([
    ['пустой', ''],
    ['из пробелов', '    '],
    ['admin с пробелами и в другом регистре', '  AdMiN '],
    ['короче 16 символов', 'x'.repeat(15)],
  ])('на чужом адресе пароль %s запрещён', (_label, password) => {
    expect(() => {
      assertPanelStartAllowed({ host: '0.0.0.0', password });
    }).toThrow(ConfigError);
  });

  it('на чужом адресе пароль от 16 символов разрешён', () => {
    expect(() => {
      assertPanelStartAllowed({ host: '0.0.0.0', password: 'x'.repeat(16) });
    }).not.toThrow();
    expect(() => {
      assertPanelStartAllowed({ host: '203.0.113.5', password: STRONG });
    }).not.toThrow();
  });

  it('отказ называет настройки и не печатает пароль', () => {
    const password = 'secret-12345';
    let failure: unknown = null;
    try {
      assertPanelStartAllowed({ host: '0.0.0.0', password });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ConfigError);
    const text = (failure as ConfigError).problems.join(' ');
    expect(text).toContain('PANEL_HOST');
    expect(text).toContain('ADMIN_PASSWORD');
    expect(text).not.toContain(password);
    expect((failure as ConfigError).message).not.toContain(password);
  });
});

describe('hostHeaderAllowed', () => {
  const check = (
    hostHeader: string | undefined,
    password: string,
    allowedHosts?: readonly string[],
  ): boolean => hostHeaderAllowed({ hostHeader, port: PORT, password, allowedHosts });

  it.each([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `LOCALHOST:${PORT}`])(
    'слабый пароль: принимает %s',
    (host) => {
      expect(check(host, 'admin')).toBe(true);
      expect(check(host, '')).toBe(true);
      expect(check(host, 'x'.repeat(15))).toBe(true);
    },
  );

  it.each([
    undefined,
    '',
    '127.0.0.1',
    '127.0.0.1:3101',
    '127.0.0.1:3100.evil.com',
    'localhost',
    'evil.example.com',
    `evil.example.com:${PORT}`,
    `[::1]:${PORT}`,
    `0.0.0.0:${PORT}`,
    `127.0.0.1:${PORT}, evil.example.com`,
  ])('слабый пароль: отказ для «%s»', (host) => {
    expect(check(host, 'admin')).toBe(false);
  });

  it('слабый пароль: домен из списка не помогает, за Caddy вход закрыт', () => {
    expect(check('panel.example.kz', 'admin', ['panel.example.kz'])).toBe(false);
    expect(check('panel.example.kz', 'x'.repeat(15), ['panel.example.kz'])).toBe(false);
  });

  it('сильный пароль: локальные адреса и домены из списка, без учёта регистра', () => {
    const allowed = ['panel.example.kz', 'Panel2.Example.kz:8443'];

    expect(check(`127.0.0.1:${PORT}`, STRONG, allowed)).toBe(true);
    expect(check(`localhost:${PORT}`, STRONG, allowed)).toBe(true);
    expect(check('panel.example.kz', STRONG, allowed)).toBe(true);
    expect(check('PANEL.example.KZ', STRONG, allowed)).toBe(true);
    expect(check('panel2.example.kz:8443', STRONG, allowed)).toBe(true);
  });

  it('сильный пароль: чужой домен, нет заголовка и пустой список отказ', () => {
    expect(check('evil.example.com', STRONG, ['panel.example.kz'])).toBe(false);
    expect(check('panel.example.kz.evil.com', STRONG, ['panel.example.kz'])).toBe(false);
    expect(check('panel.example.kz:8443', STRONG, ['panel.example.kz'])).toBe(false);
    expect(check(undefined, STRONG, ['panel.example.kz'])).toBe(false);
    expect(check('', STRONG, ['panel.example.kz'])).toBe(false);
    expect(check('panel.example.kz', STRONG)).toBe(false);
    expect(check('panel.example.kz', STRONG, [])).toBe(false);
  });

  it('порт 80: заголовок без порта тоже свой', () => {
    const onPort80 = (hostHeader: string): boolean =>
      hostHeaderAllowed({ hostHeader, port: 80, password: 'admin' });

    expect(onPort80('127.0.0.1')).toBe(true);
    expect(onPort80('localhost')).toBe(true);
    expect(onPort80('127.0.0.1:80')).toBe(true);
    expect(onPort80('127.0.0.1:8080')).toBe(false);
  });
});

describe('passwordMatches и constantTimeEqual', () => {
  it('равные строки совпадают, разные нет', () => {
    expect(passwordMatches('пароль', 'пароль')).toBe(true);
    expect(passwordMatches('пароль', 'пароль ')).toBe(false);
    expect(passwordMatches('Пароль', 'пароль')).toBe(false);
  });

  it('разная длина не бросает исключение: сравниваются хеши, а не байты строк', () => {
    expect(passwordMatches('a', 'a'.repeat(1000))).toBe(false);
    expect(passwordMatches('', 'admin')).toBe(false);
    expect(passwordMatches('admin', '')).toBe(false);
    expect(constantTimeEqual('x'.repeat(5000), 'x')).toBe(false);
  });

  it('две пустые строки равны: пустой пароль панели при входе отсекает маршрут, а не сравнение', () => {
    expect(passwordMatches('', '')).toBe(true);
  });

  it('одинаковые по значению строки с разными суррогатными парами различаются', () => {
    expect(constantTimeEqual('😀', '😁')).toBe(false);
    expect(constantTimeEqual('😀', '😀')).toBe(true);
  });
});
