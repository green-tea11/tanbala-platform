import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  createChatCompaniesRepo,
  emptyCompanyState,
} from '../../../../src/db/repos/chat-companies.js';
import type { ChatCompaniesRepo, ChatCompanyState } from '../../../../src/domain/company.js';
import type { ChatId } from '../../../../src/domain/types.js';
import {
  companyIdOf,
  jobIdOf,
  makeBrief,
  makeChatCandidate,
  makeConfirmed,
  makeState,
  NOW,
} from '../../company/builders.js';
import { createFakeLogger, loggedText, type LogEntry } from '../../handoff/fakes.js';
import { errorOf, insertChat, LID_A, PN_A, useMigratedDb } from '../fixture.js';

interface Setup {
  readonly db: Database.Database;
  readonly repo: ChatCompaniesRepo;
  readonly logs: LogEntry[];
  readonly chatId: ChatId;
}

function setup(): Setup {
  const db = useMigratedDb();
  const logs: LogEntry[] = [];
  const repo = createChatCompaniesRepo(db, createFakeLogger(logs));
  return { db, repo, logs, chatId: insertChat(db, { replyJid: PN_A }) };
}

/** Состояние с заполненными полями всех видов: кандидат, отклонённые, справка, проверка. */
function fullState(chatId: ChatId): ChatCompanyState {
  return makeState({
    chatId,
    profileKind: 'business',
    profileDomain: 'sklad.kz',
    freeStepsAtMs: NOW,
    logoCheckedAtMs: NOW + 1,
    statedName: 'Платформа-А',
    statedCity: 'Алматы',
    lookedUpName: 'платформа а',
    candidate: makeChatCandidate({ source: 'message', askedAtMs: NOW + 2, awaitingAnswer: true }),
    rejectedIds: [companyIdOf(3), companyIdOf(5)],
    confirmed: makeConfirmed({ confirmedAtMs: NOW + 3, brief: makeBrief(), briefAtMs: NOW + 4 }),
    nameAskedAtMs: NOW + 5,
    research: {
      status: 'running',
      jobId: jobIdOf('job-1'),
      startedAtMs: NOW,
      checkedAtMs: NOW + 6,
    },
    confirmedPains: ['Инвентаризация занимает дни', 'Пересорт при приёмке'],
  });
}

/** Все причины неудачи проверки из ResearchState: каждая должна пройти запись и чтение. */
const ALL_FAIL_REASONS = [
  'not_in_2gis',
  'city_unsupported',
  'budget_exhausted',
  'error',
  'rate_limited',
  'timeout',
  'not_found',
] as const;

/** Копия объекта без одного поля. */
function omit(source: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([name]) => name !== key));
}

/** Состояние так, как оно лежит в колонке state: JSON без ID чата. */
function storedOf(state: ChatCompanyState): Record<string, unknown> {
  return omit(state, 'chatId');
}

function insertRaw(db: Database.Database, chatId: ChatId, state: string): void {
  db.prepare('INSERT INTO chat_companies (chat_id, state, updated_at) VALUES (?, ?, 1)').run(
    chatId,
    state,
  );
}

describe('createChatCompaniesRepo: чтение и запись', () => {
  it('записи нет: пустое состояние чата, в логе тихо', () => {
    const { repo, logs, chatId } = setup();

    expect(repo.get(chatId)).toEqual({
      chatId,
      profileKind: null,
      profileDomain: null,
      freeStepsAtMs: null,
      logoCheckedAtMs: null,
      statedName: null,
      statedCity: null,
      lookedUpName: null,
      candidate: null,
      rejectedIds: [],
      confirmed: null,
      nameAskedAtMs: null,
      research: null,
      confirmedPains: [],
    });
    expect(logs).toEqual([]);
  });

  it('пустое состояние для чата без записи совпадает с emptyCompanyState', () => {
    const { repo, chatId } = setup();

    expect(repo.get(chatId)).toEqual(emptyCompanyState(chatId));
  });

  it('состояние со всеми полями возвращается как записано', () => {
    const { repo, chatId } = setup();
    const state = fullState(chatId);

    repo.save(state, NOW);

    expect(repo.get(chatId)).toEqual(state);
  });

  it.each([
    ['проверка завершена', { status: 'done', companyId: companyIdOf(51), finishedAtMs: NOW }],
    [
      'проверка в очереди',
      { status: 'queued', jobId: jobIdOf('j'), startedAtMs: 1, checkedAtMs: 2 },
    ],
    ['отказ без причины', { status: 'failed', reason: null, finishedAtMs: NOW }],
    ...ALL_FAIL_REASONS.map(
      (reason) =>
        [`отказ с причиной ${reason}`, { status: 'failed', reason, finishedAtMs: NOW }] as const,
    ),
  ] as const)('состояние проверки новой компании сохраняется: %s', (_label, research) => {
    const { repo, chatId } = setup();
    const state = makeState({ chatId, research });

    repo.save(state, NOW);

    expect(repo.get(chatId).research).toEqual(research);
  });

  it.each(['business', 'personal', 'unknown'] as const)(
    'вид профиля %s сохраняется',
    (profileKind) => {
      const { repo, chatId } = setup();

      repo.save(makeState({ chatId, profileKind }), NOW);

      expect(repo.get(chatId).profileKind).toBe(profileKind);
    },
  );

  it('справка со всеми необязательными полями пустыми тоже сохраняется', () => {
    const { repo, chatId } = setup();
    const brief = makeBrief({
      city: null,
      rubric: null,
      segment: null,
      fit: null,
      fitScore: null,
      reason: null,
      pains: [{ pain: 'Пересорт при приёмке', evidence: null, source: null }],
      emailed: true,
      emailedAt: '2026-10-27T11:14:21+05:00',
      emailSubject: 'Тема письма',
    });
    const state = makeState({ chatId, confirmed: makeConfirmed({ brief, briefAtMs: NOW }) });

    repo.save(state, NOW);

    expect(repo.get(chatId)).toEqual(state);
  });

  it('вторая запись заменяет первую целиком и обновляет время записи', () => {
    const { db, repo, chatId } = setup();
    repo.save(fullState(chatId), NOW);
    const second = makeState({ chatId, statedName: 'Другая компания' });

    repo.save(second, NOW + 5000);

    expect(repo.get(chatId)).toEqual(second);
    expect(db.prepare('SELECT count(*) FROM chat_companies').pluck().get()).toBe(1);
    expect(db.prepare('SELECT updated_at FROM chat_companies').pluck().get()).toBe(NOW + 5000);
  });

  it('состояние лежит в базе как JSON без ID чата', () => {
    const { db, repo, chatId } = setup();
    const state = fullState(chatId);

    repo.save(state, NOW);

    const stored = db.prepare('SELECT state FROM chat_companies').pluck().get();
    expect(JSON.parse(String(stored))).toEqual(JSON.parse(JSON.stringify(storedOf(state))));
    expect(JSON.parse(String(stored))).not.toHaveProperty('chatId');
  });

  it('состояния разных чатов не смешиваются', () => {
    const { db, repo, chatId } = setup();
    const otherId = insertChat(db, { replyJid: LID_A });
    repo.save(makeState({ chatId, statedName: 'Первая' }), NOW);
    repo.save(makeState({ chatId: otherId, statedName: 'Вторая' }), NOW);

    expect(repo.get(chatId).statedName).toBe('Первая');
    expect(repo.get(otherId).statedName).toBe('Вторая');
    expect(repo.get(otherId).chatId).toBe(otherId);
  });

  it('запись не для существующего чата: ошибка внешнего ключа пробрасывается', () => {
    const { repo } = setup();

    expect(errorOf(() => repo.save(makeState({ chatId: 404 as ChatId }), NOW))).toMatchObject({
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
    });
  });

  it.each([-1, 1.5, Number.NaN])(
    'время записи %s отклоняется RangeError, ничего не пишется',
    (nowMs) => {
      const { db, repo, chatId } = setup();

      expect(() => {
        repo.save(makeState({ chatId }), nowMs);
      }).toThrow(RangeError);
      expect(db.prepare('SELECT count(*) FROM chat_companies').pluck().get()).toBe(0);
    },
  );

  it('удаление чата удаляет состояние: каскад', () => {
    const { db, repo, chatId } = setup();
    repo.save(fullState(chatId), NOW);

    db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);

    expect(db.prepare('SELECT count(*) FROM chat_companies').pluck().get()).toBe(0);
  });
});

describe('createChatCompaniesRepo: испорченная запись', () => {
  const VALID = storedOf(fullState(1 as ChatId));
  const VALID_CANDIDATE = VALID.candidate as Record<string, unknown>;
  const VALID_CONFIRMED = VALID.confirmed as { brief: Record<string, unknown> };
  const VALID_BRIEF = VALID_CONFIRMED.brief;

  const withBrief = (brief: Record<string, unknown>): Record<string, unknown> => ({
    ...VALID,
    confirmed: { ...VALID_CONFIRMED, brief },
  });

  it.each<[string, string]>([
    ['не JSON', 'это не JSON {'],
    ['пустая строка', ''],
    ['массив', '[]'],
    ['null', 'null'],
    ['число', '42'],
    ['строка', '"текст"'],
    ['пустой объект', '{}'],
  ])('запись «%s»: пустое состояние и предупреждение без исключения', (_label, text) => {
    const { db, repo, logs, chatId } = setup();
    insertRaw(db, chatId, text);

    const state = repo.get(chatId);

    expect(state).toEqual(emptyCompanyState(chatId));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.level).toBe('warn');
  });

  it.each<[string, Record<string, unknown>]>([
    ['вид профиля вне списка', { ...VALID, profileKind: 'robot' }],
    ['время отрицательное', { ...VALID, freeStepsAtMs: -1 }],
    ['время дробное', { ...VALID, logoCheckedAtMs: 1.5 }],
    ['время строкой', { ...VALID, nameAskedAtMs: '5' }],
    ['имя числом', { ...VALID, statedName: 7 }],
    ['пропало поле', omit(VALID, 'lookedUpName')],
    ['пропал список отклонённых', omit(VALID, 'rejectedIds')],
    ['отклонённые не список', { ...VALID, rejectedIds: 'x' }],
    ['отклонённая не число', { ...VALID, rejectedIds: ['8'] }],
    ['отклонённая не положительная', { ...VALID, rejectedIds: [0] }],
    ['боли не список', { ...VALID, confirmedPains: 'боль' }],
    ['ID кандидата ноль', { ...VALID, candidate: { ...VALID_CANDIDATE, id: 0 } }],
    ['ID кандидата дробный', { ...VALID, candidate: { ...VALID_CANDIDATE, id: 1.5 } }],
    [
      'источник кандидата вне списка',
      { ...VALID, candidate: { ...VALID_CANDIDATE, source: 'oracle' } },
    ],
    [
      'флаг ответа не логический',
      { ...VALID, candidate: { ...VALID_CANDIDATE, awaitingAnswer: 1 } },
    ],
    ['проверка с неизвестным статусом', { ...VALID, research: { status: 'weird' } }],
    [
      'проверка без задачи',
      { ...VALID, research: { status: 'running', startedAtMs: 1, checkedAtMs: 2 } },
    ],
    [
      'причина отказа вне списка',
      { ...VALID, research: { status: 'failed', reason: 'fire', finishedAtMs: 1 } },
    ],
    ['справка без имени', withBrief(omit(VALID_BRIEF, 'name'))],
    ['оценка соответствия вне списка', withBrief({ ...VALID_BRIEF, fit: 'perfect' })],
    [
      'источник боли вне списка',
      withBrief({ ...VALID_BRIEF, pains: [{ pain: 'p', evidence: null, source: 'dream' }] }),
    ],
  ])('запись с ошибкой формы (%s): пустое состояние и предупреждение', (_label, stored) => {
    const { db, repo, logs, chatId } = setup();
    insertRaw(db, chatId, JSON.stringify(stored));

    expect(repo.get(chatId)).toEqual(emptyCompanyState(chatId));
    expect(logs).toHaveLength(1);
  });

  it('в предупреждении только ID чата: ни содержимого записи, ни кусков текста', () => {
    const { db, repo, logs, chatId } = setup();
    insertRaw(
      db,
      chatId,
      JSON.stringify({ ...VALID, profileKind: 'robot', statedName: 'СЕКРЕТНАЯ-КОМПАНИЯ' }),
    );

    repo.get(chatId);

    expect(logs[0]?.context).toEqual({ chatId });
    expect(loggedText(logs)).not.toContain('СЕКРЕТНАЯ-КОМПАНИЯ');
    expect(loggedText(logs)).not.toContain('sklad.kz');
  });

  it('предупреждение пишется при каждом чтении испорченной записи', () => {
    const { db, repo, logs, chatId } = setup();
    insertRaw(db, chatId, 'мусор');

    repo.get(chatId);
    repo.get(chatId);

    expect(logs).toHaveLength(2);
  });

  it('новая запись исправляет испорченную: дальше чтение без предупреждений', () => {
    const { db, repo, logs, chatId } = setup();
    insertRaw(db, chatId, 'мусор');
    const state = makeState({ chatId, statedName: 'Платформа-А' });

    repo.save(state, NOW);

    expect(repo.get(chatId)).toEqual(state);
    expect(logs).toEqual([]);
  });

  it('лишнее неизвестное поле не мешает: читается остальное', () => {
    const { db, repo, logs, chatId } = setup();
    insertRaw(db, chatId, JSON.stringify({ ...VALID, futureField: 1 }));

    expect(repo.get(chatId)).toEqual({ ...fullState(chatId) });
    expect(logs).toEqual([]);
  });
});
