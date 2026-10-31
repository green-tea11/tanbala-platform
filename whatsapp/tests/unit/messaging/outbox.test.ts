import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createChatsRepo } from '../../../src/db/repos/chats.js';
import { createMessagesRepo } from '../../../src/db/repos/messages.js';
import { createOutboundIdsRepo } from '../../../src/db/repos/outbound-ids.js';
import type { ChatsRepo, Clock, MessageSender, MessagesRepo } from '../../../src/domain/ports.js';
import type {
  ChatId,
  HandoffNotice,
  Jid,
  PhoneDigits,
  ReviewedText,
  WaMessageId,
} from '../../../src/domain/types.js';
import {
  CLIENT_SENDS_PER_CHAT_PER_HOUR,
  CLIENT_SENDS_PER_HOUR,
  createOutbox,
  HOT_PRICE_HANDOFF_TEXT,
  MANAGER_NOTIFY_PER_HOUR,
  PANEL_TEXT_MAX_LENGTH,
  panelTextProblem,
  PanelSendError,
  VOICE_NOTICE_TEXT,
  type Outbox,
} from '../../../src/messaging/outbox.js';
import { SafeError } from '../../../src/shared/safe-error.js';
import { insertChat, LID_A, PN_A, PN_B, useMigratedDb } from '../db/fixture.js';

const T0 = 1_761_400_000_000;
const HOUR_MS = 60 * 60 * 1000;
const PHONE_A = '77000000001' as PhoneDigits;
const MANAGER_JID = '77000000009@s.whatsapp.net' as Jid;
const IN_1 = 'IN-1' as WaMessageId;
const REPLY = 'Учитывать можно любые вещи. Что у вас за бизнес?' as ReviewedText;

/** Шаг поддельного шлюза или часов: outbox только отправляет, «печатает» и паузы показывает конвейер. */
type Step =
  | { readonly step: 'typing'; readonly jid: Jid; readonly on: boolean }
  | { readonly step: 'sleep'; readonly ms: number }
  | {
      readonly step: 'send';
      readonly jid: Jid;
      readonly text: string;
      readonly waId: WaMessageId;
      /** Статус записи outbound_ids в момент отправки: запись обязана быть до неё. */
      readonly recordedAs: unknown;
    };

interface SetupOptions {
  readonly allowlist?: ReadonlySet<PhoneDigits> | null;
  readonly managerJid?: Jid | null;
  readonly random?: () => number;
}

interface Harness {
  readonly db: Database.Database;
  readonly outbox: Outbox;
  readonly chats: ChatsRepo;
  readonly messages: MessagesRepo;
  readonly steps: readonly Step[];
  /** Чат клиента из TEST_ALLOWLIST с неотвеченным входящим IN_1. */
  readonly chatId: ChatId;
  /** Следующие отправки падают с этой ошибкой. */
  failSends(error: Error): void;
  advance(ms: number): void;
  /** Чат с неотвеченным входящим IN_1. */
  addChat(seed: {
    readonly replyJid: Jid;
    readonly pnJid?: Jid | null;
    readonly lidJid?: Jid | null;
  }): ChatId;
}

function setup(options: SetupOptions = {}): Harness {
  const db = useMigratedDb();
  const steps: Step[] = [];
  let now = T0;
  let nextId = 0;
  let sendError: Error | null = null;
  const clock: Clock = {
    now: () => now,
    sleep: (ms) => {
      steps.push({ step: 'sleep', ms });
      return Promise.resolve();
    },
  };
  const sender: MessageSender = {
    newMessageId: () => {
      nextId += 1;
      return `OUT-${nextId}` as WaMessageId;
    },
    sendText: (jid, text, waId) => {
      const recordedAs: unknown = db
        .prepare('SELECT status FROM outbound_ids WHERE wa_id = ?')
        .pluck()
        .get(waId);
      steps.push({ step: 'send', jid, text, waId, recordedAs });
      return sendError === null ? Promise.resolve() : Promise.reject(sendError);
    },
    setTyping: (jid, on) => {
      steps.push({ step: 'typing', jid, on });
      return Promise.resolve();
    },
  };
  const chats = createChatsRepo(db);
  const messages = createMessagesRepo(db);
  const outbox = createOutbox({
    sender,
    chats,
    messages,
    outboundIds: createOutboundIdsRepo(db),
    clock,
    managerJid: options.managerJid === undefined ? MANAGER_JID : options.managerJid,
    testAllowlist: options.allowlist === undefined ? new Set([PHONE_A]) : options.allowlist,
    random: options.random ?? (() => 0),
  });
  const addChat: Harness['addChat'] = (seed) => {
    const chatId = insertChat(db, seed);
    messages.insertIfNew({
      chatId,
      waId: IN_1,
      author: 'client',
      kind: 'text',
      text: 'Здравствуйте',
      tsMs: T0 - 1000,
    });
    return chatId;
  };
  return {
    db,
    outbox,
    chats,
    messages,
    steps,
    chatId: addChat({ replyJid: PN_A, pnJid: PN_A }),
    failSends: (error) => {
      sendError = error;
    },
    advance: (ms) => {
      now += ms;
    },
    addChat,
  };
}

function outboundRows(db: Database.Database): unknown[] {
  return db
    .prepare(
      'SELECT wa_id, chat_id, jid, origin, text, status, created_at FROM outbound_ids ORDER BY created_at, wa_id',
    )
    .all();
}

function botMessages(db: Database.Database): unknown[] {
  return db
    .prepare(
      "SELECT chat_id, wa_id, kind, text, ts_ms FROM messages WHERE author = 'bot' ORDER BY id",
    )
    .all();
}

function sentTexts(steps: readonly Step[]): string[] {
  return steps.flatMap((step) => (step.step === 'send' ? [step.text] : []));
}

describe('createOutbox: sendBotReply', () => {
  it('отправка с ID, записанным в outbound_ids до неё; без «печатает» и пауз (их показывает конвейер)', async () => {
    const h = setup();

    await expect(h.outbox.sendBotReply(h.chatId, REPLY, IN_1)).resolves.toBe('sent');

    expect(h.steps).toEqual([
      { step: 'send', jid: PN_A, text: REPLY, waId: 'OUT-1', recordedAs: 'pending' },
    ]);
    expect(outboundRows(h.db)).toEqual([
      {
        wa_id: 'OUT-1',
        chat_id: h.chatId,
        jid: PN_A,
        origin: 'bot_reply',
        text: REPLY,
        status: 'sent',
        created_at: T0,
      },
    ]);
  });

  it('ответ сохраняется в истории как сообщение бота с ID отправки', async () => {
    const h = setup();

    await h.outbox.sendBotReply(h.chatId, REPLY, IN_1);

    expect(botMessages(h.db)).toEqual([
      {
        chat_id: h.chatId,
        wa_id: 'OUT-1',
        kind: 'text',
        text: REPLY,
        ts_ms: T0,
      },
    ]);
  });

  it('отвечает на адрес, с которого пишет клиент (@lid), а номер для закрытого режима берёт из pnJid', async () => {
    const h = setup();
    const lidChat = h.addChat({
      replyJid: LID_A,
      lidJid: LID_A,
      pnJid: '77000000001:3@s.whatsapp.net' as Jid,
    });

    await expect(h.outbox.sendBotReply(lidChat, REPLY, IN_1)).resolves.toBe('sent');
    expect(sentTexts(h.steps)).toEqual([REPLY]);
    expect(h.steps.at(-1)).toMatchObject({ step: 'send', jid: LID_A });
  });

  it('чат ведёт менеджер: молчит без записи', async () => {
    const h = setup();
    h.chats.setStatus(h.chatId, { status: 'manager', by: 'phone' }, T0);

    await expect(h.outbox.sendBotReply(h.chatId, REPLY, IN_1)).resolves.toBe('skipped_manager');
    expect(h.steps).toEqual([]);
    expect(outboundRows(h.db)).toEqual([]);
  });

  it('статус перечитывается при каждой отправке: человек подключился после первого ответа, второй не уходит', async () => {
    const h = setup();
    await h.outbox.sendBotReply(h.chatId, REPLY, IN_1);
    h.chats.setStatus(h.chatId, { status: 'manager', by: 'phone' }, T0 + 1);

    await expect(h.outbox.sendBotReply(h.chatId, REPLY, IN_1)).resolves.toBe('skipped_manager');
    expect(sentTexts(h.steps)).toEqual([REPLY]);
    expect(botMessages(h.db)).toHaveLength(1);
  });

  it('входящее уже отвечено или неизвестно: skipped_no_inbound без отправки', async () => {
    const h = setup();
    h.messages.markAnswered(h.chatId, IN_1);

    await expect(h.outbox.sendBotReply(h.chatId, REPLY, IN_1)).resolves.toBe('skipped_no_inbound');
    await expect(h.outbox.sendBotReply(h.chatId, REPLY, 'NONE' as WaMessageId)).resolves.toBe(
      'skipped_no_inbound',
    );
    expect(h.steps).toEqual([]);
  });

  it('закрытый режим: номер не из TEST_ALLOWLIST или неизвестен (только @lid) => skipped_test_mode', async () => {
    const h = setup();
    const stranger = h.addChat({ replyJid: PN_B, pnJid: PN_B });
    const lidOnly = h.addChat({ replyJid: LID_A, lidJid: LID_A });

    await expect(h.outbox.sendBotReply(stranger, REPLY, IN_1)).resolves.toBe('skipped_test_mode');
    await expect(h.outbox.sendBotReply(lidOnly, REPLY, IN_1)).resolves.toBe('skipped_test_mode');
    expect(h.steps).toEqual([]);
    expect(outboundRows(h.db)).toEqual([]);
  });

  it('закрытый режим выключен (null): отвечает в любой чат', async () => {
    const h = setup({ allowlist: null });
    const other = h.addChat({ replyJid: PN_B, pnJid: PN_B });

    await expect(h.outbox.sendBotReply(other, REPLY, IN_1)).resolves.toBe('sent');
  });

  it('сбой отправки: запись failed, ошибка пробрасывается, в историю не пишется', async () => {
    const h = setup();
    const failure = new Error('нет связи');
    h.failSends(failure);

    await expect(h.outbox.sendBotReply(h.chatId, REPLY, IN_1)).rejects.toBe(failure);
    expect(outboundRows(h.db)).toEqual([
      expect.objectContaining({ wa_id: 'OUT-1', status: 'failed' }),
    ]);
    expect(botMessages(h.db)).toEqual([]);
  });

  it('пустой текст и неизвестный чат: явная ошибка без отправки', async () => {
    const h = setup();

    await expect(h.outbox.sendBotReply(h.chatId, '  ' as ReviewedText, IN_1)).rejects.toThrow(
      /пуст/i,
    );
    await expect(h.outbox.sendBotReply(404 as ChatId, REPLY, IN_1)).rejects.toThrow(/404/);
    expect(h.steps).toEqual([]);
  });
});

describe('createOutbox: лимиты исходящих в чаты клиентов', () => {
  it('сверх лимита на чат за час: skipped_limit для любых фраз, другой чат отвечает, через час снова можно', async () => {
    const h = setup({ allowlist: null });
    for (let i = 0; i < CLIENT_SENDS_PER_CHAT_PER_HOUR; i += 1) {
      await expect(h.outbox.sendBotReply(h.chatId, REPLY, IN_1)).resolves.toBe('sent');
    }
    const other = h.addChat({ replyJid: PN_B, pnJid: PN_B });

    await expect(h.outbox.sendBotReply(h.chatId, REPLY, IN_1)).resolves.toBe('skipped_limit');
    await expect(h.outbox.sendVoiceNotice(h.chatId, IN_1)).resolves.toBe('skipped_limit');
    await expect(h.outbox.sendHandoffNotice(h.chatId, { reason: 'llm_error' }, IN_1)).resolves.toBe(
      'skipped_limit',
    );
    await expect(h.outbox.sendBotReply(other, REPLY, IN_1)).resolves.toBe('sent');
    h.advance(HOUR_MS);
    await expect(h.outbox.sendBotReply(h.chatId, REPLY, IN_1)).resolves.toBe('sent');
  });

  it('сверх общего лимита за час: skipped_limit в любом чате', async () => {
    const h = setup({ allowlist: null });
    const chatCount = Math.ceil(CLIENT_SENDS_PER_HOUR / CLIENT_SENDS_PER_CHAT_PER_HOUR);
    const chatIds = Array.from({ length: chatCount }, (_, index) =>
      h.addChat({ replyJid: `${100 + index}@lid` as Jid }),
    );
    let sent = 0;
    for (const chatId of chatIds) {
      for (let i = 0; i < CLIENT_SENDS_PER_CHAT_PER_HOUR && sent < CLIENT_SENDS_PER_HOUR; i += 1) {
        await h.outbox.sendBotReply(chatId, REPLY, IN_1);
        sent += 1;
      }
    }

    await expect(h.outbox.sendBotReply(h.chatId, REPLY, IN_1)).resolves.toBe('skipped_limit');
    expect(sentTexts(h.steps)).toHaveLength(CLIENT_SENDS_PER_HOUR);
  });
});

describe('createOutbox: sendHandoffNotice', () => {
  /** Один голос (решение владельца 29.10.2026): бот сам уточнит у коллеги, без сроков и без «он вам напишет». */
  const ONE_VOICE = 'Уточню у коллеги и вернусь к вам.';
  const single: readonly (readonly [string, HandoffNotice])[] = [
    ['hot', { reason: 'hot' }],
    ['asked_human', { reason: 'asked_human' }],
    ['no_answer', { reason: 'no_answer' }],
    ['check_failed', { reason: 'check_failed' }],
    ['llm_error', { reason: 'llm_error' }],
  ];
  const cases: readonly (readonly [string, HandoffNotice, RegExp])[] = [
    [
      'complaint',
      { reason: 'complaint', stopRequested: false },
      /^(извините|простите|приношу извинения)[^.]*\. Уточню у коллеги и вернусь к вам\.$/i,
    ],
    [
      'complaint со stopRequested',
      { reason: 'complaint', stopRequested: true },
      /^(извините|простите)/i,
    ],
  ];

  /** Фразы всех вариантов: случайность выбирает вариант. */
  async function phrasesOf(notice: HandoffNotice): Promise<string[]> {
    const texts: string[] = [];
    for (const value of [0, 0.5, 0.999]) {
      const h = setup({ random: () => value });
      await expect(h.outbox.sendHandoffNotice(h.chatId, notice, IN_1)).resolves.toBe('sent');
      texts.push(...sentTexts(h.steps));
    }
    return texts;
  }

  it.each(single)(
    '%s: ровно «Уточню у коллеги и вернусь к вам.» при любой случайности',
    async (_label, notice) => {
      const texts = await phrasesOf(notice);

      expect(texts).toEqual([ONE_VOICE, ONE_VOICE, ONE_VOICE]);
    },
  );

  it.each(cases)(
    '%s: фиксированная фраза по поводу, несколько вариантов',
    async (_label, notice, phrase) => {
      const texts = await phrasesOf(notice);

      expect(texts).toHaveLength(3);
      for (const text of texts) expect(text).toMatch(phrase);
      expect(new Set(texts).size).toBeGreaterThan(1);
    },
  );

  it('hot после вопроса цены (aboutPrice): ровно фраза о решении и ориентире при любой случайности (решение владельца 30.10.2026)', async () => {
    const texts = await phrasesOf({ reason: 'hot', aboutPrice: true });

    expect(HOT_PRICE_HANDOFF_TEXT).toBe('Я уточню у коллеги решение и ориентир под вашу задачу.');
    expect(texts).toEqual([HOT_PRICE_HANDOFF_TEXT, HOT_PRICE_HANDOFF_TEXT, HOT_PRICE_HANDOFF_TEXT]);
  });

  it('hot с aboutPrice false: обычные варианты без слов о цене', async () => {
    const texts = await phrasesOf({ reason: 'hot', aboutPrice: false });

    for (const text of texts) expect(text).toBe(ONE_VOICE);
  });

  it('complaint со stopRequested: только извинение, без «уточню» и «вернусь»', async () => {
    const texts = await phrasesOf({ reason: 'complaint', stopRequested: true });

    for (const text of texts) expect(text).not.toMatch(/коллег|уточн|вернусь/i);
  });

  it('случайность NaN выбирает первый вариант, а не пустую фразу', async () => {
    const [first] = await phrasesOf({ reason: 'hot' });
    const h = setup({ random: () => Number.NaN });

    await h.outbox.sendHandoffNotice(h.chatId, { reason: 'hot' }, IN_1);

    expect(sentTexts(h.steps)).toEqual([first]);
  });

  it('фразы без тире, ссылок, обещаний времени и чужого голоса («специалист», «напишет»)', async () => {
    const notices = [...single, ...cases].map(([, notice]) => notice);
    const texts = (await Promise.all(notices.map((notice) => phrasesOf(notice)))).flat();

    for (const text of [...texts, HOT_PRICE_HANDOFF_TEXT]) {
      expect(text).not.toMatch(
        /[\u2010-\u2015\u2212-]|https?:|www\.|сейчас|минут|час|сегодня|завтра|специалист|напишет/i,
      );
    }
  });

  it('статус не проверяет: чат уже у менеджера; источник handoff_notice, фраза в истории', async () => {
    const h = setup();
    h.chats.setStatus(h.chatId, { status: 'manager', by: 'bot' }, T0);

    await expect(h.outbox.sendHandoffNotice(h.chatId, { reason: 'no_answer' }, IN_1)).resolves.toBe(
      'sent',
    );
    expect(outboundRows(h.db)).toEqual([
      expect.objectContaining({ origin: 'handoff_notice', status: 'sent', chat_id: h.chatId }),
    ]);
    expect(botMessages(h.db)).toEqual([expect.objectContaining({ wa_id: 'OUT-1' })]);
    expect(h.steps.map((step) => step.step)).toEqual(['send']);
  });

  it('без неотвеченного входящего или вне TEST_ALLOWLIST не отправляет', async () => {
    const h = setup();
    const stranger = h.addChat({ replyJid: PN_B, pnJid: PN_B });

    await expect(
      h.outbox.sendHandoffNotice(h.chatId, { reason: 'hot' }, 'NONE' as WaMessageId),
    ).resolves.toBe('skipped_no_inbound');
    await expect(h.outbox.sendHandoffNotice(stranger, { reason: 'hot' }, IN_1)).resolves.toBe(
      'skipped_test_mode',
    );
    expect(h.steps).toEqual([]);
  });
});

describe('createOutbox: sendHandoffText', () => {
  const HANDOFF_TEXT =
    'Да, мы проводим интеграцию с вашей 1С. Уточню у коллеги и вернусь к вам.' as ReviewedText;

  it('отправляет ровно этот текст вместо фиксированной фразы: ID записан до отправки, источник handoff_notice, текст в истории', async () => {
    const h = setup();

    await expect(h.outbox.sendHandoffText(h.chatId, HANDOFF_TEXT, IN_1)).resolves.toBe('sent');

    expect(h.steps).toEqual([
      { step: 'send', jid: PN_A, text: HANDOFF_TEXT, waId: 'OUT-1', recordedAs: 'pending' },
    ]);
    expect(outboundRows(h.db)).toEqual([
      expect.objectContaining({
        origin: 'handoff_notice',
        text: HANDOFF_TEXT,
        status: 'sent',
        chat_id: h.chatId,
      }),
    ]);
    expect(botMessages(h.db)).toEqual([
      expect.objectContaining({ wa_id: 'OUT-1', text: HANDOFF_TEXT }),
    ]);
  });

  it('статус не проверяет: чат уже у менеджера', async () => {
    const h = setup();
    h.chats.setStatus(h.chatId, { status: 'manager', by: 'bot' }, T0);

    await expect(h.outbox.sendHandoffText(h.chatId, HANDOFF_TEXT, IN_1)).resolves.toBe('sent');
    expect(sentTexts(h.steps)).toEqual([HANDOFF_TEXT]);
  });

  it('те же проверки, что у фиксированной фразы: нет неотвеченного входящего или чат не из TEST_ALLOWLIST', async () => {
    const h = setup();
    const stranger = h.addChat({ replyJid: PN_B, pnJid: PN_B });
    const lidOnly = h.addChat({ replyJid: LID_A, lidJid: LID_A });

    await expect(
      h.outbox.sendHandoffText(h.chatId, HANDOFF_TEXT, 'NONE' as WaMessageId),
    ).resolves.toBe('skipped_no_inbound');
    await expect(h.outbox.sendHandoffText(stranger, HANDOFF_TEXT, IN_1)).resolves.toBe(
      'skipped_test_mode',
    );
    await expect(h.outbox.sendHandoffText(lidOnly, HANDOFF_TEXT, IN_1)).resolves.toBe(
      'skipped_test_mode',
    );
    h.messages.markAnswered(h.chatId, IN_1);
    await expect(h.outbox.sendHandoffText(h.chatId, HANDOFF_TEXT, IN_1)).resolves.toBe(
      'skipped_no_inbound',
    );
    expect(h.steps).toEqual([]);
    expect(outboundRows(h.db)).toEqual([]);
  });

  it('закрытый режим выключен (null): пишет в любой чат', async () => {
    const h = setup({ allowlist: null });
    const other = h.addChat({ replyJid: PN_B, pnJid: PN_B });

    await expect(h.outbox.sendHandoffText(other, HANDOFF_TEXT, IN_1)).resolves.toBe('sent');
  });

  it('часовой лимит на чат общий с остальными исходящими клиенту: сверх лимита skipped_limit', async () => {
    const h = setup({ allowlist: null });
    for (let i = 0; i < CLIENT_SENDS_PER_CHAT_PER_HOUR - 1; i += 1) {
      await h.outbox.sendBotReply(h.chatId, REPLY, IN_1);
    }

    await expect(h.outbox.sendHandoffText(h.chatId, HANDOFF_TEXT, IN_1)).resolves.toBe('sent');
    await expect(h.outbox.sendHandoffText(h.chatId, HANDOFF_TEXT, IN_1)).resolves.toBe(
      'skipped_limit',
    );
    await expect(h.outbox.sendHandoffNotice(h.chatId, { reason: 'hot' }, IN_1)).resolves.toBe(
      'skipped_limit',
    );
    h.advance(HOUR_MS);
    await expect(h.outbox.sendHandoffText(h.chatId, HANDOFF_TEXT, IN_1)).resolves.toBe('sent');
  });

  it('сбой отправки: запись failed, ошибка пробрасывается, в историю не пишется', async () => {
    const h = setup();
    const failure = new Error('нет связи');
    h.failSends(failure);

    await expect(h.outbox.sendHandoffText(h.chatId, HANDOFF_TEXT, IN_1)).rejects.toBe(failure);
    expect(outboundRows(h.db)).toEqual([
      expect.objectContaining({ wa_id: 'OUT-1', origin: 'handoff_notice', status: 'failed' }),
    ]);
    expect(botMessages(h.db)).toEqual([]);
  });

  it('пустой текст и неизвестный чат: явная ошибка без отправки', async () => {
    const h = setup();

    await expect(h.outbox.sendHandoffText(h.chatId, ' \n' as ReviewedText, IN_1)).rejects.toThrow(
      /пуст/i,
    );
    await expect(h.outbox.sendHandoffText(404 as ChatId, HANDOFF_TEXT, IN_1)).rejects.toThrow(
      /404/,
    );
    expect(h.steps).toEqual([]);
  });
});

describe('createOutbox: sendVoiceNotice', () => {
  it('отправляет ровно фразу владельца, источник voice_notice, фраза в истории', async () => {
    const h = setup({ random: () => 0.9 });

    await expect(h.outbox.sendVoiceNotice(h.chatId, IN_1)).resolves.toBe('sent');

    expect(VOICE_NOTICE_TEXT).toBe(
      'Сейчас не могу прослушать голосовое, напишите, пожалуйста, текстом',
    );
    expect(sentTexts(h.steps)).toEqual([VOICE_NOTICE_TEXT]);
    expect(outboundRows(h.db)).toEqual([
      expect.objectContaining({ origin: 'voice_notice', text: VOICE_NOTICE_TEXT, status: 'sent' }),
    ]);
    expect(botMessages(h.db)).toEqual([expect.objectContaining({ text: VOICE_NOTICE_TEXT })]);
  });

  it('учитывает статус manager, неотвеченное входящее и закрытый режим', async () => {
    const h = setup();
    const stranger = h.addChat({ replyJid: PN_B, pnJid: PN_B });
    await expect(h.outbox.sendVoiceNotice(stranger, IN_1)).resolves.toBe('skipped_test_mode');
    await expect(h.outbox.sendVoiceNotice(h.chatId, 'NONE' as WaMessageId)).resolves.toBe(
      'skipped_no_inbound',
    );
    h.chats.setStatus(h.chatId, { status: 'manager', by: 'phone' }, T0);

    await expect(h.outbox.sendVoiceNotice(h.chatId, IN_1)).resolves.toBe('skipped_manager');
    expect(h.steps).toEqual([]);
  });
});

describe('createOutbox: notifyManager', () => {
  it('MANAGER_WHATSAPP не задан: no_manager без отправки', async () => {
    const h = setup({ managerJid: null });

    await expect(h.outbox.notifyManager('Чат #1: лимит', 'limit')).resolves.toEqual({
      status: 'no_manager',
    });
    expect(h.steps).toEqual([]);
  });

  it('шлёт на номер менеджера, вне TEST_ALLOWLIST; запись без чата, в историю клиента не пишет', async () => {
    const h = setup();

    await expect(h.outbox.notifyManager('Чат #1 передан', 'handoff')).resolves.toEqual({
      status: 'sent',
      waId: 'OUT-1',
    });
    expect(h.steps).toEqual([
      {
        step: 'send',
        jid: MANAGER_JID,
        text: 'Чат #1 передан',
        waId: 'OUT-1',
        recordedAs: 'pending',
      },
    ]);
    expect(outboundRows(h.db)).toEqual([
      expect.objectContaining({
        chat_id: null,
        jid: MANAGER_JID,
        origin: 'manager_notify',
        status: 'sent',
      }),
    ]);
    expect(botMessages(h.db)).toEqual([]);
  });

  it('квоты по видам за час: исчерпанная квота limit не вытесняет handoff, через час снова можно', async () => {
    const h = setup();
    for (let i = 0; i < MANAGER_NOTIFY_PER_HOUR.limit; i += 1) {
      await h.outbox.notifyManager('лимит', 'limit');
    }

    await expect(h.outbox.notifyManager('лимит', 'limit')).resolves.toEqual({
      status: 'skipped_limit',
    });
    await expect(h.outbox.notifyManager('передача', 'handoff')).resolves.toMatchObject({
      status: 'sent',
    });
    h.advance(HOUR_MS);
    await expect(h.outbox.notifyManager('лимит', 'limit')).resolves.toMatchObject({
      status: 'sent',
    });
  });

  it('сбой отправки: запись failed, ошибка пробрасывается', async () => {
    const h = setup();
    const failure = new Error('нет связи');
    h.failSends(failure);

    await expect(h.outbox.notifyManager('передача', 'backlog')).rejects.toBe(failure);
    expect(outboundRows(h.db)).toEqual([expect.objectContaining({ status: 'failed' })]);
  });
});

function panelMessages(db: Database.Database): unknown[] {
  return db
    .prepare(
      "SELECT chat_id, wa_id, kind, text, ts_ms FROM messages WHERE author = 'human_panel' ORDER BY id",
    )
    .all();
}

describe('panelTextProblem', () => {
  it('пустой текст и текст из пробелов: причина отказа', () => {
    expect(panelTextProblem('')).toMatch(/пуст/i);
    expect(panelTextProblem(' \n\t ')).toMatch(/пуст/i);
  });

  it('длина считается без пробелов по краям: ровно предел проходит, на символ больше нет', () => {
    const limit = 'я'.repeat(PANEL_TEXT_MAX_LENGTH);

    expect(PANEL_TEXT_MAX_LENGTH).toBe(4096);
    expect(panelTextProblem(limit)).toBeNull();
    expect(panelTextProblem(`  ${limit}\n`)).toBeNull();
    expect(panelTextProblem(`${limit}я`)).toMatch(/4096/);
  });
});

describe('createOutbox: sendFromPanel', () => {
  const TEXT = 'Добрый день, это менеджер Tanbala';

  it('отправляет на адрес чата: запись panel в outbound_ids до отправки, сообщение human_panel в истории', async () => {
    const h = setup();

    await expect(h.outbox.sendFromPanel(h.chatId, TEXT)).resolves.toBe('sent');

    expect(h.steps).toEqual([
      { step: 'send', jid: PN_A, text: TEXT, waId: 'OUT-1', recordedAs: 'pending' },
    ]);
    expect(outboundRows(h.db)).toEqual([
      {
        wa_id: 'OUT-1',
        chat_id: h.chatId,
        jid: PN_A,
        origin: 'panel',
        text: TEXT,
        status: 'sent',
        created_at: T0,
      },
    ]);
    expect(panelMessages(h.db)).toEqual([
      { chat_id: h.chatId, wa_id: 'OUT-1', kind: 'text', text: TEXT, ts_ms: T0 },
    ]);
    expect(botMessages(h.db)).toEqual([]);
  });

  it('пробелы и переводы строк по краям убираются, внутри остаются', async () => {
    const h = setup();

    await h.outbox.sendFromPanel(h.chatId, '  \nПервая строка\nВторая строка \n');

    expect(sentTexts(h.steps)).toEqual(['Первая строка\nВторая строка']);
    expect(panelMessages(h.db)).toEqual([
      expect.objectContaining({ text: 'Первая строка\nВторая строка' }),
    ]);
  });

  it('пустой текст и текст длиннее предела: PanelSendError с понятным текстом, без записей и отправки', async () => {
    const h = setup();
    const tooLong = 'я'.repeat(PANEL_TEXT_MAX_LENGTH + 1);

    const empty: unknown = await h.outbox.sendFromPanel(h.chatId, '  \n ').catch((e: unknown) => e);
    const long: unknown = await h.outbox.sendFromPanel(h.chatId, tooLong).catch((e: unknown) => e);

    expect(empty).toBeInstanceOf(PanelSendError);
    expect(empty).toBeInstanceOf(SafeError);
    expect((empty as Error).message).toMatch(/пуст/i);
    expect(long).toBeInstanceOf(PanelSendError);
    expect((long as Error).message).toMatch(/4096/);
    expect(h.steps).toEqual([]);
    expect(outboundRows(h.db)).toEqual([]);
    await expect(h.outbox.sendFromPanel(h.chatId, 'я'.repeat(PANEL_TEXT_MAX_LENGTH))).resolves.toBe(
      'sent',
    );
  });

  it('неизвестный чат: PanelSendError без номера чата в тексте и без отправки', async () => {
    const h = setup();

    const failure: unknown = await h.outbox
      .sendFromPanel(404 as ChatId, TEXT)
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(PanelSendError);
    expect((failure as Error).message).toMatch(/чат.*не найден/i);
    expect(h.steps).toEqual([]);
    expect(outboundRows(h.db)).toEqual([]);
  });

  it('закрытый режим: чат не из TEST_ALLOWLIST или без номера (только @lid) не получает ответ', async () => {
    const h = setup();
    const stranger = h.addChat({ replyJid: PN_B, pnJid: PN_B });
    const lidOnly = h.addChat({ replyJid: LID_A, lidJid: LID_A });

    for (const chatId of [stranger, lidOnly]) {
      const failure: unknown = await h.outbox.sendFromPanel(chatId, TEXT).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(PanelSendError);
      expect((failure as Error).message).toMatch(/закрыт/i);
    }
    expect(h.steps).toEqual([]);
    expect(outboundRows(h.db)).toEqual([]);
    expect(panelMessages(h.db)).toEqual([]);
  });

  it('закрытый режим выключен (null): пишет в любой чат', async () => {
    const h = setup({ allowlist: null });
    const other = h.addChat({ replyJid: PN_B, pnJid: PN_B });

    await expect(h.outbox.sendFromPanel(other, TEXT)).resolves.toBe('sent');
    expect(h.steps).toEqual([expect.objectContaining({ step: 'send', jid: PN_B })]);
  });

  it('отвечает на адрес, с которого пишет клиент (@lid), номер для закрытого режима берёт из pnJid', async () => {
    const h = setup();
    const lidChat = h.addChat({
      replyJid: LID_A,
      lidJid: LID_A,
      pnJid: '77000000001:3@s.whatsapp.net' as Jid,
    });

    await expect(h.outbox.sendFromPanel(lidChat, TEXT)).resolves.toBe('sent');
    expect(h.steps.at(-1)).toMatchObject({ step: 'send', jid: LID_A });
  });

  it('статус чата не меняет и не требует неотвеченного входящего: человек пишет в любой момент', async () => {
    const h = setup();
    h.messages.markAnswered(h.chatId, IN_1);

    await expect(h.outbox.sendFromPanel(h.chatId, TEXT)).resolves.toBe('sent');

    expect(h.chats.getById(h.chatId)?.control).toEqual({ status: 'bot', by: null });
    h.chats.setStatus(h.chatId, { status: 'manager', by: 'panel' }, T0);
    await expect(h.outbox.sendFromPanel(h.chatId, TEXT)).resolves.toBe('sent');
    expect(h.chats.getById(h.chatId)?.control).toEqual({ status: 'manager', by: 'panel' });
  });

  it('не расходует часовые квоты бота: ответ человека уходит, даже когда лимит ответов бота исчерпан', async () => {
    const h = setup({ allowlist: null });
    for (let i = 0; i < CLIENT_SENDS_PER_CHAT_PER_HOUR; i += 1) {
      await h.outbox.sendBotReply(h.chatId, REPLY, IN_1);
    }
    await expect(h.outbox.sendBotReply(h.chatId, REPLY, IN_1)).resolves.toBe('skipped_limit');

    await expect(h.outbox.sendFromPanel(h.chatId, TEXT)).resolves.toBe('sent');
    h.advance(HOUR_MS);
    await expect(h.outbox.sendBotReply(h.chatId, REPLY, IN_1)).resolves.toBe('sent');
  });

  it('сбой отправки: запись failed, ошибка пробрасывается как есть, в историю не пишется', async () => {
    const h = setup();
    const failure = new Error('нет связи');
    h.failSends(failure);

    await expect(h.outbox.sendFromPanel(h.chatId, TEXT)).rejects.toBe(failure);

    expect(outboundRows(h.db)).toEqual([
      expect.objectContaining({ wa_id: 'OUT-1', origin: 'panel', status: 'failed' }),
    ]);
    expect(panelMessages(h.db)).toEqual([]);
  });
});

describe('createOutbox: canSendFromPanel', () => {
  it('чат из TEST_ALLOWLIST: можно', () => {
    const h = setup();

    expect(h.outbox.canSendFromPanel(h.chatId)).toBe(true);
  });

  it('неизвестный чат: нельзя', () => {
    const h = setup();

    expect(h.outbox.canSendFromPanel(404 as ChatId)).toBe(false);
  });

  it('закрытый режим: чат не из TEST_ALLOWLIST или без номера (только @lid): нельзя', () => {
    const h = setup();
    const stranger = h.addChat({ replyJid: PN_B, pnJid: PN_B });
    const lidOnly = h.addChat({ replyJid: LID_A, lidJid: LID_A });

    expect(h.outbox.canSendFromPanel(stranger)).toBe(false);
    expect(h.outbox.canSendFromPanel(lidOnly)).toBe(false);
  });

  it('чат с @lid и номером из TEST_ALLOWLIST в pnJid: можно, как и в sendFromPanel', () => {
    const h = setup();
    const lidChat = h.addChat({
      replyJid: LID_A,
      lidJid: LID_A,
      pnJid: '77000000001:3@s.whatsapp.net' as Jid,
    });

    expect(h.outbox.canSendFromPanel(lidChat)).toBe(true);
  });

  it('закрытый режим выключен (null): можно в любой существующий чат, но не в несуществующий', () => {
    const h = setup({ allowlist: null });
    const other = h.addChat({ replyJid: PN_B, pnJid: PN_B });

    expect(h.outbox.canSendFromPanel(other)).toBe(true);
    expect(h.outbox.canSendFromPanel(404 as ChatId)).toBe(false);
  });

  it('только проверка: ничего не отправляет, не пишет в outbound_ids и в историю', () => {
    const h = setup();
    const stranger = h.addChat({ replyJid: PN_B, pnJid: PN_B });

    h.outbox.canSendFromPanel(h.chatId);
    h.outbox.canSendFromPanel(stranger);
    h.outbox.canSendFromPanel(404 as ChatId);

    expect(h.steps).toEqual([]);
    expect(outboundRows(h.db)).toEqual([]);
    expect(panelMessages(h.db)).toEqual([]);
  });

  it('согласована с sendFromPanel: что проверка пропускает, то и отправляется; что нет, то отклоняется', async () => {
    const h = setup();
    const stranger = h.addChat({ replyJid: PN_B, pnJid: PN_B });
    const lidOnly = h.addChat({ replyJid: LID_A, lidJid: LID_A });

    for (const chatId of [h.chatId, stranger, lidOnly, 404 as ChatId]) {
      const outcome: unknown = await h.outbox
        .sendFromPanel(chatId, 'Проверка')
        .catch((e: unknown) => e);
      expect(h.outbox.canSendFromPanel(chatId), `чат ${String(chatId)}`).toBe(outcome === 'sent');
    }
  });
});
