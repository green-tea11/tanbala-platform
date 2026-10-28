import { describe, expect, it } from 'vitest';
import { searchPhone } from '../../../src/company/search-phone.js';
import type { Jid } from '../../../src/domain/types.js';

const jid = (value: string): Jid => value as Jid;

describe('searchPhone', () => {
  it('номер из адреса с номером: 11 цифр, начинается с 7', () => {
    expect(searchPhone(jid('77001234567@s.whatsapp.net'))).toBe('77001234567');
  });

  it('суффикс устройства и hosted-вариант адреса не мешают', () => {
    expect(searchPhone(jid('77001234567:12@s.whatsapp.net'))).toBe('77001234567');
    expect(searchPhone(jid('77001234567@hosted'))).toBe('77001234567');
    expect(searchPhone(jid('77001234567_1:3@s.whatsapp.net'))).toBe('77001234567');
  });

  it('российский номер тоже подходит: 7 и ещё десять цифр', () => {
    expect(searchPhone(jid('79991234567@s.whatsapp.net'))).toBe('79991234567');
  });

  it('адреса нет: не искать', () => {
    expect(searchPhone(null)).toBeNull();
  });

  it('адрес @lid номера не содержит: не искать', () => {
    expect(searchPhone(jid('100000000000001@lid'))).toBeNull();
    expect(searchPhone(jid('77001234567@lid'))).toBeNull();
  });

  it.each([
    ['номер с 8 в начале', '87001234567@s.whatsapp.net'],
    ['десять цифр', '7700123456@s.whatsapp.net'],
    ['двенадцать цифр', '770012345678@s.whatsapp.net'],
    ['не цифры', 'abc7001234567@s.whatsapp.net'],
    ['пустой номер', '@s.whatsapp.net'],
    ['чужой сервер', '77001234567@g.us'],
    ['без сервера', '77001234567'],
  ])('не 7XXXXXXXXXX (%s): не искать', (_label, value) => {
    expect(searchPhone(jid(value))).toBeNull();
  });
});
