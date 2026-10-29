import { describe, expect, it } from 'vitest';
import { createChatsRepo } from '../../../../src/db/repos/chats.js';
import { createRejectedDraftsRepo } from '../../../../src/db/repos/rejected-drafts.js';
import type { ChatId, ChatIdentity, RejectedDraft } from '../../../../src/domain/types.js';
import { errorOf, insertChat, LID_A, PN_A, useMigratedDb } from '../fixture.js';

// Отклонённые черновики и замечания проверок для панели (таблица rejected_drafts, схема версии 10).

const T0 = 1_761_400_000_000;
const DAY_MS = 24 * 60 * 60_000;

function entry(chatId: ChatId, overrides: Partial<RejectedDraft> = {}): RejectedDraft {
  return {
    chatId,
    attempt: 1,
    source: 'code',
    draft: 'Цена сильно зависит от объёма, и 3000 позиций уже хороший ориентир.',
    remarks: ['цена: «Цена сильно зависит от объёма, и 3000»'],
    atMs: T0,
    ...overrides,
  };
}

function setup() {
  const db = useMigratedDb();
  return {
    db,
    chatId: insertChat(db, { replyJid: PN_A }),
    otherChatId: insertChat(db, { replyJid: LID_A }),
    repo: createRejectedDraftsRepo(db),
  };
}

describe('db/repos/rejected-drafts', () => {
  it('сохраняет черновик с попыткой, источником, замечаниями и временем; читает его как есть', () => {
    const { repo, chatId } = setup();
    const saved = entry(chatId, {
      attempt: 2,
      source: 'review',
      draft: '<b>текст</b> & «кавычки»',
      remarks: ['Назван срок внедрения.', 'Обещание за коллегу.'],
    });

    repo.add(saved);

    const [stored] = repo.listForChat(chatId, 10);
    expect(stored).toMatchObject(saved);
    expect(typeof stored?.id).toBe('number');
  });

  it('свежие первыми, не больше limit, только своего чата', () => {
    const { repo, chatId, otherChatId } = setup();
    repo.add(entry(chatId, { atMs: T0, draft: 'первый' }));
    repo.add(entry(chatId, { atMs: T0 + 2000, draft: 'третий' }));
    repo.add(entry(chatId, { atMs: T0 + 1000, draft: 'второй' }));
    repo.add(entry(otherChatId, { atMs: T0 + 5000, draft: 'чужой' }));

    expect(repo.listForChat(chatId, 2).map((item) => item.draft)).toEqual(['третий', 'второй']);
    expect(repo.listForChat(otherChatId, 10).map((item) => item.draft)).toEqual(['чужой']);
  });

  it('при равном времени свежее та, что записана позже (две попытки одного хода)', () => {
    const { repo, chatId } = setup();
    repo.add(entry(chatId, { attempt: 1 }));
    repo.add(entry(chatId, { attempt: 2, source: 'review' }));

    expect(repo.listForChat(chatId, 10).map((item) => item.attempt)).toEqual([2, 1]);
  });

  it('удаляет строки старше границы и возвращает их число; граница не удаляется', () => {
    const { repo, chatId, otherChatId } = setup();
    const cutoff = T0 + 31 * DAY_MS - 30 * DAY_MS;
    repo.add(entry(chatId, { atMs: T0 }));
    repo.add(entry(otherChatId, { atMs: T0 + 10 }));
    repo.add(entry(chatId, { atMs: cutoff }));
    repo.add(entry(chatId, { atMs: cutoff + 1 }));

    expect(repo.deleteOlderThan(cutoff)).toBe(2);
    expect(repo.listForChat(chatId, 10).map((item) => item.atMs)).toEqual([cutoff + 1, cutoff]);
    expect(repo.listForChat(otherChatId, 10)).toEqual([]);
    expect(repo.deleteOlderThan(cutoff)).toBe(0);
  });

  it('пустой список замечаний допустим (проверка не назвала причину)', () => {
    const { repo, chatId } = setup();

    repo.add(entry(chatId, { remarks: [] }));

    expect(repo.listForChat(chatId, 1)[0]?.remarks).toEqual([]);
  });

  it.each([0, 3, 1.5])('попытка %j вне 1 и 2: ошибка, ничего не записано', (attempt) => {
    const { repo, chatId } = setup();

    const error = errorOf(() => {
      repo.add(entry(chatId, { attempt: attempt as 1 }));
    });

    expect(error).toBeInstanceOf(Error);
    expect(repo.listForChat(chatId, 10)).toEqual([]);
  });

  it('время не число миллисекунд: ошибка', () => {
    const { repo, chatId } = setup();

    expect(
      errorOf(() => {
        repo.add(entry(chatId, { atMs: Number.NaN }));
      }),
    ).toBeInstanceOf(Error);
    expect(errorOf(() => repo.deleteOlderThan(Number.NaN))).toBeInstanceOf(Error);
  });

  it('limit не целое больше нуля: ошибка', () => {
    const { repo, chatId } = setup();

    expect(errorOf(() => repo.listForChat(chatId, 0))).toBeInstanceOf(RangeError);
  });

  it('испорченные замечания в базе (не JSON-массив строк) читаются пустым списком', () => {
    const { db, repo, chatId } = setup();
    db.prepare(
      `INSERT INTO rejected_drafts (chat_id, attempt, source, draft, remarks, at_ms)
       VALUES (?, 1, 'code', 'текст', ?, ?)`,
    ).run(chatId, '{"not":"array"}', T0);
    db.prepare(
      `INSERT INTO rejected_drafts (chat_id, attempt, source, draft, remarks, at_ms)
       VALUES (?, 2, 'review', 'текст', ?, ?)`,
    ).run(chatId, 'не json', T0 + 1);

    expect(repo.listForChat(chatId, 10).map((item) => item.remarks)).toEqual([[], []]);
  });

  it('слияние чатов: черновики слитого чата переезжают к оставшемуся', () => {
    const db = useMigratedDb();
    const chats = createChatsRepo(db);
    const repo = createRejectedDraftsRepo(db);
    const lidOnly: ChatIdentity = { replyJid: LID_A, lidJid: LID_A, pnJid: null };
    const pnOnly: ChatIdentity = { replyJid: PN_A, lidJid: null, pnJid: PN_A };
    const survivor = chats.upsertByIdentity(lidOnly, null, T0);
    const absorbed = chats.upsertByIdentity(pnOnly, null, T0 + 1);
    repo.add(entry(absorbed.id, { draft: 'слитый' }));
    repo.add(entry(survivor.id, { draft: 'свой', atMs: T0 + 5 }));

    const merged = chats.upsertByIdentity(
      { replyJid: LID_A, lidJid: LID_A, pnJid: PN_A },
      null,
      T0 + 10,
    );

    expect(merged.id).toBe(survivor.id);
    expect(repo.listForChat(survivor.id, 10).map((item) => item.draft)).toEqual(['свой', 'слитый']);
  });
});
