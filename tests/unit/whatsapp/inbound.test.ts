import { proto, type WAMessage } from 'baileys';
import { describe, expect, it } from 'vitest';
import type {
  InboundMessage,
  Jid,
  MediaRef,
  MessageContent,
  PhoneDigits,
} from '../../../src/domain/types.js';
import {
  classifyUpsert,
  MAX_PUSH_NAME_CHARS,
  MAX_TEXT_CHARS,
  MAX_VERIFIED_NAME_CHARS,
  type ClassifyContext,
  type WaEvent,
} from '../../../src/whatsapp/inbound.js';

// Номера и LID только фиктивные. Сообщения синтетические: форма как у WAMessage в Baileys 7.0.0-rc14.
const HOUR_MS = 3_600_000;
const LINKED_AT_MS = Date.UTC(2026, 9, 24, 9, 0, 0);
const NOW_MS = LINKED_AT_MS + 30 * HOUR_MS;
const BACKLOG_MAX_AGE_MS = 12 * HOUR_MS;

const toSeconds = (ms: number): number => ms / 1000;
const FRESH_SECONDS = toSeconds(NOW_MS - HOUR_MS);
const STALE_SECONDS = toSeconds(NOW_MS - 13 * HOUR_MS);
const BEFORE_LINK_SECONDS = toSeconds(LINKED_AT_MS - HOUR_MS);

const MESSAGE_ID = '3EB0A1B2C3D4E5F60718';
const CLIENT_PHONE = '77000000001' as PhoneDigits;
const CLIENT_PN = '77000000001@s.whatsapp.net' as Jid;
const CLIENT_LID = '100000000000001@lid' as Jid;
const STRANGER_PHONE = '77000000002' as PhoneDigits;
const STRANGER_PN = '77000000002@s.whatsapp.net' as Jid;
const MANAGER_PN = '77000000005@s.whatsapp.net' as Jid;
const MANAGER_LID = '100000000000005@lid' as Jid;
const SELF_PN = '77000000009@s.whatsapp.net' as Jid;
const SELF_LID = '100000000000009@lid' as Jid;

const INVISIBLE_OR_CONTROL = /[\p{Cc}\p{Cf}]/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function waMessage(
  overrides: Readonly<Record<string, unknown>> = {},
  key: Readonly<Record<string, unknown>> = {},
): WAMessage {
  const synthetic: unknown = {
    key: { remoteJid: CLIENT_PN, fromMe: false, id: MESSAGE_ID, ...key },
    message: { conversation: 'Здравствуйте' },
    messageTimestamp: FRESH_SECONDS,
    pushName: 'Айгерим',
    ...overrides,
  };
  return synthetic as WAMessage;
}

function context(overrides: Partial<ClassifyContext> = {}): ClassifyContext {
  return {
    managerJids: new Set([MANAGER_PN, MANAGER_LID]),
    selfJids: new Set([SELF_PN, SELF_LID]),
    linkedAtMs: LINKED_AT_MS,
    nowMs: NOW_MS,
    backlogMaxAgeMs: BACKLOG_MAX_AGE_MS,
    testAllowlist: null,
    chatPhone: CLIENT_PHONE,
    upsertType: 'notify',
    ...overrides,
  };
}

function classify(
  overrides: Readonly<Record<string, unknown>> = {},
  key: Readonly<Record<string, unknown>> = {},
  contextOverrides: Partial<ClassifyContext> = {},
): WaEvent {
  return classifyUpsert(waMessage(overrides, key), context(contextOverrides));
}

function inboundOf(event: WaEvent): InboundMessage {
  if (event.type !== 'client' && event.type !== 'stale') {
    throw new Error(`ожидалось сообщение клиента, а пришло ${event.type}`);
  }
  return event.message;
}

function contentOf(event: WaEvent): MessageContent {
  if (event.type === 'ignore')
    throw new Error(`ожидалось сообщение, а пришёл пропуск ${event.reason}`);
  return event.message.content;
}

function textOf(event: WaEvent): string | null {
  const content = contentOf(event);
  return content.kind === 'text' ? content.text : null;
}

describe('classifyUpsert: обычное сообщение клиента', () => {
  it('свежий текст после привязки => client с адресами, именем, текстом и временем в мс', () => {
    expect(classify()).toStrictEqual({
      type: 'client',
      message: {
        waId: MESSAGE_ID,
        identity: { replyJid: CLIENT_PN, lidJid: null, pnJid: CLIENT_PN },
        pushName: 'Айгерим',
        verifiedName: null,
        content: { kind: 'text', text: 'Здравствуйте' },
        tsMs: FRESH_SECONDS * 1000,
      },
    });
  });

  it('сообщение из append с годным временем после привязки разбирается так же, как notify', () => {
    expect(classify({}, {}, { upsertType: 'append' })).toStrictEqual(classify());
  });
});

describe('classifyUpsert: адрес чата', () => {
  it('нет key => ignore service', () => {
    expect(classify({ key: undefined })).toStrictEqual({ type: 'ignore', reason: 'service' });
  });

  it.each([undefined, null, ''])('remoteJid %j => ignore service', (remoteJid) => {
    expect(classify({}, { remoteJid })).toStrictEqual({ type: 'ignore', reason: 'service' });
  });

  it.each([
    ['группа', '120363000000000001@g.us'],
    ['статусы', 'status@broadcast'],
    ['рассылка', '1600000000@broadcast'],
    ['канал', '120363000000000002@newsletter'],
    ['c.us', '77000000001@c.us'],
    ['сервер WhatsApp', '@s.whatsapp.net'],
    ['бот', '13135550002@bot'],
  ])('не личный чат (%s) => ignore service', (_label, remoteJid) => {
    expect(classify({}, { remoteJid })).toStrictEqual({ type: 'ignore', reason: 'service' });
  });

  it('суффикс устройства и hosted-сервер снимаются, как в cleanMessage Baileys', () => {
    expect(inboundOf(classify({}, { remoteJid: '77000000001:7@hosted' })).identity).toEqual({
      replyJid: CLIENT_PN,
      lidJid: null,
      pnJid: CLIENT_PN,
    });
  });
});

describe('classifyUpsert: служебные сообщения', () => {
  const revokedKey = { remoteJid: CLIENT_PN, fromMe: true, id: 'AAAA' };

  it.each([
    ['удаление', { protocolMessage: { type: 0, key: revokedKey } }],
    [
      'правка',
      { protocolMessage: { type: 14, key: revokedKey, editedMessage: { conversation: 'x' } } },
    ],
    [
      'правка в обёртке editedMessage',
      { editedMessage: { message: { protocolMessage: { type: 14, key: revokedKey } } } },
    ],
    [
      'удаление в исчезающем чате',
      { ephemeralMessage: { message: { protocolMessage: { type: 0 } } } },
    ],
    ['реакция', { reactionMessage: { key: revokedKey, text: '👍' } }],
    ['зашифрованная реакция', { encReactionMessage: { targetMessageKey: revokedKey } }],
    ['голос в опросе', { pollUpdateMessage: { pollCreationMessageKey: revokedKey } }],
    ['ответ на событие', { encEventResponseMessage: { eventCreationMessageKey: revokedKey } }],
    ['оставить в чате', { keepInChatMessage: { key: revokedKey } }],
    ['закрепление', { pinInChatMessage: { key: revokedKey } }],
    ['звонок', { call: { callKey: new Uint8Array([1]) } }],
    ['журнал звонка', { callLogMesssage: { isVideo: false } }],
    ['только служебный контекст', { messageContextInfo: { deviceListMetadataVersion: 2 } }],
    ['пустое содержимое', {}],
    ['нет содержимого', null],
  ])('%s => ignore protocol', (_label, message) => {
    expect(classify({ message })).toStrictEqual({ type: 'ignore', reason: 'protocol' });
  });

  it.each([
    ['удалено для всех', proto.WebMessageInfo.StubType.REVOKE],
    ['пропущенный звонок', proto.WebMessageInfo.StubType.CALL_MISSED_VOICE],
  ])('заглушка Baileys (%s) => ignore protocol', (_label, stub) => {
    expect(classify({ message: undefined, messageStubType: stub })).toStrictEqual({
      type: 'ignore',
      reason: 'protocol',
    });
    expect(classify({ messageStubType: stub })).toStrictEqual({
      type: 'ignore',
      reason: 'protocol',
    });
  });

  it('messageStubType 0 (нет заглушки) не мешает обычному сообщению', () => {
    expect(classify({ messageStubType: 0 }).type).toBe('client');
  });

  it.each([undefined, null, '', 'ID С ПРОБЕЛОМ', 'ID\n', 'ИД', 'A'.repeat(129)])(
    'ID сообщения %j отсутствует или испорчен => ignore protocol',
    (id) => {
      expect(classify({}, { id })).toStrictEqual({ type: 'ignore', reason: 'protocol' });
    },
  );

  it('удаление с телефона бота (fromMe) тоже protocol: перехват чата не включает', () => {
    const event = classify({ message: { protocolMessage: { type: 0 } } }, { fromMe: true });

    expect(event).toStrictEqual({ type: 'ignore', reason: 'protocol' });
  });
});

describe('classifyUpsert: сообщение не расшифровалось (CIPHERTEXT)', () => {
  // Так Baileys отдаёт сообщение, которое не расшифровалось или ждёт пересылки с телефона.
  const undecryptable = {
    message: undefined,
    messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
    messageStubParameters: ['Message absent from node'],
  };

  it('заглушка CIPHERTEXT => undecryptable: JID и время для счётчика и known_chats', () => {
    expect(classify(undecryptable)).toStrictEqual({
      type: 'ignore',
      reason: 'undecryptable',
      chatJid: CLIENT_PN,
      tsMs: FRESH_SECONDS * 1000,
    });
  });

  it('CIPHERTEXT с частью содержимого тоже undecryptable: текст не берётся', () => {
    const event = classify({ ...undecryptable, message: { conversation: 'обрывок' } });

    expect(event).toMatchObject({ type: 'ignore', reason: 'undecryptable' });
    expect(JSON.stringify(event)).not.toContain('обрывок');
  });

  it('своё сообщение, которое не расшифровалось, тоже undecryptable', () => {
    expect(classify(undecryptable, { fromMe: true })).toMatchObject({
      reason: 'undecryptable',
      chatJid: CLIENT_PN,
    });
  });

  it('живое без времени => undecryptable со временем разбора', () => {
    expect(classify({ ...undecryptable, messageTimestamp: null })).toStrictEqual({
      type: 'ignore',
      reason: 'undecryptable',
      chatJid: CLIENT_PN,
      tsMs: NOW_MS,
    });
  });

  it('чужой чат в закрытом режиме => not_allowlisted: список проверяется раньше', () => {
    const event = classify(
      undecryptable,
      { remoteJid: STRANGER_PN },
      { testAllowlist: new Set([CLIENT_PHONE]), chatPhone: STRANGER_PHONE },
    );

    expect(event).toMatchObject({ reason: 'not_allowlisted', chatJid: STRANGER_PN });
  });

  it('до привязки => before_link', () => {
    const event = classify({ ...undecryptable, messageTimestamp: BEFORE_LINK_SECONDS });

    expect(event).toMatchObject({ reason: 'before_link', chatJid: CLIENT_PN });
  });

  it('чат менеджера и чат с самим собой => manager и self', () => {
    expect(classify(undecryptable, { remoteJid: MANAGER_PN })).toStrictEqual({
      type: 'ignore',
      reason: 'manager',
    });
    expect(classify(undecryptable, { remoteJid: SELF_PN, fromMe: true })).toStrictEqual({
      type: 'ignore',
      reason: 'self',
    });
  });

  it('без ID => protocol', () => {
    expect(classify(undecryptable, { id: undefined })).toStrictEqual({
      type: 'ignore',
      reason: 'protocol',
    });
  });
});

describe('classifyUpsert: номер бота в закрытом режиме', () => {
  const SELF_PHONE = '77000000009' as PhoneDigits;
  const UNKNOWN_LID = '100000000000077@lid' as Jid;
  const withSelf = new Set([CLIENT_PHONE, SELF_PHONE]);

  it('номер чата совпал с номером бота => not_allowlisted, даже если номер бота в списке', () => {
    const event = classify(
      {},
      { remoteJid: UNKNOWN_LID, remoteJidAlt: SELF_PN, fromMe: true },
      { testAllowlist: withSelf, chatPhone: SELF_PHONE },
    );

    expect(event).toStrictEqual({
      type: 'ignore',
      reason: 'not_allowlisted',
      chatJid: UNKNOWN_LID,
      tsMs: FRESH_SECONDS * 1000,
    });
  });

  it('чат с самим собой по номеру => not_allowlisted', () => {
    const event = classify(
      {},
      { remoteJid: SELF_PN, fromMe: true },
      { testAllowlist: withSelf, chatPhone: null },
    );

    expect(event).toMatchObject({ reason: 'not_allowlisted' });
  });

  it('свой адрес с суффиксом устройства (как sock.user.id) тоже узнаётся', () => {
    const event = classify(
      {},
      { remoteJid: UNKNOWN_LID, fromMe: true },
      {
        testAllowlist: withSelf,
        chatPhone: SELF_PHONE,
        selfJids: new Set(['77000000009:12@s.whatsapp.net' as Jid]),
      },
    );

    expect(event).toMatchObject({ reason: 'not_allowlisted' });
  });

  it('клиент из списка проходит и тогда, когда номер бота тоже в списке', () => {
    expect(classify({}, {}, { testAllowlist: withSelf }).type).toBe('client');
  });
});

describe('classifyUpsert: закрытый режим', () => {
  const allowlist = new Set([CLIENT_PHONE]);

  it('номер из списка => обычная обработка', () => {
    expect(classify({}, {}, { testAllowlist: allowlist }).type).toBe('client');
  });

  it('номера нет в списке => not_allowlisted: только JID и время для known_chats, без текста', () => {
    const event = classify(
      { message: { conversation: 'секретный текст' } },
      { remoteJid: STRANGER_PN },
      { testAllowlist: allowlist, chatPhone: STRANGER_PHONE },
    );

    expect(event).toStrictEqual({
      type: 'ignore',
      reason: 'not_allowlisted',
      chatJid: STRANGER_PN,
      tsMs: FRESH_SECONDS * 1000,
    });
    expect(JSON.stringify(event)).not.toContain('секретный');
  });

  it('@lid без сопоставления с номером (chatPhone null) => not_allowlisted', () => {
    const event = classify(
      {},
      { remoteJid: CLIENT_LID, addressingMode: 'lid' },
      { testAllowlist: allowlist, chatPhone: null },
    );

    expect(event).toMatchObject({ type: 'ignore', reason: 'not_allowlisted', chatJid: CLIENT_LID });
  });

  it('@lid с номером из списка (определил адаптер) => обработка', () => {
    const event = classify(
      {},
      { remoteJid: CLIENT_LID, addressingMode: 'lid' },
      { testAllowlist: allowlist, chatPhone: CLIENT_PHONE },
    );

    expect(event.type).toBe('client');
  });

  it('для адреса с номером номер берётся из самого адреса, а не из chatPhone', () => {
    const fromAddress = classify({}, {}, { testAllowlist: allowlist, chatPhone: null });
    const wrongHint = classify(
      {},
      { remoteJid: STRANGER_PN },
      { testAllowlist: allowlist, chatPhone: CLIENT_PHONE },
    );

    expect(fromAddress.type).toBe('client');
    expect(wrongHint).toMatchObject({ type: 'ignore', reason: 'not_allowlisted' });
  });

  it('свои сообщения в чате не из списка тоже not_allowlisted: перехват и история не трогаются', () => {
    const event = classify(
      {},
      { remoteJid: STRANGER_PN, fromMe: true },
      { testAllowlist: allowlist, chatPhone: STRANGER_PHONE },
    );

    expect(event).toMatchObject({
      type: 'ignore',
      reason: 'not_allowlisted',
      chatJid: STRANGER_PN,
    });
  });

  it('пустой список => не обрабатывается никто', () => {
    expect(classify({}, {}, { testAllowlist: new Set() })).toMatchObject({
      reason: 'not_allowlisted',
    });
  });

  it('чужой чат без времени => not_allowlisted, для known_chats время разбора', () => {
    const event = classify(
      { messageTimestamp: null },
      { remoteJid: STRANGER_PN },
      { testAllowlist: allowlist, chatPhone: STRANGER_PHONE },
    );

    expect(event).toStrictEqual({
      type: 'ignore',
      reason: 'not_allowlisted',
      chatJid: STRANGER_PN,
      tsMs: NOW_MS,
    });
  });

  it('проверка списка раньше границы привязки: старое сообщение чужого чата => not_allowlisted', () => {
    const event = classify(
      { messageTimestamp: BEFORE_LINK_SECONDS },
      { remoteJid: STRANGER_PN },
      { testAllowlist: allowlist, chatPhone: STRANGER_PHONE },
    );

    expect(event).toStrictEqual({
      type: 'ignore',
      reason: 'not_allowlisted',
      chatJid: STRANGER_PN,
      tsMs: BEFORE_LINK_SECONDS * 1000,
    });
  });

  it('чат менеджера вне списка тоже not_allowlisted: список проверяется раньше', () => {
    const event = classify(
      {},
      { remoteJid: MANAGER_PN },
      { testAllowlist: allowlist, chatPhone: null },
    );

    expect(event).toMatchObject({ reason: 'not_allowlisted' });
  });

  it('служебное сообщение чужого чата => protocol: оно не считается перепиской', () => {
    const event = classify(
      { message: { reactionMessage: { text: '👍' } } },
      { remoteJid: STRANGER_PN },
      { testAllowlist: allowlist, chatPhone: STRANGER_PHONE },
    );

    expect(event).toStrictEqual({ type: 'ignore', reason: 'protocol' });
  });

  it('режим выключен (null) => @lid без номера обрабатывается', () => {
    const event = classify({}, { remoteJid: CLIENT_LID }, { chatPhone: null });

    expect(event.type).toBe('client');
  });
});

describe('classifyUpsert: граница привязки', () => {
  it('сообщение клиента до привязки => before_link с JID и временем, без текста', () => {
    const event = classify({ messageTimestamp: BEFORE_LINK_SECONDS });

    expect(event).toStrictEqual({
      type: 'ignore',
      reason: 'before_link',
      chatJid: CLIENT_PN,
      tsMs: BEFORE_LINK_SECONDS * 1000,
    });
  });

  it('своё сообщение до привязки => before_link', () => {
    const event = classify({ messageTimestamp: BEFORE_LINK_SECONDS }, { fromMe: true });

    expect(event).toMatchObject({ type: 'ignore', reason: 'before_link', chatJid: CLIENT_PN });
  });

  it('ровно в момент привязки => обрабатывается', () => {
    const event = classify(
      { messageTimestamp: toSeconds(LINKED_AT_MS) },
      {},
      { nowMs: LINKED_AT_MS + HOUR_MS },
    );

    expect(event.type).toBe('client');
  });

  const UNUSABLE_TIMES = [null, undefined, Number.NaN, 0, -5, Number.POSITIVE_INFINITY];

  it.each(UNUSABLE_TIMES)(
    'из офлайн-очереди или истории (append) время %s не годится => before_link, для known_chats время разбора',
    (messageTimestamp) => {
      expect(classify({ messageTimestamp }, {}, { upsertType: 'append' })).toStrictEqual({
        type: 'ignore',
        reason: 'before_link',
        chatJid: CLIENT_PN,
        tsMs: NOW_MS,
      });
    },
  );

  it.each(UNUSABLE_TIMES)(
    'живое (notify) без годного времени (%s) => время разбора: лид не пропадает молча',
    (messageTimestamp) => {
      expect(classify({ messageTimestamp })).toMatchObject({
        type: 'client',
        message: { tsMs: NOW_MS },
      });
    },
  );

  it('живое своё без времени => own со временем разбора', () => {
    expect(classify({ messageTimestamp: null }, { fromMe: true })).toMatchObject({
      type: 'own',
      message: { tsMs: NOW_MS },
    });
  });

  it('живое без времени, но часы бота ещё до момента привязки => before_link', () => {
    const event = classify({ messageTimestamp: null }, {}, { nowMs: LINKED_AT_MS - 1 });

    expect(event).toMatchObject({ reason: 'before_link', tsMs: LINKED_AT_MS - 1 });
  });

  it('время типа Long (эхо своей отправки, WebMessageInfo.fromObject) переводится из секунд в мс', () => {
    const echo = proto.WebMessageInfo.fromObject({
      key: { remoteJid: CLIENT_PN, fromMe: true, id: MESSAGE_ID },
      message: { conversation: 'Ответ бота' },
      messageTimestamp: FRESH_SECONDS,
    }) as unknown as WAMessage;

    expect(typeof echo.messageTimestamp).toBe('object');
    expect(classifyUpsert(echo, context())).toStrictEqual({
      type: 'own',
      message: {
        waId: MESSAGE_ID,
        chatJid: CLIENT_PN,
        content: { kind: 'text', text: 'Ответ бота' },
        tsMs: FRESH_SECONDS * 1000,
      },
    });
  });
});

describe('classifyUpsert: сам бот и менеджер', () => {
  it.each([SELF_PN, SELF_LID])('чат с самим собой (%s) => ignore self', (remoteJid) => {
    expect(classify({}, { remoteJid, fromMe: true })).toStrictEqual({
      type: 'ignore',
      reason: 'self',
    });
  });

  it('свои адреса с суффиксом устройства (как sock.user.id) тоже узнаются', () => {
    const event = classify(
      {},
      { remoteJid: SELF_PN, fromMe: true },
      { selfJids: new Set(['77000000009:12@s.whatsapp.net' as Jid]) },
    );

    expect(event).toStrictEqual({ type: 'ignore', reason: 'self' });
  });

  it('входящее с remoteJidAlt своего адреса => self', () => {
    const event = classify(
      {},
      { remoteJid: '100000000000099@lid', remoteJidAlt: SELF_PN, addressingMode: 'lid' },
      { chatPhone: null },
    );

    expect(event).toStrictEqual({ type: 'ignore', reason: 'self' });
  });

  it('своё сообщение клиенту с remoteJidAlt своего адреса остаётся own, а не self', () => {
    const event = classify({}, { fromMe: true, remoteJidAlt: SELF_LID });

    expect(event.type).toBe('own');
  });

  it.each([false, true])('чат менеджера (fromMe: %s) => ignore manager', (fromMe) => {
    expect(classify({}, { remoteJid: MANAGER_PN, fromMe })).toStrictEqual({
      type: 'ignore',
      reason: 'manager',
    });
  });

  it('менеджер узнаётся по remoteJidAlt, если его @lid неизвестен', () => {
    const event = classify(
      {},
      {
        remoteJid: MANAGER_LID,
        remoteJidAlt: '77000000005:3@s.whatsapp.net',
        addressingMode: 'lid',
      },
      { managerJids: new Set([MANAGER_PN]), chatPhone: null },
    );

    expect(event).toStrictEqual({ type: 'ignore', reason: 'manager' });
  });

  it('менеджер не задан => обычный клиент', () => {
    expect(classify({}, {}, { managerJids: new Set() }).type).toBe('client');
  });
});

describe('classifyUpsert: свои сообщения с номера бота', () => {
  it('fromMe после привязки => own с содержимым, JID чата и временем', () => {
    expect(classify({ message: { conversation: 'Добрый день' } }, { fromMe: true })).toStrictEqual({
      type: 'own',
      message: {
        waId: MESSAGE_ID,
        chatJid: CLIENT_PN,
        content: { kind: 'text', text: 'Добрый день' },
        tsMs: FRESH_SECONDS * 1000,
      },
    });
  });

  it('своё сообщение старше порога простоя всё равно own: перехват чата не теряется', () => {
    const event = classify({ messageTimestamp: STALE_SECONDS }, { fromMe: true });

    expect(event).toMatchObject({ type: 'own', message: { tsMs: STALE_SECONDS * 1000 } });
  });

  it('own в чате @lid несёт JID чата как пришёл', () => {
    const event = classify({}, { remoteJid: CLIENT_LID, fromMe: true });

    expect(event).toMatchObject({ type: 'own', message: { chatJid: CLIENT_LID } });
  });
});

describe('classifyUpsert: простой бота', () => {
  it('сообщение клиента старше порога => stale с полным сообщением', () => {
    const event = classify({ messageTimestamp: STALE_SECONDS });

    expect(event.type).toBe('stale');
    expect(inboundOf(event)).toMatchObject({
      waId: MESSAGE_ID,
      content: { kind: 'text', text: 'Здравствуйте' },
      tsMs: STALE_SECONDS * 1000,
    });
  });

  it('ровно на пороге => client', () => {
    const atThreshold = toSeconds(NOW_MS - BACKLOG_MAX_AGE_MS);

    expect(classify({ messageTimestamp: atThreshold }).type).toBe('client');
    expect(classify({ messageTimestamp: atThreshold - 1 }).type).toBe('stale');
  });

  it('время из будущего (часы разошлись) => client', () => {
    expect(classify({ messageTimestamp: toSeconds(NOW_MS + HOUR_MS) }).type).toBe('client');
  });
});

describe('classifyUpsert: адреса клиента', () => {
  it('чат @lid с номером в remoteJidAlt (addressingMode lid)', () => {
    const event = classify(
      {},
      { remoteJid: CLIENT_LID, remoteJidAlt: CLIENT_PN, addressingMode: 'lid' },
    );

    expect(inboundOf(event).identity).toEqual({
      replyJid: CLIENT_LID,
      lidJid: CLIENT_LID,
      pnJid: CLIENT_PN,
    });
  });

  it('чат с номером и @lid в remoteJidAlt (addressingMode pn)', () => {
    const event = classify({}, { remoteJidAlt: CLIENT_LID, addressingMode: 'pn' });

    expect(inboundOf(event).identity).toEqual({
      replyJid: CLIENT_PN,
      lidJid: CLIENT_LID,
      pnJid: CLIENT_PN,
    });
  });

  it('@lid без remoteJidAlt, номер определил адаптер (getPNForLID): адрес с номером из него', () => {
    const event = classify({}, { remoteJid: CLIENT_LID }, { chatPhone: CLIENT_PHONE });

    expect(inboundOf(event).identity).toEqual({
      replyJid: CLIENT_LID,
      lidJid: CLIENT_LID,
      pnJid: CLIENT_PN,
    });
  });

  it('@lid без remoteJidAlt и без номера: адреса с номером нет', () => {
    const event = classify({}, { remoteJid: CLIENT_LID }, { chatPhone: null });

    expect(inboundOf(event).identity.pnJid).toBeNull();
  });

  it('remoteJidAlt с суффиксом устройства нормализуется', () => {
    const event = classify(
      {},
      { remoteJid: CLIENT_LID, remoteJidAlt: '77000000001:5@s.whatsapp.net' },
    );

    expect(inboundOf(event).identity.pnJid).toBe(CLIENT_PN);
  });

  it.each([
    ['группа', '120363000000000001@g.us'],
    ['мусор', 'не адрес'],
    ['тот же тип, что remoteJid', '77000000003@s.whatsapp.net'],
  ])('remoteJidAlt не годится (%s) => пропускается', (_label, remoteJidAlt) => {
    const event = classify({}, { remoteJidAlt });

    expect(inboundOf(event).identity).toEqual({
      replyJid: CLIENT_PN,
      lidJid: null,
      pnJid: CLIENT_PN,
    });
  });
});

describe('classifyUpsert: содержимое', () => {
  it('extendedTextMessage.text => text', () => {
    expect(textOf(classify({ message: { extendedTextMessage: { text: 'Сколько стоит?' } } }))).toBe(
      'Сколько стоит?',
    );
  });

  it('исчезающее сообщение разворачивается (normalizeMessageContent)', () => {
    const message = { ephemeralMessage: { message: { extendedTextMessage: { text: 'Привет' } } } };

    expect(textOf(classify({ message }))).toBe('Привет');
  });

  it('голосовое (audioMessage с ptt) => voice с MediaRef, типом и длительностью', () => {
    const message = { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus', seconds: 7 } };

    expect(contentOf(classify({ message }))).toStrictEqual({
      kind: 'voice',
      media: MESSAGE_ID as MediaRef,
      mimeType: 'audio/ogg; codecs=opus',
      seconds: 7,
    });
  });

  it.each([undefined, null, '', 'audio/ogg\n; x', `audio/${'a'.repeat(200)}`, '<script>'])(
    'тип голосового %j не годится => тип голосовых WhatsApp по умолчанию',
    (mimetype) => {
      const content = contentOf(classify({ message: { audioMessage: { ptt: true, mimetype } } }));

      expect(content).toMatchObject({ kind: 'voice', mimeType: 'audio/ogg; codecs=opus' });
    },
  );

  it.each([undefined, null, -1, 1.5, Number.NaN])(
    'длительность %s не годится => seconds null',
    (seconds) => {
      const content = contentOf(classify({ message: { audioMessage: { ptt: true, seconds } } }));

      expect(content).toMatchObject({ kind: 'voice', seconds: null });
    },
  );

  it('голосовое внутри просмотра один раз тоже voice', () => {
    const message = { viewOnceMessageV2: { message: { audioMessage: { ptt: true, seconds: 3 } } } };

    expect(contentOf(classify({ message })).kind).toBe('voice');
  });

  it.each([
    ['аудиофайл без ptt', { audioMessage: { ptt: false, mimetype: 'audio/mpeg' } }],
    ['фото с подписью', { imageMessage: { caption: 'Вот склад' } }],
    ['фото один раз', { viewOnceMessageV2: { message: { imageMessage: { caption: 'x' } } } }],
    [
      'документ с подписью',
      { documentWithCaptionMessage: { message: { documentMessage: { caption: 'КП' } } } },
    ],
    ['стикер', { stickerMessage: { isAnimated: false } }],
    ['геопозиция', { locationMessage: { degreesLatitude: 43.2 } }],
    ['контакт', { contactMessage: { displayName: 'Иван' } }],
    ['видеокружок', { ptvMessage: { seconds: 5 } }],
    ['текст из одних невидимых символов', { conversation: '​‌﻿' }],
    ['текст из одних пробелов', { conversation: '   \n  ' }],
    ['пустой extendedTextMessage', { extendedTextMessage: { text: '' } }],
  ])('%s => other', (_label, message) => {
    expect(contentOf(classify({ message }))).toStrictEqual({ kind: 'other' });
  });

  it('просмотр один раз, недоступный связанному устройству (нет содержимого, key.isViewOnce) => other', () => {
    const event = classify({ message: undefined }, { isViewOnce: true });

    expect(event.type).toBe('client');
    expect(contentOf(event)).toStrictEqual({ kind: 'other' });
  });
});

describe('classifyUpsert: очистка текста клиента', () => {
  function cleanedText(text: string): string | null {
    return textOf(classify({ message: { conversation: text } }));
  }

  it('удаляет управляющие символы Cc, кроме переноса строки', () => {
    expect(cleanedText('Добрый\u0000 день\r\nцена?\u0007\u0085')).toBe('Добрый день\nцена?');
  });

  it('удаляет невидимые Cf: zero-width, U+FEFF, мягкий перенос, bidi', () => {
    const text = '​при­вет﻿ ‮мир‬ ⁦x⁩‍!';

    expect(cleanedText(text)).toBe('привет мир x!');
  });

  it('нормализует NFKC: полноширинные буквы, лигатуры, цифры в кружках', () => {
    expect(cleanedText('ＲＦＩＤ ﬁle ①')).toBe('RFID file 1');
  });

  it('сначала удаляет невидимое, потом NFKC: результат нормализован', () => {
    const text = cleanedText('e​́');

    expect(text).toBe('é');
    expect(text).toBe(text?.normalize('NFKC'));
  });

  it('обрезает пробелы по краям', () => {
    expect(cleanedText('  Здравствуйте \n')).toBe('Здравствуйте');
  });

  it('лимит длины ставится после NFKC: строка, раздутая нормализацией, обрезается', () => {
    const text = cleanedText('ﷺ'.repeat(300)) ?? '';

    expect('ﷺ'.normalize('NFKC').length).toBe(18);
    expect([...text]).toHaveLength(MAX_TEXT_CHARS);
  });

  it('лимит считается в символах и не рвёт суррогатные пары', () => {
    const text = cleanedText('😀'.repeat(MAX_TEXT_CHARS + 100)) ?? '';

    expect([...text]).toHaveLength(MAX_TEXT_CHARS);
    expect(LONE_SURROGATE.test(text)).toBe(false);
  });

  it('текст в пределах лимита не меняется', () => {
    const text = 'а'.repeat(MAX_TEXT_CHARS);

    expect(cleanedText(text)).toBe(text);
  });

  it.each(['a\u0000\u0001\u001F\u007F\u0080\u009Fb', ' строка ', 'x͏᠎⁠⁡⁤￹￻y', '👩‍💻', 'Ａ́​̈'])(
    'после очистки нет Cc и Cf (кроме \\n), текст в NFKC: %j',
    (raw) => {
      const text = cleanedText(raw) ?? '';

      expect(INVISIBLE_OR_CONTROL.test(text.replaceAll('\n', ''))).toBe(false);
      expect(text).toBe(text.normalize('NFKC'));
    },
  );
});

describe('classifyUpsert: очистка имени из профиля', () => {
  function cleanedName(pushName: unknown): string | null {
    return inboundOf(classify({ pushName })).pushName;
  }

  it('удаляет переносы строк, Cc и Cf и нормализует NFKC', () => {
    expect(cleanedName('Ай\nге​рим\u0000 ＫＺ')).toBe('Айгерим KZ');
  });

  it('лимит имени после NFKC', () => {
    expect([...(cleanedName('ﷺ'.repeat(10)) ?? '')]).toHaveLength(MAX_PUSH_NAME_CHARS);
  });

  it.each([undefined, null, '', '  ​ ', 42])('имя %j => null', (pushName) => {
    expect(cleanedName(pushName)).toBeNull();
  });
});

describe('classifyUpsert: подтверждённое имя бизнес-аккаунта', () => {
  const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
  const NUL = String.fromCodePoint(0);
  const FULLWIDTH_KZ = String.fromCodePoint(0xff2b, 0xff3a);
  const EMOJI = String.fromCodePoint(0x1f600);

  function verifiedName(verifiedBizName: unknown): string | null | undefined {
    return inboundOf(classify({ verifiedBizName })).verifiedName;
  }

  it('берётся из verifiedBizName и несётся в сообщении клиента', () => {
    expect(verifiedName('ТОО Ромашка')).toBe('ТОО Ромашка');
  });

  it('очищается так же, как имя из профиля: Cc, Cf, NFKC, пробелы по краям', () => {
    const raw = `  Ромашка\n${ZERO_WIDTH_SPACE}${NUL} ${FULLWIDTH_KZ} `;

    expect(verifiedName(raw)).toBe('Ромашка KZ');
  });

  it('лимит имени 100 символов после NFKC, суррогатные пары не рвутся', () => {
    const name = verifiedName(EMOJI.repeat(150)) ?? '';

    expect([...name]).toHaveLength(MAX_VERIFIED_NAME_CHARS);
    expect(MAX_VERIFIED_NAME_CHARS).toBe(100);
    expect(name).toBe(EMOJI.repeat(MAX_VERIFIED_NAME_CHARS));
  });

  it.each([
    ['нет поля', undefined],
    ['null', null],
    ['пустая строка', ''],
    ['пробелы и невидимое', `  ${ZERO_WIDTH_SPACE} `],
    ['не строка', 42],
  ])('%s => null', (_label, raw) => {
    expect(verifiedName(raw)).toBeNull();
  });

  it('есть и у сообщения простоя (stale)', () => {
    const event = classify({ messageTimestamp: STALE_SECONDS, verifiedBizName: 'Ромашка' });

    expect(event.type).toBe('stale');
    expect(inboundOf(event).verifiedName).toBe('Ромашка');
  });

  it('у своих сообщений имени нет: наружу оно не уходит', () => {
    const own = classify({ verifiedBizName: 'Ромашка' }, { fromMe: true });

    expect(JSON.stringify(own)).not.toContain('Ромашка');
  });
});

describe('classifyUpsert: чистая функция', () => {
  it('не меняет входное сообщение и контекст', () => {
    const message = waMessage(
      { message: { ephemeralMessage: { message: { conversation: '​Привет' } } } },
      { remoteJid: '77000000001:3@s.whatsapp.net', remoteJidAlt: CLIENT_LID },
    );
    const snapshot = JSON.stringify(message);
    const ctx = context();

    expect(classifyUpsert(message, ctx).type).toBe('client');
    expect(JSON.stringify(message)).toBe(snapshot);
    expect(ctx).toEqual(context());
  });
});
