import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createUnitOfWork } from '../../../src/db/connection.js';
import { createChatsRepo } from '../../../src/db/repos/chats.js';
import { createMessagesRepo } from '../../../src/db/repos/messages.js';
import { createOutboundIdsRepo } from '../../../src/db/repos/outbound-ids.js';
import type { ChatsRepo, OutboundIdsRepo } from '../../../src/domain/ports.js';
import type { ChatId, MediaRef, OwnMessage, WaMessageId } from '../../../src/domain/types.js';
import { handleOwnMessage, type TakeoverDeps } from '../../../src/pipeline/takeover.js';
import { insertChat, LID_A, PN_A, PN_B, useMigratedDb } from '../db/fixture.js';

const T0 = 1_761_400_000_000;

interface Harness {
  readonly db: Database.Database;
  readonly deps: TakeoverDeps;
  readonly chats: ChatsRepo;
  readonly outboundIds: OutboundIdsRepo;
  readonly chatId: ChatId;
}

function setup(wrapChats: (chats: ChatsRepo) => ChatsRepo = (chats) => chats): Harness {
  const db = useMigratedDb();
  const chats = createChatsRepo(db);
  const outboundIds = createOutboundIdsRepo(db);
  const deps: TakeoverDeps = {
    outboundIds,
    chats: wrapChats(chats),
    messages: createMessagesRepo(db),
    unitOfWork: createUnitOfWork(db),
  };
  const chatId = insertChat(db, { replyJid: LID_A, lidJid: LID_A, pnJid: PN_A });
  return { db, deps, chats, outboundIds, chatId };
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

function statusChangedAt(db: Database.Database, chatId: ChatId): unknown {
  return db.prepare('SELECT status_changed_at FROM chats WHERE id = ?').pluck().get(chatId);
}

describe('handleOwnMessage', () => {
  it('ID есть в outbound_ids: эхо своей отправки, ничего не меняется', async () => {
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
    expect(h.chats.getById(h.chatId)?.control).toEqual({ status: 'bot', by: null });
  });

  it.each([PN_A, LID_A])(
    'неизвестный ID в чате %s: пишет человек; сообщение human_phone, чат у менеджера (phone) со временем сообщения',
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
      expect(h.chats.getById(h.chatId)?.control).toEqual({ status: 'manager', by: 'phone' });
      expect(statusChangedAt(h.db, h.chatId)).toBe(T0);
    },
  );

  it('чат не найден: not_client_chat, новый чат не создаётся, ничего не пишется', async () => {
    const h = setup();

    await expect(handleOwnMessage(h.deps, own({ chatJid: PN_B }))).resolves.toBe('not_client_chat');
    expect(h.chats.findByJid(PN_B)).toBeNull();
    expect(storedMessages(h.db)).toEqual([]);
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
  });

  it('чат уже ведёт человек с телефона: время перехвата не сдвигается, сообщение сохраняется', async () => {
    const h = setup();
    h.chats.setStatus(h.chatId, { status: 'manager', by: 'phone' }, T0 - 5000);

    await expect(handleOwnMessage(h.deps, own())).resolves.toBe('human_took_over');

    expect(statusChangedAt(h.db, h.chatId)).toBe(T0 - 5000);
    expect(storedMessages(h.db)).toHaveLength(1);
  });

  it('чат передал бот: человек с телефона забирает его себе', async () => {
    const h = setup();
    h.chats.setStatus(h.chatId, { status: 'manager', by: 'bot' }, T0 - 5000);

    await handleOwnMessage(h.deps, own());

    expect(h.chats.getById(h.chatId)?.control).toEqual({ status: 'manager', by: 'phone' });
    expect(statusChangedAt(h.db, h.chatId)).toBe(T0);
  });

  it('повторная доставка того же сообщения: без дубля в истории', async () => {
    const h = setup();

    await handleOwnMessage(h.deps, own());
    await expect(handleOwnMessage(h.deps, own())).resolves.toBe('human_took_over');

    expect(storedMessages(h.db)).toHaveLength(1);
  });

  it('сбой смены статуса: запись сообщения откатывается, промис отклоняется', async () => {
    const failure = new Error('база недоступна');
    const h = setup((chats) => ({
      ...chats,
      setStatus: () => {
        throw failure;
      },
    }));

    await expect(handleOwnMessage(h.deps, own())).rejects.toBe(failure);
    expect(storedMessages(h.db)).toEqual([]);
    expect(h.chats.getById(h.chatId)?.control).toEqual({ status: 'bot', by: null });
  });
});
