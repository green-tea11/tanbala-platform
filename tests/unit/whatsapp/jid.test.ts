import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Jid, PhoneDigits } from '../../../src/domain/types.js';
import { isPersonalJid, jidToPhone, normalizeJid, phoneToJid } from '../../../src/whatsapp/jid.js';

// Номера и LID только фиктивные.
const PHONE = '77000000001' as PhoneDigits;
const PN_JID = '77000000001@s.whatsapp.net';
const LID_JID = '100000000000001@lid';

/** Чем упал вызов; undefined, если не упал. */
function errorOf(call: () => unknown): unknown {
  try {
    call();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

describe('phoneToJid', () => {
  it('собирает адрес вида <цифры>@s.whatsapp.net', () => {
    expect(phoneToJid(PHONE)).toBe(PN_JID);
  });

  it('результат проходит белый список личных чатов', () => {
    expect(isPersonalJid(phoneToJid(PHONE))).toBe(true);
  });

  it.each(['', '+77000000001', '7700 000 0001', '77000000001@s.whatsapp.net', '7700000000١'])(
    'отказывает на номере не из одних цифр: %j',
    (raw) => {
      expect(() => phoneToJid(raw as PhoneDigits)).toThrow(RangeError);
    },
  );

  it('текст ошибки не содержит номера', () => {
    const error = errorOf(() => phoneToJid('+77000000001' as PhoneDigits));

    expect(error).toBeInstanceOf(RangeError);
    expect(String(error)).not.toContain('77000000001');
  });
});

describe('jidToPhone', () => {
  it('берёт номер из адреса с номером', () => {
    expect(jidToPhone(PN_JID as Jid)).toBe(PHONE);
  });

  it('отбрасывает суффикс устройства «:N», как в ответе lidMapping.getPNForLID', () => {
    expect(jidToPhone('77000000001:0@s.whatsapp.net' as Jid)).toBe(PHONE);
    expect(jidToPhone('77000000001:12@s.whatsapp.net' as Jid)).toBe(PHONE);
  });

  it('отбрасывает и агент «_N» перед устройством', () => {
    expect(jidToPhone('77000000001_1:3@s.whatsapp.net' as Jid)).toBe(PHONE);
  });

  it('hosted-адрес с номером тоже даёт номер', () => {
    expect(jidToPhone('77000000001@hosted' as Jid)).toBe(PHONE);
  });

  it.each([LID_JID, '100000000000001:4@lid', '100000000000001@hosted.lid'])(
    'для адреса %s номера нет: null',
    (jid) => {
      expect(jidToPhone(jid as Jid)).toBeNull();
    },
  );

  it.each(['', 'status@broadcast', '120363000000000001@g.us', 'abc@s.whatsapp.net'])(
    'на адресе не личного чата %j отвечает null, а не бросает',
    (jid) => {
      expect(jidToPhone(jid as Jid)).toBeNull();
    },
  );
});

describe('isPersonalJid', () => {
  it.each([
    PN_JID,
    LID_JID,
    '77000000001@hosted',
    '100000000000001@hosted.lid',
    '77000000001:12@s.whatsapp.net',
    '100000000000001:3@lid',
    '77000000001_1:3@s.whatsapp.net',
  ])('личный чат: %s', (jid) => {
    expect(isPersonalJid(jid)).toBe(true);
  });

  it.each([
    ['группа', '120363000000000001@g.us'],
    ['группа старого вида', '77000000001-1600000000@g.us'],
    ['статусы', 'status@broadcast'],
    ['рассылка', '1600000000@broadcast'],
    ['канал', '120363000000000002@newsletter'],
    ['звонок', '77000000001@call'],
    ['бот Meta AI', '13135550002@bot'],
    ['c.us до нормализации', '77000000001@c.us'],
    ['сервер WhatsApp', '@s.whatsapp.net'],
    ['сервер без @', 's.whatsapp.net'],
    ['пустая строка', ''],
    ['имя вместо цифр', 'client@s.whatsapp.net'],
    ['сервер в другом регистре', '77000000001@S.WHATSAPP.NET'],
    ['два @', '77000000001@lid@s.whatsapp.net'],
    ['пробел в конце', '77000000001@s.whatsapp.net '],
    ['перенос строки в конце', '77000000001@s.whatsapp.net\n'],
    ['похожий сервер', '77000000001@s.whatsapp.net.evil'],
    ['цифры не ASCII', '٧٧000000001@s.whatsapp.net'],
    ['пустое устройство', '77000000001:@s.whatsapp.net'],
    ['сервер из прототипа объекта', '77000000001@constructor'],
  ])('не личный чат: %s', (_label, jid) => {
    expect(isPersonalJid(jid)).toBe(false);
  });

  it('сужает строку до бренда Jid', () => {
    const raw: string = PN_JID;

    expect(isPersonalJid(raw)).toBe(true);
    if (isPersonalJid(raw)) {
      expectTypeOf(raw).toEqualTypeOf<Jid>();
    }
  });
});

describe('normalizeJid', () => {
  it('снимает суффикс устройства и агента', () => {
    expect(normalizeJid('77000000001:12@s.whatsapp.net')).toBe(PN_JID);
    expect(normalizeJid('77000000001_1:3@s.whatsapp.net')).toBe(PN_JID);
    expect(normalizeJid('100000000000001:3@lid')).toBe(LID_JID);
  });

  it('переводит hosted-адреса в обычные, как cleanMessage в Baileys', () => {
    expect(normalizeJid('77000000001@hosted')).toBe(PN_JID);
    expect(normalizeJid('100000000000001:2@hosted.lid')).toBe(LID_JID);
  });

  it('нормализованный адрес не меняется', () => {
    expect(normalizeJid(PN_JID)).toBe(PN_JID);
    expect(normalizeJid(LID_JID)).toBe(LID_JID);
  });

  it.each(['status@broadcast', '120363000000000001@g.us', '77000000001@c.us', '', 'x@lid'])(
    'не личный адрес %j: null',
    (raw) => {
      expect(normalizeJid(raw)).toBeNull();
    },
  );

  it('возвращает бренд Jid или null', () => {
    expectTypeOf(normalizeJid).returns.toEqualTypeOf<Jid | null>();
  });
});
