import { describe, expect, it } from 'vitest';
import {
  clearedSessionCookie,
  formField,
  originAllowed,
  parseForm,
  readCookie,
  securityHeaders,
  SESSION_COOKIE,
  sessionCookie,
} from '../../../src/panel/http.js';

describe('readCookie', () => {
  it('находит cookie по точному имени среди других', () => {
    expect(readCookie(`a=1; ${SESSION_COOKIE}=abc_DEF-9; b=2`, SESSION_COOKIE)).toBe('abc_DEF-9');
    expect(readCookie(`${SESSION_COOKIE}=abc`, SESSION_COOKIE)).toBe('abc');
  });

  it('другое имя с тем же началом или окончанием не подходит', () => {
    expect(readCookie(`x${SESSION_COOKIE}=1; ${SESSION_COOKIE}_x=2`, SESSION_COOKIE)).toBeNull();
  });

  it('при повторе берёт первое значение', () => {
    expect(readCookie(`${SESSION_COOKIE}=first; ${SESSION_COOKIE}=second`, SESSION_COOKIE)).toBe(
      'first',
    );
  });

  it('нет заголовка, нет cookie, пустое значение или мусор: null', () => {
    expect(readCookie(undefined, SESSION_COOKIE)).toBeNull();
    expect(readCookie('', SESSION_COOKIE)).toBeNull();
    expect(readCookie('a=1', SESSION_COOKIE)).toBeNull();
    expect(readCookie(`${SESSION_COOKIE}=`, SESSION_COOKIE)).toBeNull();
    expect(readCookie(';;; =; = ;novalue', SESSION_COOKIE)).toBeNull();
  });

  it('пробелы вокруг имени и значения не мешают', () => {
    expect(readCookie(`  ${SESSION_COOKIE} = abc  ;b=2`, SESSION_COOKIE)).toBe('abc');
  });
});

describe('cookie сессии', () => {
  it('HttpOnly, SameSite=Strict, весь сайт; без Secure по HTTP', () => {
    expect(sessionCookie('ID123', false)).toBe(
      `${SESSION_COOKIE}=ID123; Path=/; HttpOnly; SameSite=Strict`,
    );
  });

  it('по HTTPS добавляется Secure', () => {
    expect(sessionCookie('ID123', true)).toBe(
      `${SESSION_COOKIE}=ID123; Path=/; HttpOnly; SameSite=Strict; Secure`,
    );
  });

  it('удаление: пустое значение, срок в прошлом, те же флаги', () => {
    expect(clearedSessionCookie(false)).toBe(
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    );
    expect(clearedSessionCookie(true)).toMatch(/; Secure$/);
  });
});

describe('parseForm и formField', () => {
  it('разбирает поля формы, плюс это пробел, кириллица в процентной записи', () => {
    const fields = parseForm(
      'text=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82+%D0%BC%D0%B8%D1%80&csrf=tok',
    );

    expect(formField(fields, 'text')).toBe('Привет мир');
    expect(formField(fields, 'csrf')).toBe('tok');
  });

  it('при повторе поля берёт первое; пустое значение остаётся пустой строкой', () => {
    const fields = parseForm('a=1&a=2&b=');

    expect(formField(fields, 'a')).toBe('1');
    expect(formField(fields, 'b')).toBe('');
  });

  it('служебные имена полей безобидны: это обычные ключи', () => {
    const fields = parseForm('__proto__=x&constructor=y');

    expect(formField(fields, '__proto__')).toBe('x');
    expect(formField(fields, 'constructor')).toBe('y');
    expect(formField(parseForm('a=1'), 'constructor')).toBeNull();
  });

  it('нет такого поля или тело не форма: null', () => {
    expect(formField(parseForm(''), 'a')).toBeNull();
    expect(formField(undefined, 'a')).toBeNull();
    expect(formField({ a: '1' }, 'a')).toBeNull();
    expect(formField('a=1', 'a')).toBeNull();
    expect(formField(null, 'a')).toBeNull();
  });
});

describe('originAllowed', () => {
  const local = { hostHeader: '127.0.0.1:3100', protocol: 'http' } as const;

  it('Origin с тем же адресом и схемой допустим', () => {
    expect(originAllowed({ ...local, origin: 'http://127.0.0.1:3100', referer: undefined })).toBe(
      true,
    );
    expect(
      originAllowed({
        origin: 'https://panel.example.kz',
        referer: undefined,
        hostHeader: 'Panel.Example.kz',
        protocol: 'https',
      }),
    ).toBe(true);
  });

  it('чужой сайт, чужой порт, другая схема, null и мусор отказ', () => {
    for (const origin of [
      'http://evil.example.com',
      'http://127.0.0.1:3101',
      'https://127.0.0.1:3100',
      'http://127.0.0.1.evil.com:3100',
      'http://user@127.0.0.1:3100',
      'http://127.0.0.1:3100/chats',
      'null',
      '',
      'не адрес',
    ]) {
      expect(originAllowed({ ...local, origin, referer: undefined }), origin).toBe(false);
    }
  });

  it('без Origin смотрит Referer (только его адрес, путь не важен)', () => {
    expect(
      originAllowed({ ...local, origin: undefined, referer: 'http://127.0.0.1:3100/chats/5?x=1' }),
    ).toBe(true);
    expect(
      originAllowed({ ...local, origin: undefined, referer: 'http://evil.example.com/chats' }),
    ).toBe(false);
    expect(originAllowed({ ...local, origin: undefined, referer: 'мусор' })).toBe(false);
  });

  it('Origin важнее Referer: чужой Origin не спасёт свой Referer', () => {
    expect(
      originAllowed({
        ...local,
        origin: 'http://evil.example.com',
        referer: 'http://127.0.0.1:3100/chats',
      }),
    ).toBe(false);
  });

  it('нет ни Origin, ни Referer, ни заголовка Host: отказ', () => {
    expect(originAllowed({ ...local, origin: undefined, referer: undefined })).toBe(false);
    expect(
      originAllowed({
        origin: 'http://127.0.0.1:3100',
        referer: undefined,
        hostHeader: undefined,
        protocol: 'http',
      }),
    ).toBe(false);
  });
});

describe('securityHeaders', () => {
  it('CSP без скриптов и без inline, запрет фреймов, nosniff, no-store', () => {
    const headers = securityHeaders(false);
    const csp = headers['content-security-policy'] ?? '';

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|script-src|\*/);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['referrer-policy']).toBe('same-origin');
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('HSTS только по HTTPS', () => {
    expect(securityHeaders(false)['strict-transport-security']).toBeUndefined();
    expect(securityHeaders(true)['strict-transport-security']).toMatch(/^max-age=\d+$/);
  });
});
