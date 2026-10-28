import { describe, expect, it } from 'vitest';
import type { CompanyApiFailure } from '../../../src/domain/company.js';
import type { BusinessProfileResult } from '../../../src/domain/ports.js';
import { loggedText, makeChat } from '../handoff/fakes.js';
import {
  companyIdOf,
  makeCandidate,
  makeChatCandidate,
  makeConfirmed,
  makeState,
  NOW,
} from './builders.js';
import { createHarness, fail, lookupBy, makeMessage, ok } from './fakes.js';

// Порядок и остановка бесплатных шагов, сбои API и повтор на следующей пачке.

const SITE: BusinessProfileResult = {
  kind: 'business',
  websites: ['https://sklad.kz'],
  email: null,
};

const FOUND = ok([makeCandidate()]);
const NAMED = [makeMessage({ verifiedName: 'Платформа-А' })];

describe('prepare: порядок и остановка шагов', () => {
  it('шаги идут по порядку а, б, в; ничего не найдено: шаги пройдены, компания неизвестна', async () => {
    const h = createHarness({ contacts: { profile: SITE } });

    const turn = await h.service.prepare(makeChat(), NAMED);

    expect(h.directory.lookups()).toEqual([
      { by: 'domain', domain: 'sklad.kz' },
      { by: 'phone', phone: '77000000001' },
      { by: 'name', name: 'Платформа-А' },
    ]);
    expect(turn).toEqual({ prompt: { kind: 'unknown', askName: true }, awaitingAnswer: false });
    expect(h.repo.current().freeStepsAtMs).toBe(NOW);
  });

  it('останавливается на первом найденном кандидате: после домена номер и имя не запрашиваются', async () => {
    const h = createHarness({
      contacts: { profile: SITE },
      directory: {
        lookup: lookupBy({ domain: FOUND, phone: ok([makeCandidate({ id: companyIdOf(9) })]) }),
      },
    });

    await h.service.prepare(makeChat(), NAMED);

    expect(h.directory.lookups()).toEqual([{ by: 'domain', domain: 'sklad.kz' }]);
    expect(h.repo.current().candidate).toMatchObject({ id: 8, source: 'profile_domain' });
    expect(h.repo.current().freeStepsAtMs).toBeNull();
  });

  it('домен ничего не нашёл, номер нашёл: имя не запрашивается, источник phone', async () => {
    const h = createHarness({
      contacts: { profile: SITE },
      directory: { lookup: lookupBy({ phone: FOUND }) },
    });

    await h.service.prepare(makeChat(), NAMED);

    expect(h.directory.lookups().map((query) => query.by)).toEqual(['domain', 'phone']);
    expect(h.repo.current().candidate).toMatchObject({ source: 'phone' });
  });

  it('домен и номер ничего не нашли, имя нашло: источник profile_name', async () => {
    const h = createHarness({
      contacts: { profile: SITE },
      directory: {
        lookup: lookupBy({ name: ok([makeCandidate({ matchBy: 'name', matchScore: 0.9 })]) }),
      },
    });

    await h.service.prepare(makeChat(), NAMED);

    expect(h.directory.lookups().map((query) => query.by)).toEqual(['domain', 'phone', 'name']);
    expect(h.repo.current().candidate).toMatchObject({ source: 'profile_name' });
  });

  it('после отказа клиента шаги идут снова: профиль WhatsApp не запрашивается, отклонённая компания не предлагается', async () => {
    const h = createHarness({
      contacts: { profile: SITE },
      state: makeState({
        profileKind: 'business',
        profileDomain: 'sklad.kz',
        rejectedIds: [companyIdOf(8)],
      }),
      directory: {
        lookup: lookupBy({
          domain: ok([makeCandidate({ id: companyIdOf(8) })]),
          phone: ok([makeCandidate({ id: companyIdOf(9), name: 'Бета', matchBy: 'phone' })]),
        }),
      },
    });

    const turn = await h.service.prepare(makeChat(), NAMED);

    expect(h.contacts.calls).toEqual([]);
    expect(h.directory.lookups().map((query) => query.by)).toEqual(['domain', 'phone']);
    expect(turn.prompt).toMatchObject({ kind: 'candidate', name: 'Бета' });
    expect(h.repo.current().candidate).toMatchObject({ id: 9, source: 'phone' });
  });

  it('шаги проходятся один раз на чат: второй prepare ничего не запрашивает и не пишет', async () => {
    const h = createHarness({ contacts: { profile: SITE } });
    await h.service.prepare(makeChat(), NAMED);
    const callsBefore = h.directory.calls.length;
    const savesBefore = h.repo.saves.length;

    const turn = await h.service.prepare(makeChat(), NAMED);

    expect(h.directory.calls).toHaveLength(callsBefore);
    expect(h.contacts.calls).toHaveLength(1);
    expect(h.repo.saves).toHaveLength(savesBefore);
    expect(turn.prompt).toEqual({ kind: 'unknown', askName: true });
  });

  it('кандидат уже есть: шаги не идут и ничего не запрашивается', async () => {
    const h = createHarness({
      contacts: { profile: SITE },
      state: makeState({ candidate: makeChatCandidate({ source: 'message' }) }),
    });

    const turn = await h.service.prepare(makeChat(), NAMED);

    expect(h.directory.calls).toEqual([]);
    expect(h.contacts.calls).toEqual([]);
    expect(turn.prompt).toMatchObject({ kind: 'candidate', withCity: true });
    expect(h.repo.saves).toEqual([]);
  });

  it('подтверждённая компания уже есть: поисковые шаги не идут', async () => {
    const h = createHarness({
      contacts: { profile: SITE },
      state: makeState({ confirmed: makeConfirmed({ brief: null }) }),
      directory: { brief: () => fail('unavailable') },
    });

    await h.service.prepare(makeChat(), NAMED);

    expect(h.directory.lookups()).toEqual([]);
    expect(h.contacts.calls).toEqual([]);
  });

  it('шаги уже пройдены (freeStepsAtMs стоит): не повторяются', async () => {
    const h = createHarness({ state: makeState({ freeStepsAtMs: NOW - 1000 }) });

    await h.service.prepare(makeChat(), NAMED);

    expect(h.directory.calls).toEqual([]);
    expect(h.contacts.calls).toEqual([]);
  });

  it('кандидата ждёт ответа: prepare сообщает об этом и ничего не запрашивает', async () => {
    const h = createHarness({
      state: makeState({
        candidate: makeChatCandidate({ askedAtMs: NOW - 1000, awaitingAnswer: true }),
      }),
    });

    const turn = await h.service.prepare(makeChat(), []);

    expect(turn).toEqual({
      prompt: { kind: 'asked', name: 'Платформа-А', city: 'Алматы' },
      awaitingAnswer: true,
    });
    expect(h.directory.calls).toEqual([]);
  });

  it('спрошенный кандидат без ожидания ответа: awaitingAnswer false', async () => {
    const h = createHarness({
      state: makeState({ candidate: makeChatCandidate({ askedAtMs: NOW - 1000 }) }),
    });

    const turn = await h.service.prepare(makeChat(), []);

    expect(turn.awaitingAnswer).toBe(false);
  });
});

describe('prepare: выбор кандидата из ответа lookup', () => {
  it('неоднозначный ответ по названию (два близких совпадения): кандидата нет, шаг пройден', async () => {
    const h = createHarness({
      directory: {
        lookup: lookupBy({
          name: ok([
            makeCandidate({ id: companyIdOf(1), matchBy: 'name', matchScore: 0.9 }),
            makeCandidate({ id: companyIdOf(2), matchBy: 'name', matchScore: 0.85 }),
          ]),
        }),
      },
    });

    const turn = await h.service.prepare(makeChat(), NAMED);

    expect(turn.prompt).toEqual({ kind: 'unknown', askName: true });
    expect(h.repo.current()).toMatchObject({ candidate: null, freeStepsAtMs: NOW });
  });

  it('совпадение по названию с оценкой ниже 0.8: кандидата нет', async () => {
    const h = createHarness({
      directory: {
        lookup: lookupBy({ name: ok([makeCandidate({ matchBy: 'name', matchScore: 0.7 })]) }),
      },
    });

    await h.service.prepare(makeChat(), NAMED);

    expect(h.repo.current().candidate).toBeNull();
  });

  it('из нескольких кандидатов выбирается лучший по оценке', async () => {
    const h = createHarness({
      directory: {
        lookup: lookupBy({
          name: ok([
            makeCandidate({
              id: companyIdOf(2),
              name: 'Слабый',
              matchBy: 'name',
              matchScore: 0.65,
            }),
            makeCandidate({ id: companyIdOf(1), name: 'Лучший', matchBy: 'name', matchScore: 0.9 }),
          ]),
        }),
      },
    });

    const turn = await h.service.prepare(makeChat(), NAMED);

    expect(turn.prompt).toMatchObject({ kind: 'candidate', name: 'Лучший' });
  });
});

describe('prepare: API недоступен и другие сбои', () => {
  it('недоступный API: промпт без данных о компании, исключения нет, шаги не засчитаны', async () => {
    const h = createHarness({
      contacts: { profile: SITE },
      directory: { lookup: () => fail('unavailable') },
    });

    const turn = await h.service.prepare(makeChat(), NAMED);

    expect(turn).toEqual({ prompt: { kind: 'unknown', askName: true }, awaitingAnswer: false });
    expect(h.repo.current()).toMatchObject({ freeStepsAtMs: null, candidate: null });
    expect(h.directory.lookups().map((query) => query.by)).toEqual(['domain', 'phone', 'name']);
  });

  it('следующая пачка повторяет поиск; профиль WhatsApp второй раз не запрашивается', async () => {
    let available = false;
    const h = createHarness({
      contacts: { profile: SITE },
      directory: {
        lookup: (query) => (available ? lookupBy({ phone: FOUND })(query) : fail('unavailable')),
      },
    });
    await h.service.prepare(makeChat(), NAMED);
    available = true;

    const turn = await h.service.prepare(makeChat(), NAMED);

    expect(h.contacts.count('businessProfile')).toBe(1);
    expect(h.directory.lookups().map((query) => query.by)).toEqual([
      'domain',
      'phone',
      'name',
      'domain',
      'phone',
    ]);
    expect(turn.prompt).toMatchObject({ kind: 'candidate', name: 'Платформа-А' });
    expect(h.repo.current().candidate).toMatchObject({ source: 'phone' });
  });

  it('недоступность на одном шаге достаточно: остальные шаги проходят, но шаги не засчитаны', async () => {
    const h = createHarness({
      contacts: { profile: SITE },
      directory: {
        lookup: (query) => (query.by === 'phone' ? fail('unavailable') : ok([])),
      },
    });

    await h.service.prepare(makeChat(), NAMED);

    expect(h.directory.lookups()).toHaveLength(3);
    expect(h.repo.current().freeStepsAtMs).toBeNull();
  });

  it('когда API снова отвечает и ничего не находит, шаги засчитываются', async () => {
    let available = false;
    const h = createHarness({
      contacts: { profile: SITE },
      directory: { lookup: () => (available ? ok([]) : fail('unavailable')) },
    });
    await h.service.prepare(makeChat(), NAMED);
    available = true;

    await h.service.prepare(makeChat(), NAMED);

    expect(h.repo.current().freeStepsAtMs).toBe(NOW);
  });

  it.each<CompanyApiFailure>([
    'bad_request',
    'unauthorized',
    'not_found',
    'rate_limited',
    'budget_exhausted',
    'invalid_response',
  ])('сбой %s считается пройденным шагом: повтора на следующей пачке нет', async (failure) => {
    const h = createHarness({
      contacts: { profile: SITE },
      directory: { lookup: () => fail(failure) },
    });

    const turn = await h.service.prepare(makeChat(), NAMED);
    const callsAfterFirst = h.directory.calls.length;
    await h.service.prepare(makeChat(), NAMED);

    expect(turn.prompt).toEqual({ kind: 'unknown', askName: true });
    expect(h.repo.current().freeStepsAtMs).toBe(NOW);
    expect(h.directory.calls).toHaveLength(callsAfterFirst);
  });

  it('в лог попадают только ID чата, шаг и код сбоя: ни имён, ни домена, ни номера', async () => {
    const h = createHarness({
      contacts: {
        profile: { kind: 'business', websites: ['https://secret-domain.kz'], email: null },
      },
      directory: { lookup: () => fail('unavailable') },
    });

    await h.service.prepare(makeChat(), [makeMessage({ verifiedName: 'СЕКРЕТНОЕ-ИМЯ' })]);

    const warns = h.logs.filter((entry) => entry.level === 'warn');
    expect(warns.map((entry) => entry.context)).toEqual([
      { chatId: 12, step: 'profile_domain', failure: 'unavailable' },
      { chatId: 12, step: 'phone', failure: 'unavailable' },
      { chatId: 12, step: 'profile_name', failure: 'unavailable' },
    ]);
    const text = loggedText(h.logs);
    expect(text).not.toContain('secret-domain');
    expect(text).not.toContain('СЕКРЕТНОЕ');
    expect(text).not.toContain('77000000001');
  });

  it('сбой базы при чтении состояния пробрасывается как есть', async () => {
    const h = createHarness();
    const failure = new Error('база недоступна');
    h.repo.failNext('get', failure);

    await expect(h.service.prepare(makeChat(), [])).rejects.toBe(failure);
  });

  it('сбой базы при записи состояния пробрасывается как есть', async () => {
    const h = createHarness();
    const failure = new Error('база недоступна');
    h.repo.failNext('save', failure);

    await expect(h.service.prepare(makeChat(), [])).rejects.toBe(failure);
  });
});
