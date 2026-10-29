import { describe, expect, it } from 'vitest';
import { createUnitOfWork } from '../../../../src/db/connection.js';
import { createChatsRepo } from '../../../../src/db/repos/chats.js';
import type { ChatId } from '../../../../src/domain/types.js';
import { insertChat, PN_A, PN_B, useMigratedDb } from '../fixture.js';

// Ход разговора о цене (решение владельца 29.10.2026): сколько раз клиент спросил цену в ходах, на которые бот
// ответил, и отказывался ли он отвечать. Счётчик и отказ обнуляются при возврате чата боту.

function setup() {
  const db = useMigratedDb();
  return {
    db,
    repo: createChatsRepo(db),
    chatId: insertChat(db, { replyJid: PN_A, pnJid: PN_A }),
    otherChatId: insertChat(db, { replyJid: PN_B, pnJid: PN_B }),
  };
}

describe('createChatsRepo: ход разговора о цене', () => {
  it('новый чат: вопросов цены ноль, отказа нет', () => {
    const { repo, chatId } = setup();

    expect(repo.getProgress(chatId)).toEqual({ priceAsks: 0, refused: false });
  });

  it('recordTurn: вопрос цены прибавляет один, отказ ставится и остаётся', () => {
    const { repo, chatId, otherChatId } = setup();

    repo.recordTurn(chatId, { priceAsked: true, refused: false });
    repo.recordTurn(chatId, { priceAsked: true, refused: true });
    repo.recordTurn(chatId, { priceAsked: false, refused: false });

    expect(repo.getProgress(chatId)).toEqual({ priceAsks: 2, refused: true });
    expect(repo.getProgress(otherChatId)).toEqual({ priceAsks: 0, refused: false });
  });

  it('resetProgress: возврат боту обнуляет счётчик и отказ', () => {
    const { repo, chatId } = setup();
    repo.recordTurn(chatId, { priceAsked: true, refused: true });

    repo.resetProgress(chatId);

    expect(repo.getProgress(chatId)).toEqual({ priceAsks: 0, refused: false });
  });

  it('сброс внутри внешней транзакции откатывается вместе с ней', () => {
    const { db, repo, chatId } = setup();
    repo.recordTurn(chatId, { priceAsked: true, refused: false });

    expect(() =>
      createUnitOfWork(db).run(() => {
        repo.resetProgress(chatId);
        throw new Error('сбой после сброса');
      }),
    ).toThrow(/сбой после сброса/);

    expect(repo.getProgress(chatId).priceAsks).toBe(1);
  });

  it('неизвестный чат: явная ошибка у каждого метода', () => {
    const { repo } = setup();
    const unknown = 404 as ChatId;

    expect(() => repo.getProgress(unknown)).toThrow(/404/);
    expect(() => {
      repo.recordTurn(unknown, { priceAsked: true, refused: false });
    }).toThrow(/404/);
    expect(() => {
      repo.resetProgress(unknown);
    }).toThrow(/404/);
  });

  it('испорченный отказ в базе: явная ошибка, а не догадка', () => {
    const { db, repo, chatId } = setup();
    db.pragma('ignore_check_constraints = ON');
    db.prepare('UPDATE chats SET refused_answers = 5').run();

    expect(() => repo.getProgress(chatId)).toThrow(/отказ/);
  });
});
