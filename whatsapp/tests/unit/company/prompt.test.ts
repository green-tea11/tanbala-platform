import { describe, expect, it } from 'vitest';
import { buildPrompt, OFF_PROMPT } from '../../../src/company/prompt.js';
import { buildOffSummary, buildSummary } from '../../../src/company/summary.js';
import type { CandidateSource, CompanyPain } from '../../../src/domain/company.js';
import {
  companyIdOf,
  deepFreeze,
  jobIdOf,
  makeBrief,
  makeChatCandidate,
  makeConfirmed,
  makeState,
  NOW,
} from './builders.js';

const RUNNING = {
  status: 'running',
  jobId: jobIdOf('job-1'),
  startedAtMs: NOW,
  checkedAtMs: NOW,
} as const;

/** Бесплатные шаги а, б, в пройдены. */
const STEPS_DONE = { freeStepsAtMs: NOW - 1000 } as const;

describe('buildPrompt: компания неизвестна', () => {
  it('OFF_PROMPT: функция выключена', () => {
    expect(OFF_PROMPT).toEqual({ kind: 'off' });
  });

  it('чистое состояние: бесплатные шаги ещё не пройдены, название не спрашивать', () => {
    expect(buildPrompt(makeState())).toEqual({ kind: 'unknown', askName: false });
  });

  it.each([
    ['обычный аккаунт', 'personal'],
    ['профиль не получен', 'unknown'],
    ['профиль не запрашивался', null],
  ] as const)('шаги пройдены, %s: можно один раз спросить название', (_label, profileKind) => {
    expect(buildPrompt(makeState({ ...STEPS_DONE, profileKind }))).toEqual({
      kind: 'unknown',
      askName: true,
    });
  });

  it('бизнес-аккаунт, шаги пройдены, логотип ещё не проверен: сначала шаг д, название не спрашивать', () => {
    expect(buildPrompt(makeState({ ...STEPS_DONE, profileKind: 'business' }))).toEqual({
      kind: 'unknown',
      askName: false,
    });
  });

  it('бизнес-аккаунт, шаги пройдены и логотип проверен: можно спросить название', () => {
    const state = makeState({ ...STEPS_DONE, profileKind: 'business', logoCheckedAtMs: NOW });

    expect(buildPrompt(state)).toEqual({ kind: 'unknown', askName: true });
  });

  it('название уже спрашивали: не спрашивать', () => {
    expect(buildPrompt(makeState({ ...STEPS_DONE, nameAskedAtMs: NOW }))).toEqual({
      kind: 'unknown',
      askName: false,
    });
  });

  it('клиент сам назвал компанию: не спрашивать', () => {
    expect(buildPrompt(makeState({ ...STEPS_DONE, statedName: 'Платформа-А' }))).toEqual({
      kind: 'unknown',
      askName: false,
    });
  });

  it.each([
    ['проверка завершена', { status: 'done', companyId: companyIdOf(8), finishedAtMs: NOW }],
    ['проверка не удалась', { status: 'failed', reason: 'not_in_2gis', finishedAtMs: NOW }],
  ] as const)('%s, кандидата нет: снова unknown', (_label, research) => {
    expect(buildPrompt(makeState({ ...STEPS_DONE, research }))).toEqual({
      kind: 'unknown',
      askName: true,
    });
  });

  it.each(['queued', 'running'] as const)(
    'проверка %s: идёт поиск, название не спрашивать',
    (status) => {
      expect(buildPrompt(makeState({ research: { ...RUNNING, status } }))).toEqual({
        kind: 'searching',
      });
    },
  );
});

describe('buildPrompt: официальное название (решение владельца 30.10.2026)', () => {
  const NOT_IN_2GIS = { status: 'failed', reason: 'not_in_2gis', finishedAtMs: NOW } as const;
  const named = { ...STEPS_DONE, statedName: 'Тинькофф', nameAskedAtMs: NOW - 5000 } as const;

  it('проверка по названию клиента не нашла компанию в 2ГИС: один раз спросить официальное название', () => {
    expect(buildPrompt(makeState({ ...named, research: NOT_IN_2GIS }))).toEqual({
      kind: 'ask_official',
    });
  });

  it('проверка нашла не ту компанию (клиент от неё отказался): спросить официальное название', () => {
    const research = { status: 'done', companyId: companyIdOf(51), finishedAtMs: NOW } as const;

    expect(buildPrompt(makeState({ ...named, research, rejectedIds: [companyIdOf(51)] }))).toEqual({
      kind: 'ask_official',
    });
  });

  it('официальное название уже спрашивали, а компании нет: больше о компании не спрашивать', () => {
    expect(
      buildPrompt(
        makeState({ ...named, research: NOT_IN_2GIS, officialNameAskedAtMs: NOW - 1000 }),
      ),
    ).toEqual({ kind: 'not_found' });
  });

  it('вторая проверка не удалась по другой причине: тоже больше не спрашивать', () => {
    const research = { status: 'failed', reason: 'rate_limited', finishedAtMs: NOW } as const;

    expect(
      buildPrompt(makeState({ ...named, research, officialNameAskedAtMs: NOW - 1000 })),
    ).toEqual({ kind: 'not_found' });
  });

  it('вторая проверка идёт: поиск, а не вопрос', () => {
    expect(
      buildPrompt(makeState({ ...named, research: RUNNING, officialNameAskedAtMs: NOW - 1000 })),
    ).toEqual({ kind: 'searching' });
  });

  it.each([
    ['дневной предел проверок', 'rate_limited'],
    ['сбой проекта B', 'error'],
    ['город не поддерживается', 'city_unsupported'],
  ] as const)(
    'проверка не удалась (%s): официальное название не спрашивается',
    (_label, reason) => {
      const research = { status: 'failed', reason, finishedAtMs: NOW } as const;

      expect(buildPrompt(makeState({ ...named, research }))).toEqual({
        kind: 'unknown',
        askName: false,
      });
    },
  );
});

describe('buildPrompt: кандидат', () => {
  it.each<[CandidateSource, boolean]>([
    ['message', true],
    ['research', true],
    ['profile_domain', false],
    ['phone', false],
    ['profile_name', false],
    ['logo', false],
  ])('кандидат из источника %s, ещё не спрошен: withCity %s', (source, withCity) => {
    const state = makeState({ candidate: makeChatCandidate({ source }) });

    expect(buildPrompt(state)).toEqual({
      kind: 'candidate',
      name: 'Платформа-А',
      city: 'Алматы',
      withCity,
    });
  });

  it('город кандидата может быть пустым', () => {
    const state = makeState({ candidate: makeChatCandidate({ city: null, source: 'message' }) });

    expect(buildPrompt(state)).toMatchObject({ kind: 'candidate', city: null, withCity: true });
  });

  it.each([true, false])(
    'кандидат спрошен (ожидание ответа %s): asked с тем же признаком ожидания',
    (awaitingAnswer) => {
      const state = makeState({
        candidate: makeChatCandidate({ askedAtMs: NOW, awaitingAnswer, source: 'message' }),
      });

      expect(buildPrompt(state)).toEqual({
        kind: 'asked',
        name: 'Платформа-А',
        city: 'Алматы',
        awaitingAnswer,
      });
    },
  );

  it('кандидат важнее идущей проверки', () => {
    const state = makeState({ candidate: makeChatCandidate(), research: RUNNING });

    expect(buildPrompt(state).kind).toBe('candidate');
  });
});

describe('buildPrompt: подтверждённая компания', () => {
  it('со справкой: имя, рубрика, боли без цифр и не больше двух, писали ли на почту', () => {
    const pains: CompanyPain[] = [
      { pain: 'Остатки в 1С не совпадают', evidence: 'цитата', source: 'site' },
      { pain: 'Долгая инвентаризация', evidence: 'цитата', source: '2gis' },
      { pain: 'Пересорт при приёмке', evidence: null, source: null },
      { pain: 'Потери на складе', evidence: null, source: null },
    ];
    const state = deepFreeze(
      makeState({
        confirmed: makeConfirmed({
          brief: makeBrief({ pains, rubric: 'Складское хранение', emailed: true }),
          briefAtMs: NOW,
        }),
      }),
    );

    expect(buildPrompt(state)).toEqual({
      kind: 'confirmed',
      name: 'Платформа-А',
      rubric: 'Складское хранение',
      pains: ['Долгая инвентаризация', 'Пересорт при приёмке'],
      emailed: true,
    });
  });

  it('без справки: боли пустые, рубрики нет, на почту не писали', () => {
    const state = makeState({ confirmed: makeConfirmed() });

    expect(buildPrompt(state)).toEqual({
      kind: 'confirmed',
      name: 'Платформа-А',
      rubric: null,
      pains: [],
      emailed: false,
    });
  });

  it.each(['Склады от 1000 м²', 'Склад №2', 'Хранение ½ паллеты'])(
    'рубрика с цифрами (%s) в промпт не идёт, как и боли с цифрами',
    (rubric) => {
      const state = makeState({
        confirmed: makeConfirmed({ brief: makeBrief({ rubric }), briefAtMs: NOW }),
      });

      expect(buildPrompt(state)).toMatchObject({ kind: 'confirmed', rubric: null });
    },
  );

  it('рубрика с цифрами в сводке для менеджера остаётся', () => {
    const state = makeState({
      confirmed: makeConfirmed({ brief: makeBrief({ rubric: 'Склад №2' }), briefAtMs: NOW }),
    });

    expect(buildSummary(state, null).rubric).toBe('Склад №2');
  });

  it('в промпт не попадают цитата, источник и цифры справки', () => {
    const state = makeState({
      confirmed: makeConfirmed({ brief: makeBrief(), briefAtMs: NOW }),
    });

    const text = JSON.stringify(buildPrompt(state));

    expect(text).not.toContain('11 000');
    expect(text).not.toContain('site');
    expect(text).not.toContain('evidence');
  });

  it('подтверждённая компания важнее кандидата и проверки', () => {
    const state = makeState({
      confirmed: makeConfirmed(),
      candidate: makeChatCandidate(),
      research: RUNNING,
    });

    expect(buildPrompt(state).kind).toBe('confirmed');
  });
});

describe('buildSummary', () => {
  const URL = 'http://127.0.0.1:8000';

  it('компания не определена: unknown, слова клиента и проверка видны менеджеру', () => {
    const state = makeState({
      statedName: 'Платформа-А',
      confirmedPains: ['Пересорт'],
      research: RUNNING,
    });

    expect(buildSummary(state, URL)).toEqual({
      status: 'unknown',
      companyId: null,
      name: null,
      city: null,
      rubric: null,
      candidateSource: null,
      cardUrl: null,
      confirmedPains: ['Пересорт'],
      briefPains: [],
      emailed: null,
      research: RUNNING,
      statedName: 'Платформа-А',
    });
  });

  it('кандидат: найден, клиент не подтвердил; ссылка на карточку есть', () => {
    const state = makeState({ candidate: makeChatCandidate({ source: 'phone' }) });

    expect(buildSummary(state, URL)).toEqual({
      status: 'candidate',
      companyId: companyIdOf(8),
      name: 'Платформа-А',
      city: 'Алматы',
      rubric: null,
      candidateSource: 'phone',
      cardUrl: 'http://127.0.0.1:8000/companies/8',
      confirmedPains: [],
      briefPains: [],
      emailed: null,
      research: null,
      statedName: null,
    });
  });

  it('подтверждённая компания со справкой: рубрика, боли с цитатой, «писали ли», источник кандидата не нужен', () => {
    const brief = makeBrief({ emailed: true });
    const state = makeState({
      confirmed: makeConfirmed({ brief, briefAtMs: NOW }),
      confirmedPains: ['Пересорт'],
    });

    expect(buildSummary(state, URL)).toEqual({
      status: 'confirmed',
      companyId: companyIdOf(8),
      name: 'Платформа-А',
      city: 'Алматы',
      rubric: 'Складское хранение',
      candidateSource: null,
      cardUrl: 'http://127.0.0.1:8000/companies/8',
      confirmedPains: ['Пересорт'],
      briefPains: brief.pains,
      emailed: true,
      research: null,
      statedName: null,
    });
  });

  it('подтверждённая компания без справки: боли справки пусты, «писали ли» неизвестно', () => {
    const summary = buildSummary(makeState({ confirmed: makeConfirmed() }), URL);

    expect(summary).toMatchObject({
      status: 'confirmed',
      rubric: null,
      briefPains: [],
      emailed: null,
    });
  });

  it('подтверждённая компания важнее кандидата', () => {
    const state = makeState({
      confirmed: makeConfirmed({ id: companyIdOf(9) }),
      candidate: makeChatCandidate({ id: companyIdOf(8) }),
    });

    expect(buildSummary(state, URL)).toMatchObject({ status: 'confirmed', companyId: 9 });
  });

  it.each([
    [null, null],
    ['', null],
    ['   ', null],
    ['http://127.0.0.1:8000', 'http://127.0.0.1:8000/companies/8'],
    ['http://127.0.0.1:8000/', 'http://127.0.0.1:8000/companies/8'],
    ['https://mail.example.kz/ui//', 'https://mail.example.kz/ui/companies/8'],
  ])('адрес интерфейса «%s»: ссылка %s', (emailUiUrl, cardUrl) => {
    const state = makeState({ candidate: makeChatCandidate() });

    expect(buildSummary(state, emailUiUrl).cardUrl).toBe(cardUrl);
  });

  it('у неопределённой компании ссылки нет и при заданном адресе', () => {
    expect(buildSummary(makeState(), URL).cardUrl).toBeNull();
  });
});

describe('buildOffSummary', () => {
  it('функция выключена: статус off, о компании ничего, боли клиента остаются', () => {
    const state = makeState({
      candidate: makeChatCandidate(),
      confirmed: makeConfirmed(),
      statedName: 'Платформа-А',
      research: RUNNING,
      confirmedPains: ['Пересорт', 'Долгая инвентаризация'],
    });

    expect(buildOffSummary(state)).toEqual({
      status: 'off',
      companyId: null,
      name: null,
      city: null,
      rubric: null,
      candidateSource: null,
      cardUrl: null,
      confirmedPains: ['Пересорт', 'Долгая инвентаризация'],
      briefPains: [],
      emailed: null,
      research: null,
      statedName: null,
    });
  });
});
