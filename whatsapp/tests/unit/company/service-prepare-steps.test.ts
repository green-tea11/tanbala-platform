import { describe, expect, it } from 'vitest';
import type { BusinessProfileResult } from '../../../src/domain/ports.js';
import type { ChatIdentity } from '../../../src/domain/types.js';
import { CLIENT_JID, makeChat } from '../handoff/fakes.js';
import { companyIdOf, makeCandidate, makeChatCandidate, makeState, NOW } from './builders.js';
import { createHarness, LID_JID, lookupBy, makeMessage, ok } from './fakes.js';

// Шаги а, б и в: бизнес-профиль и домен, номер, имя профиля. Каждый ищет через lookup ровно по одному признаку.

const SITE: BusinessProfileResult = {
  kind: 'business',
  websites: ['https://www.sklad.kz/about'],
  email: null,
};

const FOUND = ok([makeCandidate()]);

describe('prepare: шаг а, бизнес-профиль и домен', () => {
  it('сайт из бизнес-профиля: поиск по домену, найденная компания становится кандидатом', async () => {
    const h = createHarness({
      contacts: { profile: SITE },
      directory: { lookup: lookupBy({ domain: FOUND }) },
    });

    const turn = await h.service.prepare(makeChat(), [makeMessage()]);

    expect(h.contacts.calls).toEqual([{ method: 'businessProfile', jid: CLIENT_JID }]);
    expect(h.directory.lookups()).toEqual([{ by: 'domain', domain: 'sklad.kz' }]);
    expect(turn).toEqual({
      prompt: { kind: 'candidate', name: 'Платформа-А', city: 'Алматы', withCity: false },
      awaitingAnswer: false,
    });
    expect(h.repo.current()).toEqual(
      makeState({
        profileKind: 'business',
        profileRequests: 1,
        profileDomain: 'sklad.kz',
        freeStepsAtMs: NOW,
        candidate: makeChatCandidate({ source: 'profile_domain' }),
      }),
    );
  });

  it('профиль сохраняется сразу, до поиска: сбой поиска не заставит спрашивать профиль снова', async () => {
    const h = createHarness({
      contacts: { profile: SITE },
      directory: {
        lookup: () => {
          throw new Error('поиск упал');
        },
      },
    });

    await expect(h.service.prepare(makeChat(), [])).rejects.toThrow('поиск упал');

    expect(h.repo.current()).toMatchObject({ profileKind: 'business', profileDomain: 'sklad.kz' });
    expect(h.events.indexOf('repo.save')).toBeLessThan(h.events.indexOf('directory.lookup:domain'));
  });

  it('сайт-соцсеть пропускается, берётся следующий сайт', async () => {
    const h = createHarness({
      contacts: {
        profile: {
          kind: 'business',
          websites: ['https://instagram.com/sklad_alfa', 'https://sklad.kz'],
          email: null,
        },
      },
    });

    await h.service.prepare(makeChat(), []);

    expect(h.directory.lookups()[0]).toEqual({ by: 'domain', domain: 'sklad.kz' });
  });

  it('почта на общем сервисе (gmail): домен не используется, по домену не ищем', async () => {
    const h = createHarness({
      contacts: { profile: { kind: 'business', websites: [], email: 'shop@gmail.com' } },
    });

    await h.service.prepare(makeChat(), []);

    expect(h.directory.lookups().map((query) => query.by)).toEqual(['phone']);
    expect(h.repo.current()).toMatchObject({ profileKind: 'business', profileDomain: null });
  });

  it('корпоративная почта без сайта: домен берётся из адреса', async () => {
    const h = createHarness({
      contacts: { profile: { kind: 'business', websites: [], email: 'Info@Sklad.KZ' } },
    });

    await h.service.prepare(makeChat(), []);

    expect(h.directory.lookups()[0]).toEqual({ by: 'domain', domain: 'sklad.kz' });
  });

  it('сайт важнее почты', async () => {
    const h = createHarness({
      contacts: {
        profile: { kind: 'business', websites: ['site.kz'], email: 'info@mail-corp.kz' },
      },
    });

    await h.service.prepare(makeChat(), []);

    expect(h.directory.lookups()[0]).toEqual({ by: 'domain', domain: 'site.kz' });
  });

  it('обычный аккаунт: профиль personal, по домену не ищем', async () => {
    const h = createHarness({ contacts: { profile: { kind: 'personal' } } });

    await h.service.prepare(makeChat(), []);

    expect(h.directory.lookups().map((query) => query.by)).toEqual(['phone']);
    expect(h.repo.current()).toMatchObject({ profileKind: 'personal', profileDomain: null });
  });

  it('профиль не получен: unknown, поиск продолжается с номера, шаги не засчитаны (профиль спросят снова)', async () => {
    const h = createHarness({ contacts: { profile: { kind: 'failed' } } });

    await h.service.prepare(makeChat(), []);

    expect(h.directory.lookups().map((query) => query.by)).toEqual(['phone']);
    expect(h.repo.current()).toMatchObject({
      profileKind: 'unknown',
      profileRequests: 1,
      profileDomain: null,
      freeStepsAtMs: null,
    });
  });

  const IDENTITIES: readonly (readonly [string, ChatIdentity, string])[] = [
    ['номер, если известен', { replyJid: LID_JID, lidJid: LID_JID, pnJid: CLIENT_JID }, CLIENT_JID],
    ['адрес @lid, если номера нет', { replyJid: LID_JID, lidJid: LID_JID, pnJid: null }, LID_JID],
    ['адрес ответа, если других нет', { replyJid: LID_JID, lidJid: null, pnJid: null }, LID_JID],
  ];

  it.each(IDENTITIES)('адрес для запроса профиля: %s', async (_label, identity, expectedJid) => {
    const h = createHarness();

    await h.service.prepare(makeChat({ identity }), []);

    expect(h.contacts.calls[0]).toEqual({ method: 'businessProfile', jid: expectedJid });
  });

  it('номер скрыт (только @lid), а в бизнес-профиле сайт: компания найдена по домену', async () => {
    const identity: ChatIdentity = { replyJid: LID_JID, lidJid: LID_JID, pnJid: null };
    const h = createHarness({
      contacts: { profile: SITE },
      directory: { lookup: lookupBy({ domain: FOUND }) },
    });

    const turn = await h.service.prepare(makeChat({ identity }), []);

    expect(h.contacts.calls[0]).toEqual({ method: 'businessProfile', jid: LID_JID });
    expect(h.directory.lookups()).toEqual([{ by: 'domain', domain: 'sklad.kz' }]);
    expect(turn.prompt).toMatchObject({ kind: 'candidate', name: 'Платформа-А' });
  });
});

describe('prepare: шаг б, номер', () => {
  it('номер из адреса с номером: поиск по цифрам 7XXXXXXXXXX, найденная компания становится кандидатом', async () => {
    const h = createHarness({
      directory: { lookup: lookupBy({ phone: ok([makeCandidate({ matchBy: 'phone' })]) }) },
    });

    const turn = await h.service.prepare(makeChat(), [makeMessage()]);

    expect(h.directory.lookups()).toEqual([{ by: 'phone', phone: '77000000001' }]);
    expect(turn.prompt).toEqual({
      kind: 'candidate',
      name: 'Платформа-А',
      city: 'Алматы',
      withCity: false,
    });
    expect(h.repo.current().candidate).toEqual(makeChatCandidate({ source: 'phone' }));
  });

  it('номер скрыт (только @lid): по номеру не ищем', async () => {
    const identity: ChatIdentity = { replyJid: LID_JID, lidJid: LID_JID, pnJid: null };
    const h = createHarness();

    await h.service.prepare(makeChat({ identity }), []);

    expect(h.directory.lookups()).toEqual([]);
    expect(h.repo.current().freeStepsAtMs).not.toBeNull();
  });

  it('номер не вида 7XXXXXXXXXX: по номеру не ищем', async () => {
    const odd = '87001234567@s.whatsapp.net' as ChatIdentity['replyJid'];
    const identity: ChatIdentity = { replyJid: odd, lidJid: null, pnJid: odd };
    const h = createHarness();

    await h.service.prepare(makeChat({ identity }), []);

    expect(h.directory.lookups()).toEqual([]);
  });
});

describe('prepare: шаг в, имя профиля', () => {
  it('verifiedName из пачки: поиск по названию, найденная компания становится кандидатом', async () => {
    const h = createHarness({
      directory: {
        lookup: lookupBy({ name: ok([makeCandidate({ matchBy: 'name', matchScore: 0.9 })]) }),
      },
    });

    const turn = await h.service.prepare(makeChat(), [
      makeMessage({ verifiedName: 'Платформа-А' }),
    ]);

    expect(h.directory.lookups()).toEqual([
      { by: 'phone', phone: '77000000001' },
      { by: 'name', name: 'Платформа-А' },
    ]);
    expect(turn.prompt).toMatchObject({ kind: 'candidate', name: 'Платформа-А' });
    expect(h.repo.current().candidate).toEqual(makeChatCandidate({ source: 'profile_name' }));
  });

  it('pushName обычного человека без признака компании: по имени не ищем', async () => {
    const h = createHarness();

    await h.service.prepare(makeChat(), [makeMessage({ pushName: 'Иван Петров' })]);

    expect(h.directory.lookups().map((query) => query.by)).toEqual(['phone']);
  });

  it('pushName бизнес-аккаунта: ищем как есть', async () => {
    const h = createHarness({
      contacts: { profile: { kind: 'business', websites: [], email: null } },
    });

    await h.service.prepare(makeChat(), [makeMessage({ pushName: 'Склад у дома' })]);

    expect(h.directory.lookups()).toContainEqual({ by: 'name', name: 'Склад у дома' });
  });

  it('pushName с формой собственности у личного аккаунта: ищем', async () => {
    const h = createHarness();

    await h.service.prepare(makeChat(), [makeMessage({ pushName: 'ТОО Альфа' })]);

    expect(h.directory.lookups()).toContainEqual({ by: 'name', name: 'ТОО Альфа' });
  });

  it('берётся имя последнего сообщения пачки, где имя есть', async () => {
    const h = createHarness();

    await h.service.prepare(makeChat(), [
      makeMessage({ pushName: 'ТОО Старое' }),
      makeMessage({ pushName: 'ТОО Новое' }),
      makeMessage({ pushName: null }),
    ]);

    expect(h.directory.lookups()).toContainEqual({ by: 'name', name: 'ТОО Новое' });
    expect(h.directory.lookups()).not.toContainEqual({ by: 'name', name: 'ТОО Старое' });
  });

  it('verifiedName важнее pushName того же сообщения', async () => {
    const h = createHarness();

    await h.service.prepare(makeChat(), [
      makeMessage({ pushName: 'Иван', verifiedName: 'Платформа-А' }),
    ]);

    expect(h.directory.lookups()).toContainEqual({ by: 'name', name: 'Платформа-А' });
  });

  it('в пачке нет имён: по имени не ищем', async () => {
    const h = createHarness();

    await h.service.prepare(makeChat(), [makeMessage(), makeMessage()]);

    expect(h.directory.lookups().map((query) => query.by)).toEqual(['phone']);
  });

  it('имя длиннее 200 знаков обрезается', async () => {
    const h = createHarness();

    await h.service.prepare(makeChat(), [makeMessage({ verifiedName: 'Ж'.repeat(300) })]);

    expect(h.directory.lookups()).toContainEqual({ by: 'name', name: 'Ж'.repeat(200) });
  });

  it('отклонённая раньше компания не выбирается по имени', async () => {
    const h = createHarness({
      state: makeState({ rejectedIds: [companyIdOf(8)] }),
      directory: {
        lookup: lookupBy({ name: ok([makeCandidate({ matchBy: 'name', matchScore: 0.9 })]) }),
      },
    });

    const turn = await h.service.prepare(makeChat(), [
      makeMessage({ verifiedName: 'Платформа-А' }),
    ]);

    expect(turn.prompt).toEqual({ kind: 'unknown', askName: true });
    expect(h.repo.current().candidate).toBeNull();
  });
});
