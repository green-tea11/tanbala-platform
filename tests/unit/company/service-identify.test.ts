import { describe, expect, it } from 'vitest';
import type { ChatCompanyState, CompanyApiFailure } from '../../../src/domain/company.js';
import { loggedText, makeChat } from '../handoff/fakes.js';
import {
  companyIdOf,
  jobIdOf,
  makeBrief,
  makeCandidate,
  makeChatCandidate,
  makeConfirmed,
  makeState,
  MINUTE_MS,
  NOW,
} from './builders.js';
import { createHarness, fail, lidChat, lookupBy, ok } from './fakes.js';

// identifyAfterReply, шаг г: поиск по названию со слов клиента и проверка новой компании (один раз на чат).

const FREE_DONE = { freeStepsAtMs: NOW - MINUTE_MS };

function named(overrides: Partial<ChatCompanyState> = {}): ChatCompanyState {
  return makeState({
    ...FREE_DONE,
    statedName: 'Платформа-А',
    statedCity: 'Алматы',
    ...overrides,
  });
}

const BY_NAME = ok([makeCandidate({ matchBy: 'name', matchScore: 0.9 })]);
const QUEUED = ok({ kind: 'queued', jobId: jobIdOf('job-1') } as const);

describe('identifyAfterReply: шаг г, название со слов клиента', () => {
  it('название есть: поиск по названию, найденная компания становится кандидатом, название запомнено', async () => {
    const h = createHarness({
      state: named(),
      directory: { lookup: lookupBy({ name: BY_NAME }) },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.lookups()).toEqual([{ by: 'name', name: 'Платформа-А' }]);
    expect(h.repo.current()).toMatchObject({
      candidate: makeChatCandidate({ source: 'message' }),
      lookedUpName: 'платформа а',
      research: null,
    });
    expect(h.directory.count('startResearch')).toBe(0);
  });

  it('найденный по словам клиента кандидат потом спрашивается с городом', async () => {
    const h = createHarness({
      state: named(),
      directory: { lookup: lookupBy({ name: BY_NAME }) },
    });

    await h.service.identifyAfterReply(makeChat());
    const turn = await h.service.prepare(makeChat(), []);

    expect(turn.prompt).toEqual({
      kind: 'candidate',
      name: 'Платформа-А',
      city: 'Алматы',
      withCity: true,
    });
  });

  it('названия нет и обычный аккаунт: ничего не запрашивается и не пишется', async () => {
    const h = createHarness({ state: makeState({ ...FREE_DONE, profileKind: 'personal' }) });

    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.calls).toEqual([]);
    expect(h.contacts.calls).toEqual([]);
    expect(h.repo.saves).toEqual([]);
  });

  it.each([
    ['кандидат уже есть', { candidate: makeChatCandidate({ source: 'phone' }) }],
    ['компания уже подтверждена', { confirmed: makeConfirmed() }],
  ])('%s: ничего не запрашивается и не пишется', async (_label, overrides) => {
    const h = createHarness({ state: named(overrides) });

    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.calls).toEqual([]);
    expect(h.repo.saves).toEqual([]);
  });

  it('по тому же названию повторно не ищем: регистр, кавычки и форма собственности не в счёт', async () => {
    const h = createHarness({
      state: named({
        statedName: 'ТОО «ПЛАТФОРМА-А»',
        lookedUpName: 'платформа а',
        research: { status: 'failed', reason: 'not_in_2gis', finishedAtMs: NOW - 1000 },
      }),
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.calls).toEqual([]);
    expect(h.repo.saves).toEqual([]);
  });

  it('клиент поправил название: ищем снова, даже если по старому уже искали', async () => {
    const h = createHarness({
      state: named({
        statedName: 'Бета',
        lookedUpName: 'платформа а',
        research: { status: 'failed', reason: 'not_in_2gis', finishedAtMs: NOW - 1000 },
      }),
      directory: { lookup: lookupBy({ name: BY_NAME }) },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.lookups()).toEqual([{ by: 'name', name: 'Бета' }]);
    expect(h.repo.current().lookedUpName).toBe('бета');
    expect(h.repo.current().candidate).toMatchObject({ source: 'message' });
  });

  it('название из одних форм собственности (ТОО): ни поиска, ни проверки', async () => {
    const h = createHarness({ state: named({ statedName: 'ТОО' }) });

    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.calls).toEqual([]);
    expect(h.repo.saves).toEqual([]);
  });

  it('отклонённая раньше компания не выбирается по названию, запускается проверка новой компании', async () => {
    const h = createHarness({
      state: named({ rejectedIds: [companyIdOf(8)] }),
      directory: { lookup: lookupBy({ name: BY_NAME }), startResearch: () => QUEUED },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.repo.current().candidate).toBeNull();
    expect(h.directory.count('startResearch')).toBe(1);
  });

  it('поиск по названию не получил ответа: название не запоминается, проверка не запускается, повтор позже', async () => {
    let available = false;
    const h = createHarness({
      state: named(),
      directory: {
        lookup: () => (available ? BY_NAME : fail('unavailable')),
      },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.repo.current().lookedUpName).toBeNull();
    expect(h.directory.count('startResearch')).toBe(0);
    expect(h.repo.saves).toEqual([]);

    available = true;
    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.lookups()).toHaveLength(2);
    expect(h.repo.current().candidate).toMatchObject({ source: 'message' });
  });

  it.each<CompanyApiFailure>(['bad_request', 'unauthorized', 'not_found', 'invalid_response'])(
    'сбой поиска %s считается пройденным шагом: название запомнено, дальше проверка новой компании',
    async (failure) => {
      const h = createHarness({
        state: named(),
        directory: { lookup: () => fail(failure), startResearch: () => QUEUED },
      });

      await h.service.identifyAfterReply(makeChat());

      expect(h.repo.current().lookedUpName).toBe('платформа а');
      expect(h.directory.count('startResearch')).toBe(1);
      expect(
        h.logs.filter((entry) => entry.level === 'warn').map((entry) => entry.context),
      ).toEqual([{ chatId: 12, step: 'message', failure }]);
    },
  );
});

describe('identifyAfterReply: проверка новой компании', () => {
  it('компания не найдена: запускается проверка с названием, городом, номером и доменом', async () => {
    const h = createHarness({
      state: named({ profileKind: 'business', profileDomain: 'sklad.kz' }),
      directory: { startResearch: () => QUEUED },
    });
    h.clock.advance(3000);

    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.calls.filter((call) => call.method === 'startResearch')).toEqual([
      {
        method: 'startResearch',
        request: {
          name: 'Платформа-А',
          city: 'Алматы',
          phone: '77000000001',
          domain: 'sklad.kz',
        },
      },
    ]);
    expect(h.repo.current().research).toEqual({
      status: 'queued',
      jobId: jobIdOf('job-1'),
      startedAtMs: NOW + 3000,
      checkedAtMs: NOW + 3000,
    });
  });

  it('проверка идёт: промпт searching, название снова не спрашивается', async () => {
    const h = createHarness({ state: named(), directory: { startResearch: () => QUEUED } });

    await h.service.identifyAfterReply(makeChat());
    const turn = await h.service.prepare(makeChat(), []);

    expect(turn).toEqual({ prompt: { kind: 'searching' }, awaitingAnswer: false });
  });

  it('номера нет (только @lid), домена и города нет: в запросе null', async () => {
    const h = createHarness({
      state: named({ statedCity: null }),
      directory: { startResearch: () => QUEUED },
    });

    await h.service.identifyAfterReply(lidChat());

    expect(h.directory.calls.find((call) => call.method === 'startResearch')).toEqual({
      method: 'startResearch',
      request: { name: 'Платформа-А', city: null, phone: null, domain: null },
    });
  });

  it('проект B уже знает компанию: справка по company_id, кандидат с источником research, проверка done', async () => {
    const brief = makeBrief({ id: companyIdOf(51), name: 'Гамма-Склад', city: 'Астана' });
    const h = createHarness({
      state: named(),
      directory: {
        startResearch: () => ok({ kind: 'done', companyId: companyIdOf(51) }),
        brief: () => ok(brief),
      },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.calls.at(-1)).toEqual({ method: 'brief', id: companyIdOf(51) });
    expect(h.repo.current()).toMatchObject({
      research: { status: 'done', companyId: companyIdOf(51), finishedAtMs: NOW },
      candidate: {
        id: companyIdOf(51),
        name: 'Гамма-Склад',
        city: 'Астана',
        source: 'research',
        askedAtMs: null,
        awaitingAnswer: false,
      },
    });
  });

  it('проект B вернул компанию, которую клиент уже отклонил: справка не запрашивается, кандидата нет', async () => {
    const h = createHarness({
      state: named({ rejectedIds: [companyIdOf(51)] }),
      directory: { startResearch: () => ok({ kind: 'done', companyId: companyIdOf(51) }) },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.count('brief')).toBe(0);
    expect(h.repo.current()).toMatchObject({
      candidate: null,
      research: { status: 'done', companyId: companyIdOf(51) },
    });
  });

  it('проект B вернул готовую компанию, справка недоступна: проверка не записывается, повтор позже', async () => {
    let briefAvailable = false;
    const h = createHarness({
      state: named(),
      directory: {
        startResearch: () => ok({ kind: 'done', companyId: companyIdOf(51) }),
        brief: () =>
          briefAvailable ? ok(makeBrief({ id: companyIdOf(51) })) : fail('unavailable'),
      },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.repo.current()).toMatchObject({ research: null, candidate: null });
    expect(h.repo.current().lookedUpName).toBe('платформа а');

    briefAvailable = true;
    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.lookups()).toHaveLength(1);
    expect(h.directory.count('startResearch')).toBe(2);
    expect(h.repo.current()).toMatchObject({
      research: { status: 'done' },
      candidate: { id: 51, source: 'research' },
    });
  });

  it.each(['rate_limited', 'budget_exhausted'] as const)(
    'отказ %s при запуске: проверка failed с этой причиной, работа без справки',
    async (failure) => {
      const h = createHarness({
        state: named(),
        directory: { startResearch: () => fail(failure) },
      });

      await h.service.identifyAfterReply(makeChat());
      const turn = await h.service.prepare(makeChat(), []);

      expect(h.repo.current().research).toEqual({
        status: 'failed',
        reason: failure,
        finishedAtMs: NOW,
      });
      expect(turn).toEqual({ prompt: { kind: 'unknown', askName: false }, awaitingAnswer: false });
    },
  );

  it('API недоступно при запуске: ничего не записывается о проверке, повтор при следующем вызове', async () => {
    let available = false;
    const h = createHarness({
      state: named(),
      directory: { startResearch: () => (available ? QUEUED : fail('unavailable')) },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.repo.current().research).toBeNull();
    expect(h.repo.current().lookedUpName).toBe('платформа а');

    available = true;
    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.lookups()).toHaveLength(1);
    expect(h.repo.current().research).toMatchObject({ status: 'queued' });
  });

  it.each<CompanyApiFailure>(['bad_request', 'unauthorized', 'not_found', 'invalid_response'])(
    'прочий сбой запуска %s: проверка failed без причины',
    async (failure) => {
      const h = createHarness({
        state: named(),
        directory: { startResearch: () => fail(failure) },
      });

      await h.service.identifyAfterReply(makeChat());

      expect(h.repo.current().research).toEqual({
        status: 'failed',
        reason: null,
        finishedAtMs: NOW,
      });
    },
  );

  it.each([
    ['в очереди', { status: 'queued', jobId: jobIdOf('j'), startedAtMs: NOW, checkedAtMs: NOW }],
    ['завершена', { status: 'done', companyId: companyIdOf(51), finishedAtMs: NOW }],
    ['неудачна', { status: 'failed', reason: 'error', finishedAtMs: NOW }],
  ] as const)(
    'проверка не больше одной на чат: %s, новая не запускается',
    async (_label, research) => {
      const h = createHarness({ state: named({ research, lookedUpName: 'платформа а' }) });

      await h.service.identifyAfterReply(makeChat());

      expect(h.directory.count('startResearch')).toBe(0);
    },
  );

  it('после отказа клиента от кандидата по его же словам: ищем не заново, но проверка новой компании запускается', async () => {
    const h = createHarness({
      state: named({ lookedUpName: 'платформа а', rejectedIds: [companyIdOf(8)] }),
      directory: { startResearch: () => QUEUED },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.lookups()).toEqual([]);
    expect(h.directory.count('startResearch')).toBe(1);
  });

  it('в лог при сбоях попадают только ID чата, шаг и код: ни названия, ни города, ни номера', async () => {
    const h = createHarness({
      state: named({ statedName: 'СЕКРЕТНАЯ-КОМПАНИЯ', statedCity: 'СЕКРЕТНЫЙ-ГОРОД' }),
      directory: { lookup: () => fail('unavailable') },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.logs.map((entry) => entry.context)).toEqual([
      { chatId: 12, step: 'message', failure: 'unavailable' },
    ]);
    expect(loggedText(h.logs)).not.toContain('СЕКРЕТН');
  });

  it('сбой базы при чтении пробрасывается как есть', async () => {
    const h = createHarness({ state: named() });
    const failure = new Error('база недоступна');
    h.repo.failNext('get', failure);

    await expect(h.service.identifyAfterReply(makeChat())).rejects.toBe(failure);
  });

  it('сбой базы при записи пробрасывается как есть', async () => {
    const h = createHarness({
      state: named(),
      directory: { lookup: lookupBy({ name: BY_NAME }) },
    });
    const failure = new Error('база недоступна');
    h.repo.failNext('save', failure);

    await expect(h.service.identifyAfterReply(makeChat())).rejects.toBe(failure);
  });
});
