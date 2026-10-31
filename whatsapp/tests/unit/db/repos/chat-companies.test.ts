import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  createChatCompaniesRepo,
  emptyCompanyState,
} from '../../../../src/db/repos/chat-companies.js';
import type {
  ChatCompaniesRepo,
  ChatCompanyState,
  CompanyBrief,
} from '../../../../src/domain/company.js';
import type { ChatId, Jid } from '../../../../src/domain/types.js';
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
    profileRequests: 2,
    profileDomain: 'sklad.kz',
    freeStepsAtMs: NOW,
    logoCheckedAtMs: NOW + 1,
    statedName: 'Платформа-А',
    statedCity: 'Алматы',
    statedAliases: ['Platforma-A', 'Платформа А'],
    lookedUpName: 'платформа а',
    candidate: makeChatCandidate({ source: 'message', askedAtMs: NOW + 2, awaitingAnswer: true }),
    rejectedIds: [companyIdOf(3), companyIdOf(5)],
    confirmed: makeConfirmed({ confirmedAtMs: NOW + 3, brief: makeBrief(), briefAtMs: NOW + 4 }),
    briefFailures: 1,
    nameAskedAtMs: NOW + 5,
    research: {
      status: 'running',
      jobId: jobIdOf('job-1'),
      startedAtMs: NOW,
      checkedAtMs: NOW + 6,
    },
    researchStartedAtMs: NOW,
    adoptFailures: 2,
    confirmedPains: ['Инвентаризация занимает дни', 'Пересорт при приёмке'],
  });
}

/** Поля справки, которые не нужны ни промпту, ни сводке, ни панели: в базу они не пишутся, при чтении null. */
const UNUSED_BRIEF_FIELDS = {
  segment: null,
  fit: null,
  fitScore: null,
  reason: null,
  emailedAt: null,
  emailSubject: null,
} as const;

/** Справка так, как её возвращает чтение из базы: неиспользуемые поля null. */
function readBack(brief: CompanyBrief): CompanyBrief {
  return { ...brief, ...UNUSED_BRIEF_FIELDS };
}

/** Состояние так, как его возвращает чтение из базы после записи. */
function asRead(state: ChatCompanyState): ChatCompanyState {
  const { confirmed } = state;
  if (confirmed === null || confirmed.brief === null) return state;
  return { ...state, confirmed: { ...confirmed, brief: readBack(confirmed.brief) } };
}

/** Справка так, как она лежит в JSON: только ID, название, город, рубрика, боли и «писали ли». */
function storedBriefOf(brief: CompanyBrief): Record<string, unknown> {
  return {
    id: brief.id,
    name: brief.name,
    city: brief.city,
    rubric: brief.rubric,
    pains: brief.pains,
    emailed: brief.emailed,
  };
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
      profileRequests: 0,
      profileDomain: null,
      freeStepsAtMs: null,
      logoCheckedAtMs: null,
      statedName: null,
      statedCity: null,
      statedAliases: [],
      lookedUpName: null,
      candidate: null,
      rejectedIds: [],
      confirmed: null,
      briefFailures: 0,
      nameAskedAtMs: null,
      research: null,
      researchStartedAtMs: null,
      adoptFailures: 0,
      confirmedPains: [],
    });
    expect(logs).toEqual([]);
  });

  it('пустое состояние для чата без записи совпадает с emptyCompanyState', () => {
    const { repo, chatId } = setup();

    expect(repo.get(chatId)).toEqual(emptyCompanyState(chatId));
  });

  it('состояние со всеми полями возвращается как записано, кроме неиспользуемых полей справки', () => {
    const { repo, chatId } = setup();
    const state = fullState(chatId);

    repo.save(state, NOW);

    expect(repo.get(chatId)).toEqual(asRead(state));
    expect(repo.get(chatId).confirmed?.brief).toEqual({ ...makeBrief(), ...UNUSED_BRIEF_FIELDS });
  });

  it('боли справки с цитатой и источником, рубрика и «писали ли» сохраняются: их видят промпт, сводка и панель', () => {
    const { repo, chatId } = setup();
    const brief = makeBrief({ emailed: true, rubric: 'Склады' });

    repo.save(makeState({ chatId, confirmed: makeConfirmed({ brief, briefAtMs: NOW }) }), NOW);

    expect(repo.get(chatId).confirmed?.brief).toMatchObject({
      rubric: 'Склады',
      pains: brief.pains,
      emailed: true,
    });
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

  it('справка с пустыми городом и рубрикой тоже сохраняется', () => {
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

    expect(repo.get(chatId)).toEqual(asRead(state));
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

  it('состояние лежит в базе как JSON без ID чата, справка без неиспользуемых полей', () => {
    const { db, repo, chatId } = setup();
    const state = fullState(chatId);

    repo.save(state, NOW);

    const text = String(db.prepare('SELECT state FROM chat_companies').pluck().get());
    const confirmed = { ...state.confirmed, brief: storedBriefOf(makeBrief()) };
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify({ ...storedOf(state), confirmed })));
    expect(JSON.parse(text)).not.toHaveProperty('chatId');
    for (const unused of Object.keys(UNUSED_BRIEF_FIELDS)) expect(text).not.toContain(unused);
    expect(text).not.toContain('Ответственное хранение');
  });

  it('старая запись без счётчиков, вариантов названия и с полной справкой читается: счётчики 0, отметки запуска нет, вариантов нет', () => {
    const { db, repo, chatId } = setup();
    const full = makeState({ confirmed: makeConfirmed({ brief: makeBrief(), briefAtMs: NOW }) });
    const old = [
      'profileRequests',
      'briefFailures',
      'researchStartedAtMs',
      'adoptFailures',
      'statedAliases',
    ].reduce((stored, key) => omit(stored, key), storedOf(full));
    insertRaw(db, chatId, JSON.stringify(old));

    expect(repo.get(chatId)).toEqual(
      makeState({
        chatId,
        confirmed: makeConfirmed({ brief: readBack(makeBrief()), briefAtMs: NOW }),
      }),
    );
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
    ['справка без болей', withBrief(omit(VALID_BRIEF, 'pains'))],
    ['счётчик профиля отрицательный', { ...VALID, profileRequests: -1 }],
    ['счётчик справки дробный', { ...VALID, briefFailures: 0.5 }],
    ['счётчик запусков строкой', { ...VALID, adoptFailures: '1' }],
    ['отметка запуска отрицательная', { ...VALID, researchStartedAtMs: -5 }],
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

    expect(repo.get(chatId)).toEqual(asRead(fullState(chatId)));
    expect(logs).toEqual([]);
  });

  it('неиспользуемые поля справки в старой записи не проверяются: запись читается, поля null', () => {
    const { db, repo, logs, chatId } = setup();
    insertRaw(
      db,
      chatId,
      JSON.stringify(withBrief({ ...VALID_BRIEF, fit: 'perfect', fitScore: 'x' })),
    );

    expect(repo.get(chatId).confirmed?.brief).toEqual(readBack(makeBrief()));
    expect(logs).toEqual([]);
  });
});

describe('createChatCompaniesRepo: дневной предел проверок новых компаний', () => {
  let nextChat = 0;

  /** Новый чат с отметкой запуска проверки в atMs (null: не запускал). */
  function chatWithStart(
    db: Database.Database,
    repo: ChatCompaniesRepo,
    atMs: number | null,
  ): void {
    nextChat += 1;
    const chatId = insertChat(db, {
      replyJid: `77000001${String(nextChat).padStart(3, '0')}@s.whatsapp.net` as Jid,
    });
    repo.save(makeState({ chatId, researchStartedAtMs: atMs }), NOW);
  }

  it('записей нет: ноль', () => {
    const { repo } = setup();

    expect(repo.countResearchStarts(NOW - 1000)).toBe(0);
  });

  it('считаются чаты с отметкой позже границы; ровно на границе, раньше и без отметки не считаются', () => {
    const { db, repo } = setup();
    chatWithStart(db, repo, NOW);
    chatWithStart(db, repo, NOW - 999);
    chatWithStart(db, repo, NOW - 1000);
    chatWithStart(db, repo, NOW - 5000);
    chatWithStart(db, repo, null);

    expect(repo.countResearchStarts(NOW - 1000)).toBe(2);
  });

  it('испорченная запись (не JSON) не ломает счёт и не считается', () => {
    const { db, repo, chatId } = setup();
    insertRaw(db, chatId, 'мусор {');
    chatWithStart(db, repo, NOW);

    expect(repo.countResearchStarts(NOW - 1000)).toBe(1);
  });

  it('отметка не числом (испорченная запись) не считается', () => {
    const { db, repo, chatId } = setup();
    insertRaw(db, chatId, JSON.stringify({ researchStartedAtMs: 'завтра' }));

    expect(repo.countResearchStarts(NOW - 1000)).toBe(0);
  });

  it.each([-1, 1.5, Number.NaN])('граница %s отклоняется RangeError', (sinceMs) => {
    const { repo } = setup();

    expect(() => repo.countResearchStarts(sinceMs)).toThrow(RangeError);
  });
});
