import { describe, expect, it } from 'vitest';
import { domainFromProfile } from '../../../src/company/profile-domain.js';

/** Площадки и соцсети из решения владельца: ни сам домен, ни его поддомен не годятся как домен компании. */
const PLATFORM_DOMAINS = [
  'instagram.com',
  'facebook.com',
  'fb.com',
  'wa.me',
  'whatsapp.com',
  't.me',
  'telegram.me',
  'taplink.cc',
  'taplink.ws',
  'taplink.at',
  'linktr.ee',
  '2gis.kz',
  '2gis.ru',
  '2gis.com',
  'vk.com',
  'ok.ru',
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'google.com',
  'goo.gl',
  'g.page',
  'linkedin.com',
  'x.com',
  'twitter.com',
  'pinterest.com',
  'olx.kz',
  'kaspi.kz',
  'satu.kz',
  'tilda.ws',
  'wixsite.com',
  'business.site',
  'blogspot.com',
  'wordpress.com',
];

/** Общие почтовые сервисы: домен после @ у них не говорит о компании. */
const MAIL_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'mail.ru',
  'inbox.ru',
  'list.ru',
  'bk.ru',
  'internet.ru',
  'yandex.ru',
  'yandex.kz',
  'yandex.com',
  'ya.ru',
  'rambler.ru',
  'icloud.com',
  'me.com',
  'mac.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.net',
  'zoho.com',
  'mail.kz',
  'inbox.kz',
];

function fromSites(...websites: string[]): string | null {
  return domainFromProfile({ websites, email: null });
}

function fromEmail(email: string | null, websites: string[] = []): string | null {
  return domainFromProfile({ websites, email });
}

describe('domainFromProfile: сайт', () => {
  it.each([
    ['https://www.sklad.kz/about', 'sklad.kz'],
    ['sklad.kz', 'sklad.kz'],
    ['http://sklad.kz', 'sklad.kz'],
    ['HTTP://SKLAD.KZ:8080/x?y=1#z', 'sklad.kz'],
    ['www.Sklad.KZ', 'sklad.kz'],
    ['  https://sklad.kz/  ', 'sklad.kz'],
    ['sklad.kz.', 'sklad.kz'],
    ['https://shop.sklad.kz/catalog', 'shop.sklad.kz'],
    ['sklad.com.kz/contacts', 'sklad.com.kz'],
    ['https://user:pass@sklad.kz/', 'sklad.kz'],
    ['https://my-sklad24.kz', 'my-sklad24.kz'],
    ['https://24sklad.kz', '24sklad.kz'],
  ])('сайт «%s» даёт домен «%s»', (website, expected) => {
    expect(fromSites(website)).toBe(expected);
  });

  it('кириллический домен приводится к punycode', () => {
    expect(fromSites('https://пример.рф/о-нас')).toBe('xn--e1afmkfd.xn--p1ai');
  });

  it('готовый punycode допустим', () => {
    expect(fromSites('xn--e1afmkfd.xn--p1ai')).toBe('xn--e1afmkfd.xn--p1ai');
    expect(fromSites('https://www.xn--80ak6aa92e.com')).toBe('xn--80ak6aa92e.com');
  });

  it.each([
    ['пустая строка', ''],
    ['пробелы', '   '],
    ['одно слово без зоны', 'sklad'],
    ['localhost', 'http://localhost:3000'],
    ['IP-адрес', 'http://192.168.0.1/admin'],
    ['зона из одной буквы', 'sklad.k'],
    ['зона из цифр', 'sklad.123'],
    ['пробел внутри', 'sk lad.kz'],
    ['текст с пробелами', 'наш сайт скоро'],
    ['дефис в начале метки', '-sklad.kz'],
    ['дефис в конце метки', 'sklad-.kz'],
    ['пустая метка', 'a..kz'],
    ['подчёркивание', 'sk_lad.kz'],
    ['скобки', 'sklad.kz)'],
    ['не адрес', 'javascript:alert(1)'],
    ['схема без хоста', 'https://'],
  ])('не домен (%s): null', (_label, website) => {
    expect(fromSites(website)).toBeNull();
  });

  it('метка длиннее 63 знаков и домен длиннее 253 знаков отклоняются', () => {
    expect(fromSites(`${'a'.repeat(64)}.kz`)).toBeNull();
    const longHost = `${Array.from({ length: 5 }, () => 'a'.repeat(60)).join('.')}.kz`;
    expect(longHost.length).toBeGreaterThan(253);
    expect(fromSites(longHost)).toBeNull();
  });

  it('домен ровно из 253 знаков допустим, из 254 нет', () => {
    const hostOf = (firstLabel: number): string =>
      ['a'.repeat(firstLabel), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61), 'kz'].join('.');

    expect(hostOf(60)).toHaveLength(253);
    expect(fromSites(`https://${hostOf(60)}`)).toBe(hostOf(60));
    expect(hostOf(61)).toHaveLength(254);
    expect(fromSites(`https://${hostOf(61)}`)).toBeNull();
  });

  it('первый подходящий сайт побеждает, неподходящие пропускаются', () => {
    expect(fromSites('instagram.com/alpha', '', 'sklad.kz', 'other.kz')).toBe('sklad.kz');
    expect(fromSites('mess', 'wa.me/77001234567', 'other.kz')).toBe('other.kz');
  });

  it('сайтов нет или все неподходящие: null', () => {
    expect(fromSites()).toBeNull();
    expect(fromSites('instagram.com/a', 'wa.me/7700')).toBeNull();
  });
});

describe('domainFromProfile: площадки и соцсети', () => {
  it.each(PLATFORM_DOMAINS)('%s отбрасывается сам, с www и поддоменом, с путём', (domain) => {
    expect(fromSites(domain)).toBeNull();
    expect(fromSites(`https://www.${domain}/company`)).toBeNull();
    expect(fromSites(`https://shop.${domain}/company`)).toBeNull();
    expect(fromSites(`${domain}/alpha_company?x=1`)).toBeNull();
  });

  it('похожий, но другой домен не отбрасывается', () => {
    expect(fromSites('notinstagram.com')).toBe('notinstagram.com');
    expect(fromSites('instagram.com.sklad.kz')).toBe('instagram.com.sklad.kz');
    expect(fromSites('mywa.me.kz')).toBe('mywa.me.kz');
    expect(fromSites('sklad-vk.com.kz')).toBe('sklad-vk.com.kz');
  });

  it('после соцсети берётся следующий сайт, а при их отсутствии почта', () => {
    expect(domainFromProfile({ websites: ['instagram.com/a'], email: 'info@sklad.kz' })).toBe(
      'sklad.kz',
    );
  });
});

describe('domainFromProfile: почта', () => {
  it.each([
    ['ivan@sklad.kz', 'sklad.kz'],
    ['Ivan.Petrov@SKLAD.KZ', 'sklad.kz'],
    ['  info@www.sklad.kz  ', 'sklad.kz'],
    ['info@mail.sklad.kz', 'mail.sklad.kz'],
    ['a+b@sklad.com.kz', 'sklad.com.kz'],
    ['info@sklad.kz.', 'sklad.kz'],
  ])('адрес «%s» даёт домен «%s»', (email, expected) => {
    expect(fromEmail(email)).toBe(expected);
  });

  it.each(MAIL_DOMAINS)('общий почтовый сервис %s не годится', (domain) => {
    expect(fromEmail(`ivan@${domain}`)).toBeNull();
    expect(fromEmail(`ivan@mx.${domain}`)).toBeNull();
    expect(fromEmail(`IVAN@${domain.toUpperCase()}`)).toBeNull();
  });

  it('почтовый домен с похожим окончанием, но другой, годится', () => {
    expect(fromEmail('ivan@notgmail.com')).toBe('notgmail.com');
    expect(fromEmail('ivan@gmail.com.kz')).toBe('gmail.com.kz');
  });

  it.each([
    ['без @', 'ivan.sklad.kz'],
    ['пусто после @', 'ivan@'],
    ['не домен после @', 'ivan@sklad'],
    ['пробел в домене', 'ivan@sk lad.kz'],
    ['пустая строка', ''],
    ['пробелы', '   '],
  ])('адрес не годится (%s): null', (_label, email) => {
    expect(fromEmail(email)).toBeNull();
  });

  it('почты нет: null', () => {
    expect(fromEmail(null)).toBeNull();
  });

  it('берётся часть после последней @', () => {
    expect(fromEmail('"ivan@home"@sklad.kz')).toBe('sklad.kz');
  });

  it('сайт важнее почты, даже если почта корпоративная', () => {
    expect(domainFromProfile({ websites: ['https://site.kz'], email: 'info@mail-corp.kz' })).toBe(
      'site.kz',
    );
  });

  it('сайта нет, а почта на общем сервисе: null', () => {
    expect(domainFromProfile({ websites: [], email: 'shop@gmail.com' })).toBeNull();
  });

  it('почтовый домен общего сервиса как сайт не отбрасывается правилом для почты', () => {
    expect(fromSites('https://mail.ru')).toBe('mail.ru');
  });
});
