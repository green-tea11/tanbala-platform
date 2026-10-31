import { describe, expect, it } from 'vitest';
import { createUnitOfWork } from '../../../../src/db/connection.js';
import { createChatsRepo } from '../../../../src/db/repos/chats.js';
import { createHandoffsRepo } from '../../../../src/db/repos/handoffs.js';
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

  it('recordTurn: отказ продолжает счёт уходов от вопросов подряд, ход без отказа его обнуляет (решение владельца 30.10.2026)', () => {
    const { repo, chatId, otherChatId } = setup();

    repo.recordTurn(chatId, { priceAsked: false, refused: true });
    expect(repo.getProgress(chatId)).toEqual({ priceAsks: 0, refused: true, refusedStreak: 1 });
    repo.recordTurn(chatId, { priceAsked: true, refused: true });
    expect(repo.getProgress(chatId)).toMatchObject({ priceAsks: 1, refusedStreak: 2 });
    repo.recordTurn(chatId, { priceAsked: false, refused: false });
    expect(repo.getProgress(chatId)).toEqual({ priceAsks: 1, refused: true });
    expect(repo.getProgress(otherChatId)).toEqual({ priceAsks: 0, refused: false });
  });

  it('resetProgress: возврат боту обнуляет и уходы от вопросов подряд', () => {
    const { repo, chatId } = setup();
    repo.recordTurn(chatId, { priceAsked: false, refused: true });
    repo.recordTurn(chatId, { priceAsked: false, refused: true });

    repo.resetProgress(chatId);

    expect(repo.getProgress(chatId).refusedStreak).toBeUndefined();
  });

  it('чат хоть раз передавался менеджеру (любая причина): handedOff true, и возврат боту его не снимает', () => {
    const { db, repo, chatId, otherChatId } = setup();
    const handoffs = createHandoffsRepo(db);

    handoffs.open(chatId, 'human_took_over', 'cold', '', 1_000);
    expect(repo.getProgress(chatId)).toEqual({ priceAsks: 0, refused: false, handedOff: true });
    handoffs.resolve(chatId, 2_000);
    repo.resetProgress(chatId);

    expect(repo.getProgress(chatId)).toEqual({ priceAsks: 0, refused: false, handedOff: true });
    expect(repo.getProgress(otherChatId)).toEqual({ priceAsks: 0, refused: false });
    expect(repo.getProgress(otherChatId).handedOff).toBeUndefined();
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

describe('createChatsRepo: этап и рассказанные сильные стороны (30.10.2026)', () => {
  it('новый чат: ничего не рассказано, этапа нет; поля в ходе разговора не появляются', () => {
    const { repo, chatId } = setup();

    expect(repo.getProgress(chatId)).toEqual({ priceAsks: 0, refused: false });
  });

  it('recordReply: этап сменяется более дальним, сильные стороны объединяются без дублей по порядку F1…F10', () => {
    const { repo, chatId, otherChatId } = setup();

    repo.recordReply(chatId, { stage: 'hook', usedFacts: ['F4', 'F2'] });
    repo.recordReply(chatId, { stage: 'explain', usedFacts: ['F10', 'F2', 'F3'] });

    expect(repo.getProgress(chatId)).toEqual({
      priceAsks: 0,
      refused: false,
      toldFacts: ['F2', 'F3', 'F4', 'F10'],
      lastStage: 'explain',
    });
    expect(repo.getProgress(otherChatId)).toEqual({ priceAsks: 0, refused: false });
  });

  it('recordReply: этап только вперёд, ответ на более раннем этапе разговор назад не возвращает (ревью этапа 2)', () => {
    const { repo, chatId } = setup();
    repo.recordReply(chatId, { stage: 'explain', usedFacts: [] });

    repo.recordReply(chatId, { stage: 'intro', usedFacts: [] });
    expect(repo.getProgress(chatId)).toMatchObject({ lastStage: 'explain' });
    repo.recordReply(chatId, { stage: 'hook', usedFacts: [] });
    expect(repo.getProgress(chatId)).toMatchObject({ lastStage: 'explain' });
    repo.recordReply(chatId, { stage: 'final', usedFacts: [] });
    expect(repo.getProgress(chatId)).toMatchObject({ lastStage: 'final' });
    repo.recordReply(chatId, { stage: 'details', usedFacts: [] });
    expect(repo.getProgress(chatId)).toMatchObject({ lastStage: 'final' });
  });

  it('recordReply без этапа (черновик без поля) этап не стирает; без сильных сторон их не меняет', () => {
    const { repo, chatId } = setup();
    repo.recordReply(chatId, { stage: 'details', usedFacts: ['F6'] });

    repo.recordReply(chatId, { stage: null, usedFacts: [] });

    expect(repo.getProgress(chatId)).toMatchObject({ toldFacts: ['F6'], lastStage: 'details' });
  });

  it('возврат чата боту (resetProgress) не забывает рассказанное и этап', () => {
    const { repo, chatId } = setup();
    repo.recordReply(chatId, { stage: 'details', usedFacts: ['F3'] });

    repo.resetProgress(chatId);

    expect(repo.getProgress(chatId)).toEqual({
      priceAsks: 0,
      refused: false,
      toldFacts: ['F3'],
      lastStage: 'details',
    });
  });

  it('неизвестный чат: явная ошибка', () => {
    const { repo } = setup();

    expect(() => {
      repo.recordReply(404 as ChatId, { stage: 'hook', usedFacts: [] });
    }).toThrow(/404/);
  });

  it('испорченные данные в базе: неизвестные номера и не JSON отбрасываются, этап вне списка отклоняет CHECK', () => {
    const { db, repo, chatId } = setup();
    db.prepare(`UPDATE chats SET told_facts = '["F2","F99",7,"F1"]' WHERE id = ?`).run(chatId);
    expect(repo.getProgress(chatId)).toEqual({
      priceAsks: 0,
      refused: false,
      toldFacts: ['F1', 'F2'],
    });

    db.prepare(`UPDATE chats SET told_facts = 'не json' WHERE id = ?`).run(chatId);
    expect(repo.getProgress(chatId)).toEqual({ priceAsks: 0, refused: false });

    expect(() =>
      db.prepare(`UPDATE chats SET last_stage = 'price' WHERE id = ?`).run(chatId),
    ).toThrow(/CHECK/);
  });
});

describe('createChatsRepo: заметка для бота', () => {
  it('новый чат: заметки нет; setNote пишет текст и время, getNote читает', () => {
    const { repo, chatId, otherChatId } = setup();
    expect(repo.getNote(chatId)).toBeNull();

    repo.setNote(chatId, { text: 'Узнай число вещей и 1С', atMs: 1_000 });

    expect(repo.getNote(chatId)).toEqual({ text: 'Узнай число вещей и 1С', atMs: 1_000 });
    expect(repo.getNote(otherChatId)).toBeNull();
  });

  it('setNote null снимает заметку', () => {
    const { repo, chatId } = setup();
    repo.setNote(chatId, { text: 'ориентир от 500 000 тенге', atMs: 1_000 });

    repo.setNote(chatId, null);

    expect(repo.getNote(chatId)).toBeNull();
  });

  it('текст как есть: кавычки, SQL, переводы строк', () => {
    const { repo, chatId } = setup();
    const text = "'); DROP TABLE chats; --\nвторая строка «в кавычках»";

    repo.setNote(chatId, { text, atMs: 5 });

    expect(repo.getNote(chatId)?.text).toBe(text);
  });

  it('неизвестный чат: явная ошибка; неверное время: RangeError', () => {
    const { repo, chatId } = setup();

    expect(() => repo.getNote(404 as ChatId)).toThrow(/404/);
    expect(() => {
      repo.setNote(404 as ChatId, null);
    }).toThrow(/404/);
    expect(() => {
      repo.setNote(chatId, { text: 'x', atMs: -1 });
    }).toThrow(RangeError);
  });
});
