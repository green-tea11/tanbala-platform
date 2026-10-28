import { describe, expect, it } from 'vitest';
import type {
  ChatCompanyState,
  CompanyApiFailure,
  ResearchFailReason,
  ResearchState,
} from '../../../src/domain/company.js';
import { loggedText, makeChat } from '../handoff/fakes.js';
import {
  companyIdOf,
  jobIdOf,
  makeBrief,
  makeChatCandidate,
  makeConfirmed,
  makeState,
  MINUTE_MS,
  NOW,
  SECOND_MS,
} from './builders.js';
import { createHarness, fail, ok } from './fakes.js';

// Справка подтверждённой компании и опрос идущей проверки новой компании: то, что prepare делает после поиска.

const FREE_DONE = { freeStepsAtMs: NOW - MINUTE_MS };

function stateWithResearch(
  research: ResearchState,
  overrides: Partial<ChatCompanyState> = {},
): ChatCompanyState {
  return makeState({ ...FREE_DONE, statedName: 'Гамма', research, ...overrides });
}

/** Идущая проверка: запущена `startedAgoMs` назад, последний опрос `checkedAgoMs` назад. */
function running(
  startedAgoMs: number,
  checkedAgoMs: number,
  status: 'queued' | 'running' = 'queued',
) {
  return {
    status,
    jobId: jobIdOf('job-1'),
    startedAtMs: NOW - startedAgoMs,
    checkedAtMs: NOW - checkedAgoMs,
  } as const;
}

describe('prepare: справка подтверждённой компании', () => {
  const confirmedWithoutBrief = makeState({ ...FREE_DONE, confirmed: makeConfirmed() });

  it('справки ещё нет: запрашивается, записывается со временем, боли и рубрика уходят в промпт', async () => {
    const h = createHarness({
      state: confirmedWithoutBrief,
      directory: { brief: () => ok(makeBrief()) },
    });

    const turn = await h.service.prepare(makeChat(), []);

    expect(h.directory.calls).toEqual([{ method: 'brief', id: companyIdOf(8) }]);
    expect(turn.prompt).toEqual({
      kind: 'confirmed',
      name: 'Платформа-А',
      rubric: 'Складское хранение',
      pains: ['Инвентаризация занимает дни и отрывает людей'],
      emailed: false,
    });
    expect(h.repo.current().confirmed).toMatchObject({ brief: makeBrief(), briefAtMs: NOW });
  });

  it('справка уже есть: повторно не запрашивается и ничего не пишется', async () => {
    const h = createHarness({
      state: makeState({
        ...FREE_DONE,
        confirmed: makeConfirmed({ brief: makeBrief(), briefAtMs: NOW - MINUTE_MS }),
      }),
    });

    await h.service.prepare(makeChat(), []);

    expect(h.directory.calls).toEqual([]);
    expect(h.repo.saves).toEqual([]);
  });

  it('API недоступно: справки нет, промпт без болей и рубрики, исключения нет, ничего не пишется', async () => {
    const h = createHarness({
      state: confirmedWithoutBrief,
      directory: { brief: () => fail('unavailable') },
    });

    const turn = await h.service.prepare(makeChat(), []);

    expect(turn.prompt).toEqual({
      kind: 'confirmed',
      name: 'Платформа-А',
      rubric: null,
      pains: [],
      emailed: false,
    });
    expect(h.repo.saves).toEqual([]);
  });

  it('следующая пачка запрашивает справку снова, не чаще раза на пачку', async () => {
    let available = false;
    const h = createHarness({
      state: confirmedWithoutBrief,
      directory: { brief: () => (available ? ok(makeBrief()) : fail('unavailable')) },
    });

    await h.service.prepare(makeChat(), []);
    expect(h.directory.count('brief')).toBe(1);
    available = true;
    const turn = await h.service.prepare(makeChat(), []);

    expect(h.directory.count('brief')).toBe(2);
    expect(turn.prompt).toMatchObject({ kind: 'confirmed', rubric: 'Складское хранение' });
    expect(h.repo.current().confirmed?.brief).not.toBeNull();
  });

  it.each<CompanyApiFailure>(['not_found', 'invalid_response', 'unauthorized', 'bad_request'])(
    'сбой справки %s: без исключения, в лог только чат, шаг и код',
    async (failure) => {
      const h = createHarness({
        state: confirmedWithoutBrief,
        directory: { brief: () => fail(failure) },
      });

      const turn = await h.service.prepare(makeChat(), []);

      expect(turn.prompt.kind).toBe('confirmed');
      expect(h.logs.map((entry) => entry.context)).toEqual([
        { chatId: 12, step: 'brief', failure },
      ]);
      expect(loggedText(h.logs)).not.toContain('Платформа');
    },
  );

  it('справка идёт в промпт без цитат и источников', async () => {
    const h = createHarness({
      state: confirmedWithoutBrief,
      directory: { brief: () => ok(makeBrief({ emailed: true })) },
    });

    const turn = await h.service.prepare(makeChat(), []);

    expect(JSON.stringify(turn.prompt)).not.toContain('11 000');
    expect(turn.prompt).toMatchObject({ emailed: true });
  });
});

describe('prepare: опрос идущей проверки новой компании', () => {
  it('до пяти секунд с прошлого опроса статус не спрашивается: промпт searching, ничего не пишется', async () => {
    const h = createHarness({ state: stateWithResearch(running(60 * SECOND_MS, 4999)) });

    const turn = await h.service.prepare(makeChat(), []);

    expect(h.directory.calls).toEqual([]);
    expect(turn).toEqual({ prompt: { kind: 'searching' }, awaitingAnswer: false });
    expect(h.repo.saves).toEqual([]);
  });

  it('ровно через пять секунд статус спрашивается; проверка идёт: время опроса и статус обновляются', async () => {
    const h = createHarness({
      state: stateWithResearch(running(60 * SECOND_MS, 5000, 'queued')),
      directory: { researchStatus: () => ok({ status: 'running' }) },
    });

    const turn = await h.service.prepare(makeChat(), []);

    expect(h.directory.calls).toEqual([{ method: 'researchStatus', jobId: jobIdOf('job-1') }]);
    expect(turn.prompt).toEqual({ kind: 'searching' });
    expect(h.repo.current().research).toEqual({
      status: 'running',
      jobId: jobIdOf('job-1'),
      startedAtMs: NOW - 60 * SECOND_MS,
      checkedAtMs: NOW,
    });
  });

  it('проверка в очереди остаётся в очереди, время опроса обновляется', async () => {
    const h = createHarness({
      state: stateWithResearch(running(10 * SECOND_MS, 6000, 'queued')),
      directory: { researchStatus: () => ok({ status: 'queued' }) },
    });

    await h.service.prepare(makeChat(), []);

    expect(h.repo.current().research).toMatchObject({ status: 'queued', checkedAtMs: NOW });
  });

  it('завершена: кандидат из справки с источником research, имя и город из справки', async () => {
    const brief = makeBrief({ id: companyIdOf(51), name: 'Гамма-Склад', city: 'Астана' });
    const h = createHarness({
      state: stateWithResearch(running(2 * MINUTE_MS, 10 * SECOND_MS)),
      directory: { researchStatus: () => ok({ status: 'done', brief }) },
    });

    const turn = await h.service.prepare(makeChat(), []);

    expect(turn).toEqual({
      prompt: { kind: 'candidate', name: 'Гамма-Склад', city: 'Астана', withCity: true },
      awaitingAnswer: false,
    });
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

  it('завершена, но клиент уже отклонил эту компанию: кандидата нет, проверка done', async () => {
    const h = createHarness({
      state: stateWithResearch(running(MINUTE_MS, 10 * SECOND_MS), {
        rejectedIds: [companyIdOf(51)],
      }),
      directory: {
        researchStatus: () => ok({ status: 'done', brief: makeBrief({ id: companyIdOf(51) }) }),
      },
    });

    const turn = await h.service.prepare(makeChat(), []);

    expect(turn.prompt).toEqual({ kind: 'unknown', askName: false });
    expect(h.repo.current()).toMatchObject({
      candidate: null,
      research: { status: 'done', companyId: companyIdOf(51) },
    });
  });

  it('завершена, но подтверждённая компания уже есть: кандидата не появляется', async () => {
    const h = createHarness({
      state: stateWithResearch(running(MINUTE_MS, 10 * SECOND_MS), {
        confirmed: makeConfirmed({ brief: makeBrief(), briefAtMs: NOW - 1000 }),
      }),
      directory: {
        researchStatus: () => ok({ status: 'done', brief: makeBrief({ id: companyIdOf(51) }) }),
      },
    });

    const turn = await h.service.prepare(makeChat(), []);

    expect(turn.prompt.kind).toBe('confirmed');
    expect(h.repo.current().candidate).toBeNull();
    expect(h.repo.current().research?.status).toBe('done');
  });

  it('завершена, но другой кандидат уже есть: он остаётся, проверка done', async () => {
    const existing = makeChatCandidate({ id: companyIdOf(9), name: 'Другая', source: 'phone' });
    const h = createHarness({
      state: stateWithResearch(running(MINUTE_MS, 10 * SECOND_MS), { candidate: existing }),
      directory: {
        researchStatus: () => ok({ status: 'done', brief: makeBrief({ id: companyIdOf(51) }) }),
      },
    });

    await h.service.prepare(makeChat(), []);

    expect(h.repo.current().candidate).toEqual(existing);
    expect(h.repo.current().research?.status).toBe('done');
  });

  it.each<ResearchFailReason>(['not_in_2gis', 'city_unsupported', 'budget_exhausted', 'error'])(
    'проверка не удалась с причиной %s: состояние failed с этой причиной',
    async (reason) => {
      const h = createHarness({
        state: stateWithResearch(running(MINUTE_MS, 10 * SECOND_MS)),
        directory: { researchStatus: () => ok({ status: 'failed', reason }) },
      });

      const turn = await h.service.prepare(makeChat(), []);

      expect(turn.prompt).toEqual({ kind: 'unknown', askName: false });
      expect(h.repo.current().research).toEqual({ status: 'failed', reason, finishedAtMs: NOW });
    },
  );

  it('проверка не удалась без причины: failed с reason null', async () => {
    const h = createHarness({
      state: stateWithResearch(running(MINUTE_MS, 10 * SECOND_MS)),
      directory: { researchStatus: () => ok({ status: 'failed', reason: null }) },
    });

    await h.service.prepare(makeChat(), []);

    expect(h.repo.current().research).toEqual({
      status: 'failed',
      reason: null,
      finishedAtMs: NOW,
    });
  });

  it('проект B не знает задачу: failed с причиной not_found', async () => {
    const h = createHarness({
      state: stateWithResearch(running(MINUTE_MS, 10 * SECOND_MS)),
      directory: { researchStatus: () => ok({ status: 'not_found' }) },
    });

    await h.service.prepare(makeChat(), []);

    expect(h.repo.current().research).toEqual({
      status: 'failed',
      reason: 'not_found',
      finishedAtMs: NOW,
    });
  });

  it('дольше 15 минут с запуска: failed с причиной timeout', async () => {
    const h = createHarness({
      state: stateWithResearch(running(15 * MINUTE_MS + 1, 2 * SECOND_MS)),
    });

    const turn = await h.service.prepare(makeChat(), []);

    expect(h.directory.calls).toEqual([]);
    expect(turn.prompt).toEqual({ kind: 'unknown', askName: false });
    expect(h.repo.current().research).toEqual({
      status: 'failed',
      reason: 'timeout',
      finishedAtMs: NOW,
    });
  });

  it('ровно 15 минут ещё не таймаут', async () => {
    const h = createHarness({ state: stateWithResearch(running(15 * MINUTE_MS, 2 * SECOND_MS)) });

    const turn = await h.service.prepare(makeChat(), []);

    expect(turn.prompt).toEqual({ kind: 'searching' });
    expect(h.repo.current().research?.status).toBe('queued');
  });

  it('опрос не удался (API недоступно): время опроса обновляется, проверка остаётся, исключения нет', async () => {
    const h = createHarness({
      state: stateWithResearch(running(MINUTE_MS, 10 * SECOND_MS)),
      directory: { researchStatus: () => fail('unavailable') },
    });

    const turn = await h.service.prepare(makeChat(), []);

    expect(turn.prompt).toEqual({ kind: 'searching' });
    expect(h.repo.current().research).toMatchObject({ status: 'queued', checkedAtMs: NOW });
    expect(h.logs.map((entry) => entry.context)).toEqual([
      { chatId: 12, step: 'research_status', failure: 'unavailable' },
    ]);
  });

  it('опрос не удался, а с запуска прошло больше 15 минут: timeout', async () => {
    const h = createHarness({
      state: stateWithResearch(running(16 * MINUTE_MS, 10 * SECOND_MS)),
      directory: { researchStatus: () => fail('unavailable') },
    });

    await h.service.prepare(makeChat(), []);

    expect(h.repo.current().research).toMatchObject({ status: 'failed', reason: 'timeout' });
  });

  it('проверка завершилась, пока никто не спрашивал, и прошло больше 15 минут: результат важнее таймаута', async () => {
    const h = createHarness({
      state: stateWithResearch(running(20 * MINUTE_MS, 10 * MINUTE_MS)),
      directory: {
        researchStatus: () => ok({ status: 'done', brief: makeBrief({ id: companyIdOf(51) }) }),
      },
    });

    const turn = await h.service.prepare(makeChat(), []);

    expect(turn.prompt.kind).toBe('candidate');
    expect(h.repo.current().research?.status).toBe('done');
  });

  it.each([
    ['завершённая', { status: 'done', companyId: companyIdOf(8), finishedAtMs: NOW - 1000 }],
    ['неудачная', { status: 'failed', reason: 'error', finishedAtMs: NOW - 1000 }],
  ] as const)('%s проверка больше не опрашивается', async (_label, research) => {
    const h = createHarness({ state: stateWithResearch(research) });

    await h.service.prepare(makeChat(), []);

    expect(h.directory.calls).toEqual([]);
    expect(h.repo.saves).toEqual([]);
  });

  it('в лог при неудаче опроса не попадает идентификатор задачи', async () => {
    const h = createHarness({
      state: stateWithResearch(running(MINUTE_MS, 10 * SECOND_MS)),
      directory: { researchStatus: () => fail('invalid_response') },
    });

    await h.service.prepare(makeChat(), []);

    expect(loggedText(h.logs)).not.toContain('job-1');
  });

  it('кандидат из проверки ждёт вопроса: awaitingAnswer false, пока бот не спросил', async () => {
    const h = createHarness({
      state: stateWithResearch(running(MINUTE_MS, 10 * SECOND_MS)),
      directory: {
        researchStatus: () => ok({ status: 'done', brief: makeBrief({ id: companyIdOf(51) }) }),
      },
    });

    const turn = await h.service.prepare(makeChat(), []);

    expect(turn.awaitingAnswer).toBe(false);
  });
});
