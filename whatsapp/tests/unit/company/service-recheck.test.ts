import { describe, expect, it } from 'vitest';
import type {
  CandidateSource,
  ChatCandidate,
  ChatCompanyState,
  CompanyApiFailure,
} from '../../../src/domain/company.js';
import { loggedText, makeChat } from '../handoff/fakes.js';
import {
  CHAT_ID,
  companyIdOf,
  makeCandidate,
  makeChatCandidate,
  makeState,
  MINUTE_MS,
  NOW,
} from './builders.js';
import { createHarness, fail, lookupBy, makeMessage, ok } from './fakes.js';

// Клиент назвал компанию, а кандидат уже есть: кандидат снимается, только если поиск по названию клиента нашёл
// другую компанию (другой ID). Строгое несовпадение названий («Magnum» и «Magnum Cash&Carry») кандидата не снимает.

const MAGNUM = makeChatCandidate({
  id: companyIdOf(7),
  name: 'Magnum Cash&Carry',
  city: 'Алматы',
  source: 'phone',
});

const MAGNUM_FOUND = makeCandidate({
  id: companyIdOf(7),
  name: 'Magnum Cash&Carry',
  matchBy: 'name',
  matchScore: 0.85,
});

const BETA_FOUND = makeCandidate({
  id: companyIdOf(9),
  name: 'Бета',
  city: 'Астана',
  matchBy: 'name',
  matchScore: 0.9,
});

const UNASKED = MAGNUM;
const ASKED_NO_ANSWER = { ...MAGNUM, askedAtMs: NOW - MINUTE_MS, awaitingAnswer: false };
const AWAITING = { ...MAGNUM, askedAtMs: NOW - MINUTE_MS, awaitingAnswer: true };

function withCandidate(
  candidate: ChatCandidate,
  overrides: Partial<ChatCompanyState> = {},
): ChatCompanyState {
  return makeState({ freeStepsAtMs: NOW - MINUTE_MS, candidate, ...overrides });
}

describe('identifyAfterReply: клиент назвал компанию при кандидате, варианты названия', () => {
  it('по названию клиента ничего, по варианту нашлась другая компания: кандидат заменён', async () => {
    const h = createHarness({
      state: withCandidate(UNASKED, {
        statedName: 'Бетта',
        statedCity: 'Караганда',
        statedAliases: ['Бета'],
      }),
      directory: {
        lookup: (query) =>
          query.by === 'name' && query.name === 'Бета' ? ok([BETA_FOUND]) : ok([]),
      },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.lookups()).toEqual([
      { by: 'name', name: 'Бетта' },
      { by: 'name', name: 'Бета' },
    ]);
    expect(h.repo.current().candidate).toMatchObject({ id: companyIdOf(9), source: 'message' });
  });
});

describe('identifyAfterReply: клиент назвал компанию при кандидате', () => {
  it('пример владельца: кандидат по номеру «Magnum Cash&Carry», клиент сказал «Magnum», поиск нашёл тот же ID: кандидат остаётся', async () => {
    const h = createHarness({
      state: withCandidate(UNASKED, { statedName: 'Magnum' }),
      directory: { lookup: lookupBy({ name: ok([MAGNUM_FOUND]) }) },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.lookups()).toEqual([{ by: 'name', name: 'Magnum' }]);
    expect(h.repo.current()).toEqual(
      withCandidate(UNASKED, { statedName: 'Magnum', lookedUpName: 'magnum' }),
    );
    expect(h.directory.count('startResearch')).toBe(0);
  });

  it.each<[string, ChatCandidate]>([
    ['не спрошен', UNASKED],
    ['спрошен, но клиент не ответил', ASKED_NO_ANSWER],
  ])(
    'кандидат %s, поиск по названию клиента нашёл другой ID: старый снят без отклонения, предлагается новый',
    async (_label, candidate) => {
      const h = createHarness({
        state: withCandidate(candidate, { statedName: 'ТОО «Бета»' }),
        directory: { lookup: lookupBy({ name: ok([BETA_FOUND]) }) },
      });

      await h.service.identifyAfterReply(makeChat());
      const turn = await h.service.prepare(makeChat(), []);

      expect(h.repo.current()).toMatchObject({
        candidate: {
          id: companyIdOf(9),
          name: 'Бета',
          source: 'message',
          askedAtMs: null,
          awaitingAnswer: false,
        },
        rejectedIds: [],
        lookedUpName: 'бета',
      });
      expect(turn.prompt).toEqual({
        kind: 'candidate',
        name: 'Бета',
        city: 'Астана',
        withCity: true,
      });
      expect(h.logs.map((entry) => entry.context)).toEqual([{ chatId: 12, step: 'message' }]);
      expect(loggedText(h.logs)).not.toMatch(/Бета|Magnum/u);
    },
  );

  it.each<CandidateSource>(['profile_domain', 'profile_name', 'logo', 'message', 'research'])(
    'кандидат из источника %s тоже заменяется, если поиск нашёл другой ID',
    async (source) => {
      const h = createHarness({
        state: withCandidate(
          { ...UNASKED, source },
          { statedName: 'Бета', lookedUpName: 'magnum' },
        ),
        directory: { lookup: lookupBy({ name: ok([BETA_FOUND]) }) },
      });

      await h.service.identifyAfterReply(makeChat());

      expect(h.repo.current().candidate).toMatchObject({ id: companyIdOf(9), source: 'message' });
    },
  );

  it('поиск ничего не нашёл: кандидат остаётся, проверка новой компании не запускается, по тому же названию больше не ищем', async () => {
    const h = createHarness({
      state: withCandidate(UNASKED, { statedName: 'Бета' }),
      directory: { lookup: lookupBy({ name: ok([]) }) },
    });

    await h.service.identifyAfterReply(makeChat());
    await h.service.identifyAfterReply(makeChat());
    await h.service.prepare(makeChat(), []);

    expect(h.directory.lookups()).toHaveLength(1);
    expect(h.directory.count('startResearch')).toBe(0);
    expect(h.repo.current()).toMatchObject({ candidate: UNASKED, lookedUpName: 'бета' });
  });

  it('поиск неоднозначен (две близкие компании): кандидат остаётся', async () => {
    const h = createHarness({
      state: withCandidate(UNASKED, { statedName: 'Бета' }),
      directory: {
        lookup: lookupBy({
          name: ok([BETA_FOUND, { ...BETA_FOUND, id: companyIdOf(10), matchScore: 0.85 }]),
        }),
      },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.repo.current().candidate).toEqual(UNASKED);
  });

  it('поиск находит только отклонённую клиентом компанию: кандидат остаётся', async () => {
    const h = createHarness({
      state: withCandidate(UNASKED, { statedName: 'Бета', rejectedIds: [companyIdOf(9)] }),
      directory: { lookup: lookupBy({ name: ok([BETA_FOUND]) }) },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.repo.current().candidate).toEqual(UNASKED);
  });

  it.each<CompanyApiFailure>(['unavailable', 'timeout'])(
    'временный сбой поиска %s: ничего не пишется, поиск повторится',
    async (failure) => {
      let failing = true;
      const h = createHarness({
        state: withCandidate(UNASKED, { statedName: 'Бета' }),
        directory: {
          lookup: (query) =>
            failing ? fail(failure) : lookupBy({ name: ok([BETA_FOUND]) })(query),
        },
      });

      await h.service.identifyAfterReply(makeChat());
      expect(h.repo.saves).toEqual([]);
      failing = false;
      await h.service.identifyAfterReply(makeChat());

      expect(h.directory.lookups()).toHaveLength(2);
      expect(h.repo.current().candidate).toMatchObject({ id: companyIdOf(9) });
    },
  );

  it.each<[string, Partial<ChatCompanyState>]>([
    ['клиент не называл компанию', { statedName: null }],
    ['по этому названию уже искали', { statedName: 'ТОО «Бета»', lookedUpName: 'бета' }],
    ['название клиента совпадает с кандидатом', { statedName: 'ТОО «MAGNUM CASH & CARRY»' }],
    ['название клиента из одних форм собственности', { statedName: 'ТОО' }],
    ['ждём ответа на вопрос о кандидате', { statedName: 'Бета', candidate: AWAITING }],
  ])('%s: поиска нет, ничего не пишется', async (_label, overrides) => {
    const h = createHarness({
      state: withCandidate(UNASKED, overrides),
      directory: { lookup: lookupBy({ name: ok([BETA_FOUND]) }) },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.calls).toEqual([]);
    expect(h.repo.saves).toEqual([]);
  });
});

describe('prepare: найденный бесплатными шагами кандидат при уже названной компании', () => {
  const MESSAGES = [makeMessage()];

  it('клиент уже назвал другую компанию (API тогда не отвечало), поиск по его названию нашёл другой ID: предлагается она', async () => {
    const h = createHarness({
      state: makeState({ statedName: 'Бета' }),
      directory: {
        lookup: lookupBy({ phone: ok([makeCandidate()]), name: ok([BETA_FOUND]) }),
      },
    });

    const turn = await h.service.prepare(makeChat(), MESSAGES);

    expect(h.directory.lookups()).toEqual([
      { by: 'phone', phone: '77000000001' },
      { by: 'name', name: 'Бета' },
    ]);
    expect(turn.prompt).toEqual({
      kind: 'candidate',
      name: 'Бета',
      city: 'Астана',
      withCity: true,
    });
    expect(h.repo.current()).toMatchObject({
      candidate: { id: companyIdOf(9), source: 'message' },
      rejectedIds: [],
      freeStepsAtMs: NOW,
      lookedUpName: 'бета',
    });
  });

  it('поиск по названию клиента ничего не нашёл: кандидат по номеру остаётся и будет спрошен', async () => {
    const h = createHarness({
      state: makeState({ statedName: 'Бета' }),
      directory: { lookup: lookupBy({ phone: ok([makeCandidate()]) }) },
    });

    const turn = await h.service.prepare(makeChat(), MESSAGES);

    expect(turn.prompt).toMatchObject({ kind: 'candidate', name: 'Платформа-А', withCity: false });
    expect(h.repo.current()).toMatchObject({
      candidate: { id: companyIdOf(8), source: 'phone' },
      lookedUpName: 'бета',
      freeStepsAtMs: NOW,
    });
  });
});

describe('applyAssessment: клиент назвал компанию при кандидате', () => {
  it('название записывается, кандидат не снимается до поиска (без строгого сравнения названий)', async () => {
    const h = createHarness({
      state: withCandidate(UNASKED),
      directory: { lookup: lookupBy({ name: ok([BETA_FOUND]) }) },
    });

    const prompt = await h.service.applyAssessment(CHAT_ID, {
      name: 'Бета',
      city: null,
      aliases: [],
      answer: 'none',
      pains: [],
    });

    expect(prompt).toMatchObject({ kind: 'candidate', name: 'Magnum Cash&Carry' });
    expect(h.repo.current()).toMatchObject({ candidate: UNASKED, statedName: 'Бета' });
    expect(h.directory.calls).toEqual([]);
  });
});
