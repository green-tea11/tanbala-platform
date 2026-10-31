import { describe, expect, it } from 'vitest';
import type { ChatCompanyState } from '../../../src/domain/company.js';
import { makeChat } from '../handoff/fakes.js';
import {
  companyIdOf,
  jobIdOf,
  makeBrief,
  makeCandidate,
  makeChatCandidate,
  makeState,
  MINUTE_MS,
  NOW,
} from './builders.js';
import { foundByClientWords } from '../../../src/company/offer.js';
import { createHarness, lookupBy, ok } from './fakes.js';

// Подтверждение без вопроса (решение владельца 30.10.2026, уточнено ревью этапа 3): клиент сам назвал компанию и
// город, поиск по его словам (шаг г или проверка новой компании) нашёл её уверенно: название совпадает с тем, что
// написал клиент (похожесть от 0.9, те же цифры, короткие полностью), город карточки тот же. Тогда компания сразу
// подтверждена, справка запрашивается, вопроса нет. Совпал только вариант от модели или города нет: вопрос.

const FREE_DONE = { freeStepsAtMs: NOW - MINUTE_MS };
const T_BANK_ID = companyIdOf(77);

function named(overrides: Partial<ChatCompanyState> = {}): ChatCompanyState {
  return makeState({
    ...FREE_DONE,
    statedName: 'Т-Банк',
    statedAliases: ['Tinkoff', 'Тинькофф'],
    statedCity: 'Алматы',
    ...overrides,
  });
}

const T_BANK = makeCandidate({
  id: T_BANK_ID,
  name: 'АО «Т-Банк»',
  city: 'Алматы',
  matchBy: 'name',
  matchScore: 0.9,
});

const T_BANK_BRIEF = makeBrief({ id: T_BANK_ID, name: 'АО «Т-Банк»', city: 'Алматы' });

/** Проект B находит Т-Банк только по названию «Т-Банк» и отдаёт его справку. */
const BY_ALIAS = {
  lookup: lookupBy({}),
  brief: () => ok(T_BANK_BRIEF),
};

function byAlias(found = T_BANK) {
  return {
    ...BY_ALIAS,
    lookup: (query: { readonly by: string; readonly name?: string }) =>
      query.by === 'name' && query.name === 'Т-Банк' ? ok([found]) : ok([]),
  };
}

describe('шаг г: подтверждение без вопроса', () => {
  it('найдено по названию клиента, город тот же: компания подтверждена, справка получена, кандидата нет', async () => {
    const h = createHarness({ state: named(), directory: byAlias() });

    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.calls.map((call) => call.method)).toEqual(['lookup', 'brief']);
    expect(h.repo.current()).toMatchObject({
      candidate: null,
      confirmed: {
        id: T_BANK_ID,
        name: 'АО «Т-Банк»',
        city: 'Алматы',
        confirmedAtMs: NOW,
        brief: T_BANK_BRIEF,
        briefAtMs: NOW,
      },
    });
    expect(h.logs.map((entry) => entry.context)).toContainEqual({
      chatId: 12,
      step: 'message',
    });
  });

  it('следующий ответ видит справку подтверждённой компании, а не вопрос «верно?»', async () => {
    const h = createHarness({ state: named(), directory: byAlias() });

    await h.service.identifyAfterReply(makeChat());
    const turn = await h.service.prepare(makeChat(), []);

    expect(turn.prompt).toMatchObject({ kind: 'confirmed', name: 'АО «Т-Банк»' });
    expect(turn.awaitingAnswer).toBe(false);
  });

  it('клиент город не называл: найденное по его словам остаётся кандидатом, бот спросит (тёзки в базе почты)', async () => {
    const h = createHarness({ state: named({ statedCity: null }), directory: byAlias() });

    await h.service.identifyAfterReply(makeChat());

    expect(h.repo.current()).toMatchObject({ confirmed: null, candidate: { id: T_BANK_ID } });
  });

  it('совпал только вариант названия от модели («Тинькофф» и «Т-Банк»): кандидат, бот спросит', async () => {
    const h = createHarness({
      state: named({ statedName: 'Тинькофф', statedAliases: ['Т-Банк', 'Tinkoff'] }),
      directory: byAlias(),
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.calls.map((call) => call.method)).toEqual(['lookup', 'lookup']);
    expect(h.repo.current()).toMatchObject({ confirmed: null, candidate: { id: T_BANK_ID } });
  });

  it('город карточки не тот, что назвал клиент: кандидат, вопрос с городом как раньше', async () => {
    const h = createHarness({ state: named({ statedCity: 'Астана' }), directory: byAlias() });

    await h.service.identifyAfterReply(makeChat());
    const turn = await h.service.prepare(makeChat(), []);

    expect(h.repo.current()).toMatchObject({
      confirmed: null,
      candidate: { id: T_BANK_ID, source: 'message', askedAtMs: null },
    });
    expect(h.directory.count('brief')).toBe(0);
    expect(turn.prompt).toEqual({
      kind: 'candidate',
      name: 'АО «Т-Банк»',
      city: 'Алматы',
      withCity: true,
    });
  });

  it('у карточки нет города, а клиент город назвал: кандидат', async () => {
    const h = createHarness({
      state: named(),
      directory: byAlias(makeCandidate({ ...T_BANK, city: null })),
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.repo.current()).toMatchObject({ confirmed: null, candidate: { id: T_BANK_ID } });
  });

  it('название карточки похоже меньше чем на 0.9: кандидат', async () => {
    const h = createHarness({
      state: named(),
      directory: byAlias(makeCandidate({ ...T_BANK, name: 'Т-Банк Лизинг Сервис' })),
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.repo.current()).toMatchObject({ confirmed: null, candidate: { id: T_BANK_ID } });
  });

  it('клиент назвал другую компанию при кандидате по номеру: найденная по его словам заменяет кандидата, но с вопросом', async () => {
    const h = createHarness({
      state: named({ candidate: makeChatCandidate({ id: companyIdOf(5), source: 'phone' }) }),
      directory: byAlias(),
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.repo.current()).toMatchObject({ confirmed: null, candidate: { id: T_BANK_ID } });
  });

  it('справка временно недоступна: компания всё равно подтверждена, справку спросят перед ответом', async () => {
    let available = false;
    const h = createHarness({
      state: named(),
      directory: {
        ...byAlias(),
        brief: () => (available ? ok(T_BANK_BRIEF) : { ok: false, failure: 'unavailable' }),
      },
    });

    await h.service.identifyAfterReply(makeChat());
    expect(h.repo.current().confirmed).toMatchObject({ id: T_BANK_ID, brief: null });
    available = true;
    const turn = await h.service.prepare(makeChat(), []);

    expect(turn.prompt).toMatchObject({ kind: 'confirmed', rubric: 'Складское хранение' });
  });
});

describe('проверка новой компании: подтверждение без вопроса', () => {
  const running = {
    status: 'running',
    jobId: jobIdOf('job-1'),
    startedAtMs: NOW - MINUTE_MS,
    checkedAtMs: NOW - MINUTE_MS,
  } as const;

  it('проверка нашла компанию в городе клиента: подтверждена, справка запрошена отдельно в том же ходе', async () => {
    const h = createHarness({
      state: named({ research: running }),
      directory: {
        researchStatus: () => ok({ status: 'done', brief: T_BANK_BRIEF } as const),
        brief: () => ok(T_BANK_BRIEF),
      },
    });

    const turn = await h.service.prepare(makeChat(), []);

    expect(h.directory.calls.map((call) => call.method)).toEqual(['researchStatus', 'brief']);
    expect(turn.prompt).toMatchObject({ kind: 'confirmed', name: 'АО «Т-Банк»' });
    expect(h.repo.current()).toMatchObject({
      candidate: null,
      research: { status: 'done', companyId: T_BANK_ID },
      confirmed: { id: T_BANK_ID, brief: T_BANK_BRIEF },
    });
  });

  it('клиент город не называл, проверка шла в городе по умолчанию: кандидат, вопрос с городом как раньше', async () => {
    const h = createHarness({
      state: named({ statedCity: null, research: running }),
      directory: { researchStatus: () => ok({ status: 'done', brief: T_BANK_BRIEF } as const) },
    });

    const turn = await h.service.prepare(makeChat(), []);

    expect(h.directory.count('brief')).toBe(0);
    expect(turn.prompt).toEqual({
      kind: 'candidate',
      name: 'АО «Т-Банк»',
      city: 'Алматы',
      withCity: true,
    });
  });

  it('проект B уже знает компанию (200 done) в городе клиента: подтверждена без вопроса', async () => {
    const h = createHarness({
      state: named({ statedAliases: [], statedName: 'Т-Банк' }),
      directory: {
        startResearch: () => ok({ kind: 'done', companyId: T_BANK_ID } as const),
        brief: () => ok(T_BANK_BRIEF),
      },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.repo.current()).toMatchObject({
      candidate: null,
      confirmed: { id: T_BANK_ID, brief: T_BANK_BRIEF },
      research: { status: 'done', companyId: T_BANK_ID },
    });
  });
});

describe('кандидаты не по словам клиента по-прежнему уточняются вопросом', () => {
  it('найдено по номеру с тем же названием и городом, что назвал клиент: кандидат, не подтверждение', async () => {
    const h = createHarness({
      state: makeState({ statedName: 'Т-Банк', statedCity: 'Алматы' }),
      directory: {
        lookup: lookupBy({ phone: ok([{ ...T_BANK, matchBy: 'phone', matchScore: 1 }]) }),
      },
    });

    await h.service.prepare(makeChat(), []);

    expect(h.repo.current()).toMatchObject({
      confirmed: null,
      candidate: { id: T_BANK_ID, source: 'phone' },
    });
  });
});

describe('foundByClientWords', () => {
  const byWords = makeChatCandidate({ id: T_BANK_ID, name: 'Т-Банк', city: 'Алматы' });

  it.each(['profile_domain', 'phone', 'profile_name', 'logo'] as const)(
    'кандидат из источника %s не подтверждается без вопроса',
    (source) => {
      expect(foundByClientWords(named(), { ...byWords, source })).toBe(false);
    },
  );

  it('клиент название не называл: не подтверждается', () => {
    expect(foundByClientWords(named({ statedName: null }), { ...byWords, source: 'message' })).toBe(
      false,
    );
  });

  it('название то же, что написал клиент, город тот же: подтверждается', () => {
    expect(foundByClientWords(named(), { ...byWords, source: 'research' })).toBe(true);
  });

  it('название похоже только на вариант от модели: не подтверждается', () => {
    const tinkoff = named({ statedName: 'Тинькофф', statedAliases: ['Т-Банк'] });
    expect(foundByClientWords(tinkoff, { ...byWords, source: 'research' })).toBe(false);
  });

  it('клиент город не называл: не подтверждается', () => {
    expect(foundByClientWords(named({ statedCity: null }), { ...byWords, source: 'message' })).toBe(
      false,
    );
  });
});
