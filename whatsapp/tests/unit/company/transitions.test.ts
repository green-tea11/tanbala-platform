import { describe, expect, it } from 'vitest';
import {
  afterReplySent,
  candidateFromBrief,
  candidateFromLookup,
  confirmCandidate,
  isRunning,
  markCandidateAsked,
  markNameAsked,
  rejectCandidate,
  stopAwaiting,
  withBrief,
  withProfile,
  withStatedCompany,
} from '../../../src/company/transitions.js';
import {
  companyIdOf,
  deepFreeze,
  jobIdOf,
  makeBrief,
  makeCandidate,
  makeChatCandidate,
  makeConfirmed,
  makeState,
  NOW,
} from './builders.js';

describe('isRunning', () => {
  it.each([
    ['в очереди', { status: 'queued', jobId: jobIdOf('j'), startedAtMs: 1, checkedAtMs: 2 }, true],
    [
      'выполняется',
      { status: 'running', jobId: jobIdOf('j'), startedAtMs: 1, checkedAtMs: 2 },
      true,
    ],
    ['завершена', { status: 'done', companyId: companyIdOf(8), finishedAtMs: 3 }, false],
    ['неудачна', { status: 'failed', reason: null, finishedAtMs: 3 }, false],
    ['проверки нет', null, false],
  ] as const)('проверка %s: %s', (_label, research, expected) => {
    expect(isRunning(research)).toBe(expected);
  });
});

describe('candidateFromLookup и candidateFromBrief', () => {
  it('кандидат из lookup: имя и город компании, источник, не спрошен', () => {
    const found = makeCandidate({ id: companyIdOf(5), name: 'Бета', city: null });

    expect(candidateFromLookup(found, 'phone')).toEqual({
      id: companyIdOf(5),
      name: 'Бета',
      city: null,
      source: 'phone',
      askedAtMs: null,
      awaitingAnswer: false,
    });
  });

  it('кандидат из справки проверки: источник research, имя и город из справки', () => {
    const brief = makeBrief({ id: companyIdOf(51), name: 'Гамма', city: 'Астана' });

    expect(candidateFromBrief(brief)).toEqual({
      id: companyIdOf(51),
      name: 'Гамма',
      city: 'Астана',
      source: 'research',
      askedAtMs: null,
      awaitingAnswer: false,
    });
  });
});

describe('confirmCandidate', () => {
  it('кандидат становится подтверждённой компанией без справки, кандидата больше нет', () => {
    const state = deepFreeze(
      makeState({
        candidate: makeChatCandidate({ askedAtMs: NOW - 5, awaitingAnswer: true }),
        rejectedIds: [companyIdOf(3)],
        statedName: 'Платформа-А',
      }),
    );

    const next = confirmCandidate(state, NOW);

    expect(next).toEqual({
      ...state,
      candidate: null,
      confirmed: {
        id: companyIdOf(8),
        name: 'Платформа-А',
        city: 'Алматы',
        confirmedAtMs: NOW,
        brief: null,
        briefAtMs: null,
      },
    });
  });

  it('кандидата нет: состояние то же', () => {
    const state = makeState();

    expect(confirmCandidate(state, NOW)).toBe(state);
  });
});

describe('rejectCandidate', () => {
  it('ID кандидата в отклонённые, кандидат сброшен, бесплатные шаги и логотип закрыты: дальше вопрос о названии', () => {
    const state = deepFreeze(
      makeState({ candidate: makeChatCandidate(), rejectedIds: [companyIdOf(3)] }),
    );

    expect(rejectCandidate(state, NOW)).toEqual({
      ...state,
      candidate: null,
      rejectedIds: [companyIdOf(3), companyIdOf(8)],
      freeStepsAtMs: NOW,
      logoCheckedAtMs: NOW,
    });
  });

  it('время пройденных шагов и проверки логотипа не перезаписывается', () => {
    const state = makeState({
      candidate: makeChatCandidate(),
      freeStepsAtMs: NOW - 20,
      logoCheckedAtMs: NOW - 10,
    });

    expect(rejectCandidate(state, NOW)).toMatchObject({
      freeStepsAtMs: NOW - 20,
      logoCheckedAtMs: NOW - 10,
    });
  });

  it('повторно один ID не записывается', () => {
    const state = makeState({ candidate: makeChatCandidate(), rejectedIds: [companyIdOf(8)] });

    expect(rejectCandidate(state, NOW).rejectedIds).toEqual([companyIdOf(8)]);
  });

  it('кандидата нет: состояние то же', () => {
    const state = makeState({ rejectedIds: [companyIdOf(3)] });

    expect(rejectCandidate(state, NOW)).toBe(state);
  });
});

describe('afterReplySent: ответ ушёл клиенту', () => {
  const UNASKED = makeChatCandidate({ name: 'ТОО «Платформа-А»' });
  const WAITING = makeChatCandidate({ askedAtMs: NOW - 10, awaitingAnswer: true });

  it('confirm при ещё не спрошенном кандидате: время вопроса и ожидание ответа', () => {
    const state = deepFreeze(makeState({ candidate: UNASKED }));

    expect(afterReplySent(state, 'confirm', 'Подскажите, вы из какой сферы?', NOW)).toEqual({
      ...state,
      candidate: { ...UNASKED, askedAtMs: NOW, awaitingAnswer: true },
    });
  });

  it.each([
    ['кавычки и регистр другие', 'Вы из компании "платформа-а", правильно?'],
    ['без формы собственности, с городом', 'Платформа А, Алматы, верно?'],
    ['название посреди фразы со знаками', 'Скажите, вы из Платформа-А? Всё верно?'],
  ])(
    'модель не отметила вопрос, но название кандидата в вопросе (%s): вопрос засчитан, ждём ответа',
    (_label, text) => {
      const state = makeState({ candidate: UNASKED });

      expect(afterReplySent(state, 'none', text, NOW).candidate).toEqual({
        ...UNASKED,
        askedAtMs: NOW,
        awaitingAnswer: true,
      });
    },
  );

  it('название кандидата только упомянуто, вопрос о другом: время вопроса есть, ответа не ждём', () => {
    const candidate = makeChatCandidate({ name: 'ТОО «Склад»' });
    const state = deepFreeze(makeState({ candidate }));

    const next = afterReplySent(
      state,
      'none',
      'Ридер стоит на входе в склад. Как у вас сейчас?',
      NOW,
    );

    expect(next).toEqual({ ...state, candidate: { ...candidate, askedAtMs: NOW } });
  });

  it('короткое название-слово в вопросе о другом: только время вопроса', () => {
    const state = makeState({ candidate: makeChatCandidate({ name: 'RFID' }) });

    expect(
      afterReplySent(state, 'none', 'Как вы сейчас ведёте учёт без RFID?', NOW).candidate,
    ).toMatchObject({ askedAtMs: NOW, awaitingAnswer: false });
  });

  it('модель отметила confirm: ждём ответа, даже если название только упомянуто', () => {
    const state = makeState({ candidate: makeChatCandidate({ name: 'ТОО «Склад»' }) });

    expect(
      afterReplySent(state, 'confirm', 'Ридер стоит на входе в склад.', NOW).candidate,
    ).toMatchObject({ askedAtMs: NOW, awaitingAnswer: true });
  });

  it('название кандидата только частью слова: не вопрос', () => {
    const state = makeState({ candidate: makeChatCandidate({ name: 'Альфа' }) });

    expect(afterReplySent(state, 'none', 'Работаем с компанией Альфатех', NOW)).toBe(state);
  });

  it('название из одних форм собственности ни с чем не совпадает', () => {
    const state = makeState({ candidate: makeChatCandidate({ name: 'ТОО' }) });

    expect(afterReplySent(state, 'none', 'ТОО', NOW)).toBe(state);
  });

  it.each(['none', 'name', 'confirm'] as const)(
    'кандидат ждал ответа, ушёл ответ %s: ожидание снято, вопрос больше не задаётся',
    (question) => {
      const state = makeState({ candidate: WAITING });

      expect(afterReplySent(state, question, 'Платформа-А, верно?', NOW).candidate).toEqual({
        ...WAITING,
        awaitingAnswer: false,
      });
    },
  );

  it('name: время вопроса о названии', () => {
    const state = deepFreeze(makeState());

    expect(afterReplySent(state, 'name', 'Из какой вы компании?', NOW)).toEqual({
      ...state,
      nameAskedAtMs: NOW,
    });
  });

  it('name при ждущем кандидате: ожидание снято и время вопроса о названии записано', () => {
    const state = makeState({ candidate: WAITING });

    expect(afterReplySent(state, 'name', 'Из какой вы компании?', NOW)).toMatchObject({
      candidate: { awaitingAnswer: false },
      nameAskedAtMs: NOW,
    });
  });

  it('модель не отметила вопрос о названии: ничего не угадываем', () => {
    const state = makeState();

    expect(afterReplySent(state, 'none', 'Из какой вы компании?', NOW)).toBe(state);
  });

  it('ничего не изменилось: то же состояние', () => {
    const asked = makeState({ candidate: makeChatCandidate({ askedAtMs: NOW - 10 }) });
    const noCandidate = makeState();

    expect(afterReplySent(asked, 'confirm', 'Платформа-А', NOW)).toBe(asked);
    expect(afterReplySent(noCandidate, 'confirm', 'Платформа-А', NOW)).toBe(noCandidate);
  });
});

describe('markCandidateAsked', () => {
  it('ещё не спрошенный кандидат, вопрос: время вопроса и ожидание ответа', () => {
    const state = deepFreeze(makeState({ candidate: makeChatCandidate() }));

    expect(markCandidateAsked(state, NOW, true).candidate).toEqual({
      ...makeChatCandidate(),
      askedAtMs: NOW,
      awaitingAnswer: true,
    });
  });

  it('ещё не спрошенный кандидат, только упоминание: время вопроса без ожидания', () => {
    const state = deepFreeze(makeState({ candidate: makeChatCandidate() }));

    expect(markCandidateAsked(state, NOW, false).candidate).toEqual({
      ...makeChatCandidate(),
      askedAtMs: NOW,
      awaitingAnswer: false,
    });
  });

  it('уже спрошенный кандидат не меняется: вопрос задаётся один раз', () => {
    const state = makeState({
      candidate: makeChatCandidate({ askedAtMs: NOW - 10, awaitingAnswer: false }),
    });

    expect(markCandidateAsked(state, NOW, true)).toBe(state);
  });

  it('кандидата нет: состояние то же', () => {
    const state = makeState();

    expect(markCandidateAsked(state, NOW, true)).toBe(state);
  });
});

describe('stopAwaiting', () => {
  it('ожидание ответа снимается, время вопроса остаётся', () => {
    const state = deepFreeze(
      makeState({ candidate: makeChatCandidate({ askedAtMs: NOW - 10, awaitingAnswer: true }) }),
    );

    expect(stopAwaiting(state).candidate).toEqual({
      ...makeChatCandidate(),
      askedAtMs: NOW - 10,
      awaitingAnswer: false,
    });
  });

  it('кандидата нет или ответа никто не ждёт: состояние то же', () => {
    const empty = makeState();
    const notWaiting = makeState({ candidate: makeChatCandidate({ askedAtMs: NOW }) });

    expect(stopAwaiting(empty)).toBe(empty);
    expect(stopAwaiting(notWaiting)).toBe(notWaiting);
  });
});

describe('markNameAsked', () => {
  it('бот спросил название: время записывается', () => {
    const state = deepFreeze(makeState());

    expect(markNameAsked(state, NOW)).toEqual({ ...state, nameAskedAtMs: NOW });
  });

  it('второй вопрос не записывается: время первого остаётся', () => {
    const state = makeState({ nameAskedAtMs: NOW - 10 });

    expect(markNameAsked(state, NOW)).toBe(state);
  });
});

describe('withProfile', () => {
  it('бизнес-аккаунт: вид business и домен из сайта', () => {
    const state = deepFreeze(makeState());

    expect(
      withProfile(state, {
        kind: 'business',
        websites: ['https://www.sklad.kz/about'],
        email: null,
      }),
    ).toEqual({ ...state, profileKind: 'business', profileDomain: 'sklad.kz', profileRequests: 1 });
  });

  it('каждый запрос профиля считается: после сбоя запрос повторяют, но не бесконечно', () => {
    const state = makeState({ profileKind: 'unknown', profileRequests: 2 });

    expect(withProfile(state, { kind: 'failed' })).toMatchObject({
      profileKind: 'unknown',
      profileRequests: 3,
    });
  });

  it('бизнес-аккаунт без подходящего домена: домен null', () => {
    const next = withProfile(makeState(), {
      kind: 'business',
      websites: ['instagram.com/a'],
      email: 'shop@gmail.com',
    });

    expect(next).toMatchObject({ profileKind: 'business', profileDomain: null });
  });

  it('обычный аккаунт: вид personal, домена нет', () => {
    expect(withProfile(makeState(), { kind: 'personal' })).toMatchObject({
      profileKind: 'personal',
      profileDomain: null,
    });
  });

  it('запрос профиля не удался: вид unknown, домена нет', () => {
    expect(withProfile(makeState(), { kind: 'failed' })).toMatchObject({
      profileKind: 'unknown',
      profileDomain: null,
    });
  });
});

describe('withBrief', () => {
  it('справка и время её получения записываются в подтверждённую компанию', () => {
    const brief = makeBrief();
    const state = deepFreeze(makeState({ confirmed: makeConfirmed() }));

    expect(withBrief(state, brief, NOW + 7).confirmed).toEqual({
      ...makeConfirmed(),
      brief,
      briefAtMs: NOW + 7,
    });
  });

  it('подтверждённой компании нет: состояние то же', () => {
    const state = makeState();

    expect(withBrief(state, makeBrief(), NOW)).toBe(state);
  });
});

describe('withStatedCompany', () => {
  const mention = (name: string | null, city: string | null) => ({
    name,
    city,
    answer: 'none' as const,
    pains: [],
  });

  it('название и город со слов клиента записываются', () => {
    const state = deepFreeze(makeState());

    expect(withStatedCompany(state, mention('Платформа-А', 'Алматы'))).toEqual({
      ...state,
      statedName: 'Платформа-А',
      statedCity: 'Алматы',
    });
  });

  it('пробелы по краям убираются, название обрезается до 200 знаков, город до 100', () => {
    const next = withStatedCompany(
      makeState(),
      mention(` ${'Н'.repeat(300)} `, ` ${'Г'.repeat(150)}\n`),
    );

    expect(next.statedName).toBe('Н'.repeat(200));
    expect(next.statedCity).toBe('Г'.repeat(100));
  });

  it('пустое или отсутствующее значение прежнее не стирает', () => {
    const state = makeState({ statedName: 'Старое', statedCity: 'Астана' });

    expect(withStatedCompany(state, mention(null, null))).toEqual(state);
    expect(withStatedCompany(state, mention('   ', ''))).toEqual(state);
  });

  it('новое название заменяет старое, город остаётся прежним, если новый не назван', () => {
    const state = makeState({ statedName: 'Старое', statedCity: 'Астана' });

    expect(withStatedCompany(state, mention('Новое', null))).toMatchObject({
      statedName: 'Новое',
      statedCity: 'Астана',
    });
  });

  it('ничего нового: возвращается то же состояние', () => {
    const state = makeState({ statedName: 'Старое' });

    expect(withStatedCompany(state, mention(null, null))).toBe(state);
  });
});
