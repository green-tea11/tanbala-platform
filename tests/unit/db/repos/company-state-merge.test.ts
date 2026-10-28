import { describe, expect, it } from 'vitest';
import { mergeCompanyStates } from '../../../../src/db/repos/company-state-merge.js';
import type { ChatCompanyState, ResearchState } from '../../../../src/domain/company.js';
import {
  companyIdOf,
  deepFreeze,
  jobIdOf,
  makeChatCandidate,
  makeConfirmed,
  makeState,
  NOW,
} from '../../company/builders.js';

// Слияние состояний определения компании двух чатов одного человека по полям: ни подтверждённая компания, ни
// отказы клиента, ни отметки «уже сделано» не теряются, какая бы запись ни была свежее.

const RUNNING: ResearchState = {
  status: 'running',
  jobId: jobIdOf('job-1'),
  startedAtMs: NOW - 1000,
  checkedAtMs: NOW - 500,
};

const DONE: ResearchState = { status: 'done', companyId: companyIdOf(51), finishedAtMs: NOW };

function merged(fresher: ChatCompanyState, older: ChatCompanyState): ChatCompanyState {
  return mergeCompanyStates(deepFreeze(fresher), deepFreeze(older));
}

describe('mergeCompanyStates: правила по полям', () => {
  it('отклонённые компании объединяются без повторов', () => {
    const result = merged(
      makeState({ rejectedIds: [companyIdOf(3), companyIdOf(5)] }),
      makeState({ rejectedIds: [companyIdOf(5), companyIdOf(7)] }),
    );

    expect(result.rejectedIds).toEqual([companyIdOf(5), companyIdOf(7), companyIdOf(3)]);
  });

  it('подтверждённая компания только в более старой записи: берётся она', () => {
    const confirmed = makeConfirmed();

    expect(merged(makeState({ statedName: 'Своя' }), makeState({ confirmed })).confirmed).toEqual(
      confirmed,
    );
  });

  it('подтверждённая компания в обеих записях: из более свежей', () => {
    const fresh = makeConfirmed({ id: companyIdOf(9), name: 'Бета' });

    expect(
      merged(makeState({ confirmed: fresh }), makeState({ confirmed: makeConfirmed() })).confirmed,
    ).toEqual(fresh);
  });

  it('отметка запуска проверки: наибольшая из двух, пустая не затирает', () => {
    expect(
      merged(makeState({ researchStartedAtMs: NOW - 10 }), makeState({ researchStartedAtMs: NOW }))
        .researchStartedAtMs,
    ).toBe(NOW);
    expect(merged(makeState(), makeState({ researchStartedAtMs: NOW })).researchStartedAtMs).toBe(
      NOW,
    );
    expect(merged(makeState({ researchStartedAtMs: NOW }), makeState()).researchStartedAtMs).toBe(
      NOW,
    );
    expect(merged(makeState(), makeState()).researchStartedAtMs).toBeNull();
  });

  it('проверка новой компании из записи, где она есть; в обеих: из более свежей', () => {
    expect(merged(makeState(), makeState({ research: RUNNING })).research).toEqual(RUNNING);
    expect(
      merged(makeState({ research: DONE }), makeState({ research: RUNNING })).research,
    ).toEqual(DONE);
  });

  it('счётчики по максимуму', () => {
    const result = merged(
      makeState({ profileRequests: 1, briefFailures: 2, adoptFailures: 0 }),
      makeState({ profileRequests: 3, briefFailures: 1, adoptFailures: 2 }),
    );

    expect(result).toMatchObject({ profileRequests: 3, briefFailures: 2, adoptFailures: 2 });
  });

  it('остальное из более свежей записи', () => {
    const fresher = makeState({
      profileKind: 'business',
      profileDomain: 'beta.kz',
      freeStepsAtMs: NOW,
      logoCheckedAtMs: NOW,
      statedName: 'Бета',
      statedCity: 'Астана',
      lookedUpName: 'бета',
      candidate: makeChatCandidate({ id: companyIdOf(9), name: 'Бета', source: 'message' }),
      nameAskedAtMs: NOW,
      confirmedPains: ['Пересорт'],
    });
    const older = makeState({
      profileKind: 'personal',
      freeStepsAtMs: NOW - 100,
      logoCheckedAtMs: NOW - 100,
      statedName: 'Альфа',
      statedCity: 'Алматы',
      lookedUpName: 'альфа',
      candidate: makeChatCandidate({ source: 'phone' }),
      nameAskedAtMs: NOW - 100,
      confirmedPains: ['Долгая инвентаризация'],
    });

    expect(merged(fresher, older)).toEqual(fresher);
  });
});

describe('mergeCompanyStates: пустое в свежей записи не затирает известное в старой', () => {
  it('отметки «уже сделано» (шаги, логотип, вопрос о названии) и слова клиента берутся из старой', () => {
    const older = makeState({
      freeStepsAtMs: NOW - 100,
      logoCheckedAtMs: NOW - 90,
      statedName: 'Альфа',
      statedCity: 'Алматы',
      lookedUpName: 'альфа',
      nameAskedAtMs: NOW - 80,
      confirmedPains: ['Пересорт'],
    });

    expect(merged(makeState(), older)).toEqual(older);
  });

  it('бизнес-профиль: известный вид аккаунта с доменом берётся парой, неудачный запрос его не затирает', () => {
    const older = makeState({ profileKind: 'business', profileDomain: 'sklad.kz' });

    expect(merged(makeState({ profileKind: 'unknown' }), older)).toMatchObject({
      profileKind: 'business',
      profileDomain: 'sklad.kz',
    });
    expect(merged(makeState(), older)).toMatchObject({
      profileKind: 'business',
      profileDomain: 'sklad.kz',
    });
    expect(merged(makeState({ profileKind: 'personal' }), older)).toMatchObject({
      profileKind: 'personal',
      profileDomain: null,
    });
    expect(merged(makeState({ profileKind: 'unknown' }), makeState())).toMatchObject({
      profileKind: 'unknown',
    });
  });

  it('кандидат только в старой записи остаётся', () => {
    const candidate = makeChatCandidate({ source: 'phone', askedAtMs: NOW - 10 });

    expect(merged(makeState(), makeState({ candidate })).candidate).toEqual(candidate);
  });
});

describe('mergeCompanyStates: кандидат согласован с итогом', () => {
  it('подтверждённая компания есть хотя бы в одной записи: кандидата нет', () => {
    const result = merged(
      makeState({ candidate: makeChatCandidate({ id: companyIdOf(9) }) }),
      makeState({ confirmed: makeConfirmed() }),
    );

    expect(result).toMatchObject({ candidate: null, confirmed: makeConfirmed() });
  });

  it('клиент отклонил кандидата в другой записи: кандидата нет, отказ сохранён', () => {
    const result = merged(
      makeState({ candidate: makeChatCandidate({ id: companyIdOf(8) }) }),
      makeState({ rejectedIds: [companyIdOf(8)] }),
    );

    expect(result).toMatchObject({ candidate: null, rejectedIds: [companyIdOf(8)] });
  });
});
