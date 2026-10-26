import type Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { createChatsRepo } from '../../../src/db/repos/chats.js';
import { createMessagesRepo } from '../../../src/db/repos/messages.js';
import { createOutboundIdsRepo } from '../../../src/db/repos/outbound-ids.js';
import type { MessagesRepo, OutboundIdsRepo } from '../../../src/domain/ports.js';
import type { ChatId, MediaRef, OwnMessage, WaMessageId } from '../../../src/domain/types.js';
import type { HandoffService } from '../../../src/handoff/handoff.js';
import { handleOwnMessage, type TakeoverDeps } from '../../../src/pipeline/takeover.js';
import { insertChat, LID_A, PN_A, PN_B, useMigratedDb } from '../db/fixture.js';

// База настоящая (SQLite в памяти), сервис передачи поддельный: статус и запись передачи проверяет его собственный тест.

const T0 = 1_761_400_000_000;

interface Harness {
  readonly db: Database.Database;
  readonly deps: TakeoverDeps;
  readonly outboundIds: OutboundIdsRepo;
  readonly handOff: ReturnType<typeof vi.fn<HandoffService['handOff']>>;
  readonly chatId: ChatId;
}

function setup(wrapMessages: (messages: MessagesRepo) => MessagesRepo = (m) => m): Harness {
  const db = useMigratedDb();
  const outboundIds = createOutboundIdsRepo(db);
  const handOff = vi.fn<HandoffService['handOff']>(() => Promise.resolve());
  const deps: TakeoverDeps = {
    outboundIds,
    chats: createChatsRepo(db),
    messages: wrapMessages(createMessagesRepo(db)),
    handoff: { handOff },
  };
  const chatId = insertChat(db, { replyJid: LID_A, lidJid: LID_A, pnJid: PN_A });
  return { db, deps, outboundIds, handOff, chatId };
}

function own(overrides: Partial<OwnMessage> = {}): OwnMessage {
  return {
    waId: 'PHONE-1' as WaMessageId,
    chatJid: PN_A,
    content: { kind: 'text', text: 'Добрый день, это специалист Tanbala' },
    tsMs: T0,
    ...overrides,
  };
}

function storedMessages(db: Database.Database): unknown[] {
  return db
    .prepare('SELECT chat_id, wa_id, author, kind, text, ts_ms FROM messages ORDER BY id')
    .all();
}

describe('handleOwnMessage', () => {
  it('ID есть в outbound_ids: эхо своей отправки, ничего не пишется и передачи нет', async () => {
    const h = setup();
    h.outboundIds.register({
      waId: 'OUT-1' as WaMessageId,
      chatId: h.chatId,
      jid: LID_A,
      origin: 'bot_reply',
      text: 'Ответ бота',
      nowMs: T0,
    });

    await expect(handleOwnMessage(h.deps, own({ waId: 'OUT-1' as WaMessageId }))).resolves.toBe(
      'bot_echo',
    );
    expect(storedMessages(h.db)).toEqual([]);
    expect(h.handOff).not.toHaveBeenCalled();
  });

  it.each([PN_A, LID_A])(
    'неизвестный ID в чате %s: пишет человек; сообщение human_phone и handOff human_took_over с телефона',
    async (chatJid) => {
      const h = setup();

      await expect(handleOwnMessage(h.deps, own({ chatJid }))).resolves.toBe('human_took_over');

      expect(storedMessages(h.db)).toEqual([
        {
          chat_id: h.chatId,
          wa_id: 'PHONE-1',
          author: 'human_phone',
          kind: 'text',
          text: 'Добрый день, это специалист Tanbala',
          ts_ms: T0,
        },
      ]);
      expect(h.handOff).toHaveBeenCalledTimes(1);
      expect(h.handOff).toHaveBeenCalledWith(h.chatId, { reason: 'human_took_over', by: 'phone' });
    },
  );

  it('сообщение человека уже в истории к моменту передачи', async () => {
    const h = setup();
    h.handOff.mockImplementation(() => {
      expect(storedMessages(h.db)).toHaveLength(1);
      return Promise.resolve();
    });

    await handleOwnMessage(h.deps, own());

    expect(h.handOff).toHaveBeenCalledTimes(1);
  });

  it('чат не найден: not_client_chat, новый чат не создаётся, ничего не пишется и передачи нет', async () => {
    const h = setup();

    await expect(handleOwnMessage(h.deps, own({ chatJid: PN_B }))).resolves.toBe('not_client_chat');

    expect(storedMessages(h.db)).toEqual([]);
    expect(h.handOff).not.toHaveBeenCalled();
  });

  it('голосовое с телефона хранится без текста', async () => {
    const h = setup();
    const voice: OwnMessage['content'] = {
      kind: 'voice',
      media: 'media-1' as MediaRef,
      mimeType: 'audio/ogg; codecs=opus',
      seconds: 3,
    };

    await handleOwnMessage(h.deps, own({ content: voice }));

    expect(storedMessages(h.db)).toEqual([expect.objectContaining({ kind: 'voice', text: null })]);
    expect(h.handOff).toHaveBeenCalledTimes(1);
  });

  it('повторная доставка того же сообщения: без дубля в истории, передачу повторяет сервис без дублей', async () => {
    const h = setup();

    await handleOwnMessage(h.deps, own());
    await expect(handleOwnMessage(h.deps, own())).resolves.toBe('human_took_over');

    expect(storedMessages(h.db)).toHaveLength(1);
    expect(h.handOff).toHaveBeenCalledTimes(2);
  });

  it('передача не записалась: промис отклоняется той же ошибкой, сообщение человека в истории остаётся', async () => {
    const h = setup();
    const failure = new Error('база недоступна');
    h.handOff.mockRejectedValue(failure);

    await expect(handleOwnMessage(h.deps, own())).rejects.toBe(failure);

    expect(storedMessages(h.db)).toHaveLength(1);
  });

  it('сбой записи сообщения: промис отклоняется, передачи нет', async () => {
    const failure = new Error('диск полон');
    const h = setup((messages) => ({
      ...messages,
      insertIfNew: () => {
        throw failure;
      },
    }));

    await expect(handleOwnMessage(h.deps, own())).rejects.toBe(failure);

    expect(h.handOff).not.toHaveBeenCalled();
  });
});
