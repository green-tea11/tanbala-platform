import { describe, expect, it } from 'vitest';
import type { ChatCompanyState, CompanyMention } from '../../../src/domain/company.js';
import { loggedText, makeChat } from '../handoff/fakes.js';
import {
  CHAT_ID,
  companyIdOf,
  makeBrief,
  makeCandidate,
  makeChatCandidate,
  makeConfirmed,
  makeState,
  MINUTE_MS,
  NOW,
} from './builders.js';
import { createHarness, fail, lookupBy, makeMessage, ok, PHOTO } from './fakes.js';

// applyAssessment (итог оценки интереса) и markAsked (ответ ушёл клиенту).

const ASKED = makeChatCandidate({ source: 'phone', askedAtMs: NOW - 5000, awaitingAnswer: true });

function mention(overrides: Partial<CompanyMention> = {}): CompanyMention {
  return { name: null, city: null, aliases: [], answer: 'none', pains: [], ...overrides };
}

function waiting(overrides: Partial<ChatCompanyState> = {}): ChatCompanyState {
  return makeState({ freeStepsAtMs: NOW - MINUTE_MS, candidate: ASKED, ...overrides });
}

describe('applyAssessment: ответ на вопрос о кандидате', () => {
  it('«да»: кандидат подтверждён, справка запрашивается сразу, промпт confirmed со справкой', async () => {
    const h = createHarness({
      state: waiting(),
      directory: { brief: () => ok(makeBrief()) },
    });

    const prompt = await h.service.applyAssessment(CHAT_ID, mention({ answer: 'yes' }));

    expect(prompt).toEqual({
      kind: 'confirmed',
      name: 'Платформа-А',
      rubric: 'Складское хранение',
      pains: ['Инвентаризация занимает дни и отрывает людей'],
      emailed: false,
    });
    expect(h.directory.calls).toEqual([{ method: 'brief', id: companyIdOf(8) }]);
    expect(h.repo.current()).toMatchObject({
      candidate: null,
      confirmed: {
        id: companyIdOf(8),
        name: 'Платформа-А',
        city: 'Алматы',
        confirmedAtMs: NOW,
        brief: makeBrief(),
        briefAtMs: NOW,
      },
    });
  });

  it('«да», но справка недоступна: компания подтверждена без справки, в логе только чат, шаг и код', async () => {
    const h = createHarness({ state: waiting(), directory: { brief: () => fail('unavailable') } });

    const prompt = await h.service.applyAssessment(CHAT_ID, mention({ answer: 'yes' }));

    expect(prompt).toEqual({
      kind: 'confirmed',
      name: 'Платформа-А',
      rubric: null,
      pains: [],
      emailed: false,
    });
    expect(h.repo.current().confirmed).toMatchObject({ brief: null, briefAtMs: null });
    expect(h.logs.filter((entry) => entry.level === 'warn').map((entry) => entry.context)).toEqual([
      { chatId: 12, step: 'brief', failure: 'unavailable' },
    ]);
    expect(loggedText(h.logs)).not.toContain('Платформа');
  });

  it.each(['yes', 'no'] as const)(
    'ответ %s, когда ожидание уже снято (вопрос был раньше): чужое «да» или «нет» не считается',
    async (answer) => {
      const candidate = { ...ASKED, awaitingAnswer: false };
      const h = createHarness({
        state: waiting({ candidate }),
        directory: { brief: () => ok(makeBrief()) },
      });

      const prompt = await h.service.applyAssessment(CHAT_ID, mention({ answer }));

      expect(prompt).toEqual({
        kind: 'asked',
        name: 'Платформа-А',
        city: 'Алматы',
        awaitingAnswer: false,
      });
      expect(h.repo.current()).toMatchObject({ candidate, confirmed: null, rejectedIds: [] });
      expect(h.directory.calls).toEqual([]);
    },
  );

  it('«нет»: ID в отклонённые, кандидат сброшен, промпт unknown, название можно спросить', async () => {
    const h = createHarness({ state: waiting({ rejectedIds: [companyIdOf(3)] }) });

    const prompt = await h.service.applyAssessment(CHAT_ID, mention({ answer: 'no' }));

    expect(prompt).toEqual({ kind: 'unknown', askName: true });
    expect(h.repo.current()).toMatchObject({
      candidate: null,
      confirmed: null,
      rejectedIds: [companyIdOf(3), companyIdOf(8)],
    });
    expect(h.directory.calls).toEqual([]);
  });

  it('«нет» у бизнес-аккаунта до проверки логотипа: шаги а, б, в и логотип не повторяются, сразу вопрос о названии', async () => {
    const h = createHarness({
      state: makeState({
        profileKind: 'business',
        profileDomain: 'sklad.kz',
        candidate: ASKED,
      }),
      contacts: { photo: PHOTO },
      logo: { ok: true, value: 'Платформа-А' },
      directory: { lookup: () => ok([makeCandidate({ id: companyIdOf(9) })]) },
    });

    const prompt = await h.service.applyAssessment(CHAT_ID, mention({ answer: 'no' }));
    await h.service.identifyAfterReply(makeChat());
    const turn = await h.service.prepare(makeChat(), [makeMessage({ verifiedName: 'Бета' })]);

    expect(prompt).toEqual({ kind: 'unknown', askName: true });
    expect(turn.prompt).toEqual({ kind: 'unknown', askName: true });
    expect(h.directory.calls).toEqual([]);
    expect(h.contacts.calls).toEqual([]);
    expect(h.logo.calls).toEqual([]);
    expect(h.repo.current()).toMatchObject({
      freeStepsAtMs: NOW,
      logoCheckedAtMs: NOW,
      rejectedIds: [companyIdOf(8)],
    });
  });

  it('«нет» на кандидата из проверки новой компании: тоже сброс и отклонение', async () => {
    const h = createHarness({
      state: waiting({
        statedName: 'Гамма',
        candidate: makeChatCandidate({
          id: companyIdOf(51),
          source: 'research',
          askedAtMs: NOW - 1000,
          awaitingAnswer: true,
        }),
      }),
    });

    const prompt = await h.service.applyAssessment(CHAT_ID, mention({ answer: 'no' }));

    expect(prompt).toEqual({ kind: 'unknown', askName: false });
    expect(h.repo.current().rejectedIds).toEqual([companyIdOf(51)]);
  });

  it('ответа нет: ожидание здесь не снимается (его снимет markAsked после отправки), промпт asked', async () => {
    const h = createHarness({ state: waiting() });

    const prompt = await h.service.applyAssessment(CHAT_ID, mention({ answer: 'none' }));

    expect(prompt).toEqual({
      kind: 'asked',
      name: 'Платформа-А',
      city: 'Алматы',
      awaitingAnswer: true,
    });
    expect(h.repo.current().candidate).toEqual(ASKED);
  });

  it('перегенерация пачки: первая оценка без ответа, вторая с «да» из дописанного сообщения подтверждает', async () => {
    const h = createHarness({ state: waiting(), directory: { brief: () => ok(makeBrief()) } });

    await h.service.applyAssessment(CHAT_ID, mention({ answer: 'none' }));
    const prompt = await h.service.applyAssessment(CHAT_ID, mention({ answer: 'yes' }));

    expect(prompt.kind).toBe('confirmed');
  });

  it.each(['yes', 'no'] as const)(
    'ответ %s, пока кандидата ещё не спрашивали: игнорируется, кандидат остаётся',
    async (answer) => {
      const candidate = makeChatCandidate({ source: 'phone' });
      const h = createHarness({ state: waiting({ candidate }) });

      const prompt = await h.service.applyAssessment(CHAT_ID, mention({ answer }));

      expect(prompt.kind).toBe('candidate');
      expect(h.repo.current()).toMatchObject({ candidate, confirmed: null, rejectedIds: [] });
      expect(h.directory.calls).toEqual([]);
    },
  );

  it.each(['yes', 'no', 'none'] as const)(
    'ответ %s без кандидата: ничего не меняется, кроме слов клиента',
    async (answer) => {
      const h = createHarness({
        state: makeState({ freeStepsAtMs: NOW - MINUTE_MS, profileKind: 'personal' }),
      });

      const prompt = await h.service.applyAssessment(CHAT_ID, mention({ answer }));

      expect(prompt).toEqual({ kind: 'unknown', askName: true });
      expect(h.repo.current()).toMatchObject({ confirmed: null, candidate: null, rejectedIds: [] });
    },
  );

  it('«да» при уже подтверждённой компании: подтверждение не повторяется и справка не запрашивается', async () => {
    const h = createHarness({
      state: makeState({ confirmed: makeConfirmed({ brief: makeBrief(), briefAtMs: NOW - 1 }) }),
    });

    const prompt = await h.service.applyAssessment(CHAT_ID, mention({ answer: 'yes' }));

    expect(prompt.kind).toBe('confirmed');
    expect(h.directory.calls).toEqual([]);
  });
});

describe('applyAssessment: слова клиента', () => {
  it('название и город со слов клиента записываются, промпт перестаёт предлагать спросить название', async () => {
    const h = createHarness();

    const prompt = await h.service.applyAssessment(
      CHAT_ID,
      mention({ name: 'Платформа-А', city: 'Алматы' }),
    );

    expect(prompt).toEqual({ kind: 'unknown', askName: false });
    expect(h.repo.current()).toMatchObject({ statedName: 'Платформа-А', statedCity: 'Алматы' });
  });

  it('пробелы по краям убираются, название до 200 знаков, город до 100', async () => {
    const h = createHarness();

    await h.service.applyAssessment(
      CHAT_ID,
      mention({ name: `  ${'Н'.repeat(250)} `, city: `${'Г'.repeat(120)}  ` }),
    );

    expect(h.repo.current().statedName).toBe('Н'.repeat(200));
    expect(h.repo.current().statedCity).toBe('Г'.repeat(100));
  });

  it('пустое название и город прежние не стирают', async () => {
    const h = createHarness({ state: makeState({ statedName: 'Старое', statedCity: 'Астана' }) });

    await h.service.applyAssessment(CHAT_ID, mention({ name: '   ', city: '' }));

    expect(h.repo.current()).toMatchObject({ statedName: 'Старое', statedCity: 'Астана' });
  });

  it('новое название заменяет прежнее', async () => {
    const h = createHarness({ state: makeState({ statedName: 'Старое', statedCity: 'Астана' }) });

    await h.service.applyAssessment(CHAT_ID, mention({ name: 'Новое' }));

    expect(h.repo.current()).toMatchObject({ statedName: 'Новое', statedCity: 'Астана' });
  });

  it('боли объединяются с прежними без повторов, не больше пяти, свежие не теряются', async () => {
    const h = createHarness({
      state: makeState({ confirmedPains: ['1', '2', '3', '4', '5'] }),
    });

    await h.service.applyAssessment(CHAT_ID, mention({ pains: ['5', '6'] }));

    expect(h.repo.current().confirmedPains).toEqual(['2', '3', '4', '5', '6']);
  });

  it('ответ и слова клиента применяются вместе: «нет, мы Бета»', async () => {
    const h = createHarness({ state: waiting() });

    const prompt = await h.service.applyAssessment(
      CHAT_ID,
      mention({ answer: 'no', name: 'Бета', city: 'Астана', pains: ['Пересорт'] }),
    );

    expect(prompt).toEqual({ kind: 'unknown', askName: false });
    expect(h.repo.current()).toMatchObject({
      candidate: null,
      rejectedIds: [companyIdOf(8)],
      statedName: 'Бета',
      statedCity: 'Астана',
      confirmedPains: ['Пересорт'],
    });
  });

  it('клиент сам назвал другую компанию, а кандидат по номеру ещё не спрошен: после ответа поиск по словам клиента нашёл её, кандидат заменён без отклонения', async () => {
    const h = createHarness({
      state: makeState({
        freeStepsAtMs: NOW - MINUTE_MS,
        candidate: makeChatCandidate({ source: 'phone' }),
      }),
      directory: {
        lookup: lookupBy({
          name: ok([
            makeCandidate({ id: companyIdOf(9), name: 'Бета', matchBy: 'name', matchScore: 0.9 }),
          ]),
        }),
      },
    });

    const prompt = await h.service.applyAssessment(CHAT_ID, mention({ name: 'ТОО «Бета»' }));
    await h.service.identifyAfterReply(makeChat());

    expect(prompt).toMatchObject({ kind: 'candidate', name: 'Платформа-А' });
    expect(h.directory.lookups()).toEqual([{ by: 'name', name: 'ТОО «Бета»' }]);
    expect(h.repo.current()).toMatchObject({
      rejectedIds: [],
      candidate: { id: companyIdOf(9), source: 'message' },
    });
  });

  it('клиент назвал ту же компанию, что и кандидат: кандидат остаётся и будет спрошен', async () => {
    const candidate = makeChatCandidate({ source: 'phone' });
    const h = createHarness({ state: makeState({ freeStepsAtMs: NOW - MINUTE_MS, candidate }) });

    const prompt = await h.service.applyAssessment(CHAT_ID, mention({ name: 'платформа а' }));

    expect(prompt).toMatchObject({ kind: 'candidate', name: 'Платформа-А' });
    expect(h.repo.current().candidate).toEqual(candidate);
  });

  it('клиент назвал другую компанию, а кандидата уже спросили без ответа: до поиска кандидат остаётся, после поиска заменён', async () => {
    const h = createHarness({
      state: waiting({ candidate: { ...ASKED, awaitingAnswer: false } }),
      directory: {
        lookup: lookupBy({
          name: ok([
            makeCandidate({ id: companyIdOf(9), name: 'Бета', matchBy: 'name', matchScore: 0.9 }),
          ]),
        }),
      },
    });

    const prompt = await h.service.applyAssessment(CHAT_ID, mention({ name: 'Бета' }));
    await h.service.identifyAfterReply(makeChat());

    expect(prompt.kind).toBe('asked');
    expect(h.repo.current()).toMatchObject({
      rejectedIds: [],
      candidate: { id: companyIdOf(9), source: 'message', askedAtMs: null },
    });
  });

  it('клиент назвал другую компанию, пока ждём ответа на вопрос о кандидате: кандидат остаётся, поиска нет', async () => {
    const h = createHarness({ state: waiting() });

    const prompt = await h.service.applyAssessment(CHAT_ID, mention({ name: 'Бета' }));
    await h.service.identifyAfterReply(makeChat());

    expect(prompt).toMatchObject({ kind: 'asked', awaitingAnswer: true });
    expect(h.directory.calls).toEqual([]);
    expect(h.repo.current().candidate).toEqual(ASKED);
  });

  it('оценки нет (null): возвращается текущий промпт, в базу ничего не пишется', async () => {
    const h = createHarness({ state: waiting() });

    const prompt = await h.service.applyAssessment(CHAT_ID, null);

    expect(prompt).toEqual({
      kind: 'asked',
      name: 'Платформа-А',
      city: 'Алматы',
      awaitingAnswer: true,
    });
    expect(h.repo.saves).toEqual([]);
    expect(h.directory.calls).toEqual([]);
  });

  it('сбой базы при записи пробрасывается отказом промиса', async () => {
    const h = createHarness({ state: waiting() });
    const failure = new Error('база недоступна');
    h.repo.failNext('save', failure);

    await expect(h.service.applyAssessment(CHAT_ID, mention({ answer: 'no' }))).rejects.toBe(
      failure,
    );
  });
});

describe('markAsked', () => {
  const QUESTION = 'Вы из компании «Платформа-А», правильно?';

  it('confirm: кандидат помечен спрошенным и ждёт ответа, следующая пачка об этом знает', async () => {
    const h = createHarness({
      state: makeState({ freeStepsAtMs: NOW - MINUTE_MS, candidate: makeChatCandidate() }),
    });

    h.service.markAsked(CHAT_ID, 'confirm', QUESTION);
    const turn = await h.service.prepare(makeChat(), []);

    expect(h.repo.current().candidate).toEqual({
      ...makeChatCandidate(),
      askedAtMs: NOW,
      awaitingAnswer: true,
    });
    expect(turn).toEqual({
      prompt: { kind: 'asked', name: 'Платформа-А', city: 'Алматы', awaitingAnswer: true },
      awaitingAnswer: true,
    });
  });

  it('confirm: время вопроса берётся из часов', () => {
    const h = createHarness({ state: makeState({ candidate: makeChatCandidate() }) });
    h.clock.advance(7 * MINUTE_MS);

    h.service.markAsked(CHAT_ID, 'confirm', QUESTION);

    expect(h.repo.current().candidate?.askedAtMs).toBe(NOW + 7 * MINUTE_MS);
  });

  it('модель не отметила вопрос, но в ответе название кандидата: вопрос засчитан, ждём ответа', () => {
    const h = createHarness({ state: makeState({ candidate: makeChatCandidate() }) });

    h.service.markAsked(CHAT_ID, 'none', 'Платформа-А, Алматы, верно?');

    expect(h.repo.current().candidate).toMatchObject({ askedAtMs: NOW, awaitingAnswer: true });
  });

  it('название кандидата только упомянуто не в вопросе: вопрос больше не задаётся, но «да» не засчитается', async () => {
    const candidate = makeChatCandidate({ name: 'ТОО «Склад»' });
    const h = createHarness({ state: makeState({ freeStepsAtMs: NOW - MINUTE_MS, candidate }) });

    h.service.markAsked(CHAT_ID, 'none', 'Ридер стоит на входе в склад. Как у вас сейчас?');
    const turn = await h.service.prepare(makeChat(), []);
    await h.service.applyAssessment(CHAT_ID, mention({ answer: 'yes' }));

    expect(turn).toEqual({
      prompt: { kind: 'asked', name: 'ТОО «Склад»', city: 'Алматы', awaitingAnswer: false },
      awaitingAnswer: false,
    });
    expect(h.repo.current()).toMatchObject({
      candidate: { ...candidate, askedAtMs: NOW, awaitingAnswer: false },
      confirmed: null,
    });
  });

  it('кандидат не спрошен, в ответе его названия нет: ничего не пишется', () => {
    const h = createHarness({ state: makeState({ candidate: makeChatCandidate() }) });

    h.service.markAsked(CHAT_ID, 'none', 'Расскажите, что у вас за склад?');

    expect(h.repo.saves).toEqual([]);
  });

  it('ответ на пачку ушёл, «да» или «нет» в ней не было: ожидание снято, вопрос больше не задаётся', async () => {
    const h = createHarness({ state: waiting() });

    h.service.markAsked(CHAT_ID, 'none', 'Понял вас.');
    const turn = await h.service.prepare(makeChat(), []);

    expect(h.repo.current().candidate).toEqual({ ...ASKED, awaitingAnswer: false });
    expect(turn).toEqual({
      prompt: { kind: 'asked', name: 'Платформа-А', city: 'Алматы', awaitingAnswer: false },
      awaitingAnswer: false,
    });
  });

  it('confirm при уже спрошенном кандидате: второй вопрос не засчитывается, ожидание снято', () => {
    const h = createHarness({ state: waiting() });

    h.service.markAsked(CHAT_ID, 'confirm', QUESTION);

    expect(h.repo.current().candidate).toEqual({ ...ASKED, awaitingAnswer: false });
  });

  it('спрошенный кандидат без ожидания: ничего не пишется', () => {
    const h = createHarness({ state: waiting({ candidate: { ...ASKED, awaitingAnswer: false } }) });

    h.service.markAsked(CHAT_ID, 'confirm', QUESTION);

    expect(h.repo.saves).toEqual([]);
  });

  it('confirm: кандидата нет, в базу ничего не пишется', () => {
    const h = createHarness();

    h.service.markAsked(CHAT_ID, 'confirm', QUESTION);

    expect(h.repo.saves).toEqual([]);
  });

  it('name: время вопроса о названии записывается, промпт перестаёт предлагать спросить', async () => {
    const h = createHarness({ state: makeState({ freeStepsAtMs: NOW - MINUTE_MS }) });

    h.service.markAsked(CHAT_ID, 'name', 'Из какой вы компании?');
    const turn = await h.service.prepare(makeChat(), []);

    expect(h.repo.current().nameAskedAtMs).toBe(NOW);
    expect(turn.prompt).toEqual({ kind: 'unknown', askName: false });
  });

  it('name: второй вопрос не перезаписывает время первого и ничего не пишет', () => {
    const h = createHarness({ state: makeState({ nameAskedAtMs: NOW - 1000 }) });

    h.service.markAsked(CHAT_ID, 'name', 'Из какой вы компании?');

    expect(h.repo.current().nameAskedAtMs).toBe(NOW - 1000);
    expect(h.repo.saves).toEqual([]);
  });

  it('none без кандидата: вопрос о названии не угадывается по тексту, ничего не пишется', () => {
    const h = createHarness({ state: makeState({ freeStepsAtMs: NOW - MINUTE_MS }) });

    h.service.markAsked(CHAT_ID, 'none', 'Из какой вы компании?');

    expect(h.repo.saves).toEqual([]);
  });

  it('API и WhatsApp не вызываются', () => {
    const h = createHarness({ state: makeState({ candidate: makeChatCandidate() }) });

    h.service.markAsked(CHAT_ID, 'confirm', QUESTION);
    h.service.markAsked(CHAT_ID, 'name', 'Из какой вы компании?');

    expect(h.directory.calls).toEqual([]);
    expect(h.contacts.calls).toEqual([]);
  });

  it('сбой базы пробрасывается как есть', () => {
    const h = createHarness({ state: makeState({ candidate: makeChatCandidate() }) });
    const failure = new Error('база недоступна');
    h.repo.failNext('save', failure);

    expect(() => {
      h.service.markAsked(CHAT_ID, 'confirm', QUESTION);
    }).toThrow(failure);
  });
});

describe('stopAwaiting', () => {
  it('ожидание ответа снято, время вопроса и остальное состояние не меняются: чужое «да» не подтвердит компанию', async () => {
    const h = createHarness({
      state: waiting({ statedName: 'Бета', confirmedPains: ['Пересорт'] }),
    });

    h.service.stopAwaiting(CHAT_ID);
    const prompt = await h.service.applyAssessment(CHAT_ID, mention({ answer: 'yes' }));

    expect(h.repo.saves[0]).toEqual(
      waiting({
        statedName: 'Бета',
        confirmedPains: ['Пересорт'],
        candidate: { ...ASKED, awaitingAnswer: false },
      }),
    );
    expect(prompt).toEqual({
      kind: 'asked',
      name: 'Платформа-А',
      city: 'Алматы',
      awaitingAnswer: false,
    });
    expect(h.repo.current().confirmed).toBeNull();
  });

  it.each([
    ['кандидата нет', makeState()],
    ['кандидат не спрошен', makeState({ candidate: makeChatCandidate() })],
    ['ответа уже не ждём', waiting({ candidate: { ...ASKED, awaitingAnswer: false } })],
    ['компания подтверждена', makeState({ confirmed: makeConfirmed() })],
  ])('%s: ничего не пишется', (_label, state) => {
    const h = createHarness({ state });

    h.service.stopAwaiting(CHAT_ID);

    expect(h.repo.saves).toEqual([]);
  });

  it('API и WhatsApp не вызываются', () => {
    const h = createHarness({ state: waiting() });

    h.service.stopAwaiting(CHAT_ID);

    expect(h.directory.calls).toEqual([]);
    expect(h.contacts.calls).toEqual([]);
  });

  it('сбой базы пробрасывается как есть', () => {
    const h = createHarness({ state: waiting() });
    const failure = new Error('база недоступна');
    h.repo.failNext('save', failure);

    expect(() => {
      h.service.stopAwaiting(CHAT_ID);
    }).toThrow(failure);
  });
});
