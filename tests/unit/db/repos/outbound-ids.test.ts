import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createOutboundIdsRepo } from '../../../../src/db/repos/outbound-ids.js';
import type { OutboundIdsRepo, OutboundRecord } from '../../../../src/domain/ports.js';
import type { ChatId, Jid, WaMessageId } from '../../../../src/domain/types.js';
import { errorOf, insertChat, PN_A, useMigratedDb } from '../fixture.js';

const T0 = 1_761_400_000_000;
const MANAGER_JID = '77000000009@s.whatsapp.net' as Jid;

function setup(): { db: Database.Database; chatId: ChatId; repo: OutboundIdsRepo } {
  const db = useMigratedDb();
  return { db, chatId: insertChat(db, { replyJid: PN_A }), repo: createOutboundIdsRepo(db) };
}

function botReply(chatId: ChatId, waId = 'OUT-1'): OutboundRecord {
  return {
    waId: waId as WaMessageId,
    chatId,
    jid: PN_A,
    origin: 'bot_reply',
    text: 'Здравствуйте',
    nowMs: T0,
  };
}

function rows(db: Database.Database): unknown[] {
  return db
    .prepare(
      'SELECT wa_id, chat_id, jid, origin, text, status, created_at FROM outbound_ids ORDER BY wa_id',
    )
    .all();
}

describe('createOutboundIdsRepo', () => {
  it('register пишет запись со статусом pending: она есть до отправки', () => {
    const { db, chatId, repo } = setup();

    repo.register(botReply(chatId));

    expect(rows(db)).toEqual([
      {
        wa_id: 'OUT-1',
        chat_id: chatId,
        jid: PN_A,
        origin: 'bot_reply',
        text: 'Здравствуйте',
        status: 'pending',
        created_at: T0,
      },
    ]);
  });

  it('find по ID отдаёт адрес, источник и текст; неизвестный ID => null', () => {
    const { chatId, repo } = setup();
    repo.register(botReply(chatId));

    expect(repo.find('OUT-1' as WaMessageId)).toEqual({
      jid: PN_A,
      origin: 'bot_reply',
      text: 'Здравствуйте',
    });
    expect(repo.find('UNKNOWN' as WaMessageId)).toBeNull();
  });

  it.each(['sent', 'failed'] as const)(
    'setResult ставит %s; find отдаёт запись и после сбоя',
    (result) => {
      const { db, chatId, repo } = setup();
      repo.register(botReply(chatId));

      repo.setResult('OUT-1' as WaMessageId, result);

      expect(rows(db)).toEqual([expect.objectContaining({ status: result })]);
      expect(repo.find('OUT-1' as WaMessageId)).not.toBeNull();
    },
  );

  it('setResult неизвестного ID: явная ошибка', () => {
    const { repo } = setup();

    expect(() => {
      repo.setResult('UNKNOWN' as WaMessageId, 'sent');
    }).toThrow(/исходящ/);
  });

  it('уведомление менеджеру пишется без чата', () => {
    const { db, repo } = setup();

    repo.register({
      waId: 'OUT-M' as WaMessageId,
      chatId: null,
      jid: MANAGER_JID,
      origin: 'manager_notify',
      text: 'Уведомление',
      nowMs: T0,
    });

    expect(rows(db)).toEqual([
      expect.objectContaining({ wa_id: 'OUT-M', chat_id: null, origin: 'manager_notify' }),
    ]);
  });

  it('повтор того же ID: ошибка, первая запись не меняется', () => {
    const { db, chatId, repo } = setup();
    repo.register(botReply(chatId));

    expect(errorOf(() => repo.register({ ...botReply(chatId), text: 'другой' }))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_PRIMARYKEY',
    });
    expect(rows(db)).toEqual([expect.objectContaining({ text: 'Здравствуйте' })]);
  });

  it.each([-1, 1.5, Number.NaN])('отклоняет неверное время %s и ничего не пишет', (nowMs) => {
    const { db, chatId, repo } = setup();

    expect(() => {
      repo.register({ ...botReply(chatId), nowMs });
    }).toThrow(RangeError);
    expect(rows(db)).toEqual([]);
  });

  it('испорченный источник в базе: явная ошибка, а не догадка', () => {
    const { db, chatId, repo } = setup();
    repo.register(botReply(chatId));
    db.pragma('ignore_check_constraints = ON');
    db.prepare("UPDATE outbound_ids SET origin = 'spam'").run();

    expect(() => repo.find('OUT-1' as WaMessageId)).toThrow(/источник/);
  });
});
