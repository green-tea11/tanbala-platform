import { describe, expect, it } from 'vitest';
import type { ChatCompanyState } from '../../../src/domain/company.js';
import type { LlmResult } from '../../../src/domain/types.js';
import { CLIENT_JID, loggedText, makeChat } from '../handoff/fakes.js';
import {
  CHAT_ID,
  companyIdOf,
  makeCandidate,
  makeChatCandidate,
  makeConfirmed,
  makeState,
  MINUTE_MS,
  NOW,
} from './builders.js';
import { createHarness, fail, lidChat, LID_JID, lookupBy, ok, PHOTO } from './fakes.js';

// identifyAfterReply, шаг д: название компании читается с фото профиля бизнес-аккаунта (один раз на чат).

function ready(overrides: Partial<ChatCompanyState> = {}): ChatCompanyState {
  return makeState({ profileKind: 'business', freeStepsAtMs: NOW - MINUTE_MS, ...overrides });
}

const FOUND = ok([makeCandidate({ matchBy: 'name', matchScore: 0.9 })]);
const READ = (name: string | null): LlmResult<string | null> => ({ ok: true, value: name });

describe('identifyAfterReply: шаг д, логотип на фото профиля', () => {
  it('бизнес-аккаунт: фото, чтение логотипа, поиск по названию, кандидат с источником logo', async () => {
    const h = createHarness({
      state: ready(),
      contacts: { photo: PHOTO },
      logo: READ('Платформа-А'),
      directory: { lookup: lookupBy({ name: FOUND }) },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.contacts.calls).toEqual([
      { method: 'profilePhoto', jid: CLIENT_JID, maxBytes: 1_000_000 },
    ]);
    expect(h.logo.calls).toEqual([{ chatId: CHAT_ID, photo: PHOTO }]);
    expect(h.directory.lookups()).toEqual([{ by: 'name', name: 'Платформа-А' }]);
    expect(h.repo.current()).toMatchObject({
      candidate: makeChatCandidate({ source: 'logo' }),
      logoCheckedAtMs: NOW,
    });
  });

  it('найденный по логотипу кандидат потом спрашивается без города', async () => {
    const h = createHarness({
      state: ready(),
      contacts: { photo: PHOTO },
      logo: READ('Платформа-А'),
      directory: { lookup: lookupBy({ name: FOUND }) },
    });

    await h.service.identifyAfterReply(makeChat());
    const turn = await h.service.prepare(makeChat(), []);

    expect(turn.prompt).toMatchObject({ kind: 'candidate', withCity: false });
  });

  it('отметка «логотип проверен» записывается до вызова модели: один раз на чат даже при сбое', async () => {
    const h = createHarness({
      state: ready(),
      contacts: { photo: PHOTO },
      logo: READ('Платформа-А'),
      directory: { lookup: lookupBy({ name: FOUND }) },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.events.indexOf('repo.save')).toBeLessThan(h.events.indexOf('logo.readLogo'));
    expect(h.repo.saves[0]?.logoCheckedAtMs).toBe(NOW);
    expect(h.repo.saves[0]?.candidate).toBeNull();
  });

  it('фото нет или оно скрыто: модель не вызывается, шаг отмечен', async () => {
    const h = createHarness({ state: ready(), contacts: { photo: null } });

    await h.service.identifyAfterReply(makeChat());

    expect(h.logo.calls).toEqual([]);
    expect(h.directory.calls).toEqual([]);
    expect(h.repo.current().logoCheckedAtMs).toBe(NOW);
  });

  it.each([null, '', '   '])(
    'модель не нашла название (%j): шаг отмечен, поиска нет',
    async (value) => {
      const h = createHarness({ state: ready(), contacts: { photo: PHOTO }, logo: READ(value) });

      await h.service.identifyAfterReply(makeChat());

      expect(h.directory.calls).toEqual([]);
      expect(h.repo.current()).toMatchObject({ candidate: null, logoCheckedAtMs: NOW });
    },
  );

  it('название из одних форм собственности: поиска нет, шаг отмечен', async () => {
    const h = createHarness({ state: ready(), contacts: { photo: PHOTO }, logo: READ('ТОО') });

    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.calls).toEqual([]);
    expect(h.repo.current().logoCheckedAtMs).toBe(NOW);
  });

  it('длинное название с логотипа обрезается до 200 знаков, пробелы по краям убираются', async () => {
    const h = createHarness({
      state: ready(),
      contacts: { photo: PHOTO },
      logo: READ(`  ${'Ж'.repeat(300)}  `),
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.lookups()).toEqual([{ by: 'name', name: 'Ж'.repeat(200) }]);
  });

  it.each<[string, LlmResult<string | null>]>([
    ['недоступна', { ok: false, failure: 'unavailable' }],
    ['отказ', { ok: false, failure: 'refusal' }],
    ['лимит вызовов', { ok: false, failure: 'budget_exceeded', scope: 'global' }],
    ['неверный формат', { ok: false, failure: 'invalid_output' }],
  ])('сбой модели (%s): без исключения, шаг отмечен, в логе только код', async (_label, answer) => {
    const h = createHarness({ state: ready(), contacts: { photo: PHOTO }, logo: answer });

    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.calls).toEqual([]);
    expect(h.repo.current()).toMatchObject({ candidate: null, logoCheckedAtMs: NOW });
    const warn = h.logs.filter((entry) => entry.level === 'warn');
    expect(warn).toHaveLength(1);
    expect(warn[0]?.context).toMatchObject({ chatId: 12, step: 'logo' });
    expect(JSON.stringify(warn[0]?.context)).not.toContain('Платформа');
  });

  it('название прочитано, но в проекте B такой компании нет: кандидата нет, шаг отмечен', async () => {
    const h = createHarness({
      state: ready(),
      contacts: { photo: PHOTO },
      logo: READ('Неизвестная'),
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.lookups()).toEqual([{ by: 'name', name: 'Неизвестная' }]);
    expect(h.repo.current()).toMatchObject({ candidate: null, logoCheckedAtMs: NOW });
  });

  it('поиск по названию с логотипа недоступен: шаг отмечен в любом случае, повтора нет', async () => {
    const h = createHarness({
      state: ready(),
      contacts: { photo: PHOTO },
      logo: READ('Платформа-А'),
      directory: { lookup: () => fail('unavailable') },
    });

    await h.service.identifyAfterReply(makeChat());
    await h.service.identifyAfterReply(makeChat());

    expect(h.logo.calls).toHaveLength(1);
    expect(h.repo.current().logoCheckedAtMs).toBe(NOW);
  });

  it('отклонённая раньше компания по логотипу не выбирается', async () => {
    const h = createHarness({
      state: ready({ rejectedIds: [companyIdOf(8)] }),
      contacts: { photo: PHOTO },
      logo: READ('Платформа-А'),
      directory: { lookup: lookupBy({ name: FOUND }) },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.repo.current().candidate).toBeNull();
  });

  it('один раз на чат: если логотип уже проверен, ничего не запрашивается', async () => {
    const h = createHarness({
      state: ready({ logoCheckedAtMs: NOW - 1000 }),
      contacts: { photo: PHOTO },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.contacts.calls).toEqual([]);
    expect(h.repo.saves).toEqual([]);
  });

  it.each([
    ['обычный аккаунт', { profileKind: 'personal' as const }],
    ['профиль не получен', { profileKind: 'unknown' as const }],
    ['профиль не запрашивался', { profileKind: null }],
  ])('%s: шаг д не идёт', async (_label, overrides) => {
    const h = createHarness({ state: ready(overrides), contacts: { photo: PHOTO } });

    await h.service.identifyAfterReply(makeChat());

    expect(h.contacts.calls).toEqual([]);
    expect(h.repo.saves).toEqual([]);
  });

  it('бесплатные шаги а, б, в ещё не пройдены (или API было недоступно): шаг д не идёт', async () => {
    const h = createHarness({ state: ready({ freeStepsAtMs: null }), contacts: { photo: PHOTO } });

    await h.service.identifyAfterReply(makeChat());

    expect(h.contacts.calls).toEqual([]);
    expect(h.repo.saves).toEqual([]);
  });

  it('клиент назвал компанию: логотип не смотрим, идёт шаг г', async () => {
    const h = createHarness({
      state: ready({ statedName: 'Платформа-А', lookedUpName: 'платформа а' }),
      contacts: { photo: PHOTO },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.contacts.calls).toEqual([]);
    expect(h.logo.calls).toEqual([]);
    expect(h.repo.current().logoCheckedAtMs).toBeNull();
  });

  it.each([
    ['кандидат уже есть', { candidate: makeChatCandidate({ source: 'phone' }) }],
    ['компания подтверждена', { confirmed: makeConfirmed() }],
  ])('%s: шаг д не идёт', async (_label, overrides) => {
    const h = createHarness({ state: ready(overrides), contacts: { photo: PHOTO } });

    await h.service.identifyAfterReply(makeChat());

    expect(h.contacts.calls).toEqual([]);
  });

  it('адрес для фото профиля: номер, иначе @lid', async () => {
    const withPn = createHarness({ state: ready(), contacts: { photo: null } });
    const lidOnly = createHarness({ state: ready(), contacts: { photo: null } });

    await withPn.service.identifyAfterReply(makeChat());
    await lidOnly.service.identifyAfterReply(lidChat());

    expect(withPn.contacts.calls[0]).toMatchObject({ jid: CLIENT_JID });
    expect(lidOnly.contacts.calls[0]).toMatchObject({ jid: LID_JID });
  });

  it('в лог не попадает название, прочитанное с логотипа', async () => {
    const h = createHarness({
      state: ready(),
      contacts: { photo: PHOTO },
      logo: READ('СЕКРЕТНЫЙ-ЛОГОТИП'),
      directory: { lookup: () => fail('unavailable') },
    });

    await h.service.identifyAfterReply(makeChat());

    expect(loggedText(h.logs)).not.toContain('СЕКРЕТНЫЙ');
  });
});
