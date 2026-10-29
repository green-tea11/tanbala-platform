import { describe, expect, it } from 'vitest';
import { companyCardHref } from '../../../src/handoff/card-link.js';

// Ссылка на карточку компании: одно правило для уведомления менеджеру и панели.

describe('handoff/card-link: companyCardHref', () => {
  it.each([
    ['https://mail.example.kz/companies/12', 'https://mail.example.kz/companies/12'],
    ['http://127.0.0.1:8080/companies/12', 'http://127.0.0.1:8080/companies/12'],
    ['HTTPS://Mail.Example.KZ/companies/12', 'https://mail.example.kz/companies/12'],
    ['https://mail.example.kz/companies/ 12\n', 'https://mail.example.kz/companies/%2012'],
  ])('%j => %j: разобранный адрес без пробелов и переводов строк', (url, href) => {
    expect(companyCardHref(url)).toBe(href);
  });

  it.each([
    ['нет адреса', null],
    ['не адрес', 'карточка'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<b>x</b>'],
    ['ftp', 'ftp://mail.example.kz/companies/12'],
  ])('%s => null', (_case, url) => {
    expect(companyCardHref(url)).toBeNull();
  });
});
