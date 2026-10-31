import { describe, expect, it } from 'vitest';
import type {
  CompanyMention,
  CompanyPrompt,
  CompanyQuestion,
  CompanyTurn,
} from '../../../src/domain/company.js';
import type { Chat, InboundMessage } from '../../../src/domain/types.js';
import { loggedText, makeChat } from '../handoff/fakes.js';
import { companyIdOf, jobIdOf, makeBrief, makeCandidate, SECOND_MS } from './builders.js';
import { createHarness, fail, type Harness, lidChat, lookupBy, makeMessage, ok } from './fakes.js';

// Сценарии владельца на уровне сервиса: несколько реплик клиента подряд, как их ведёт конвейер ответов:
// prepare, затем оценка интереса (applyAssessment), отметка вопроса (markAsked) и identifyAfterReply.

interface Reply {
  readonly mention?: CompanyMention | null;
  /** О чём спросил ответ бота. */
  readonly question?: CompanyQuestion;
  /** Отправленный текст ответа бота. */
  readonly sent?: string;
  readonly messages?: readonly InboundMessage[];
  readonly chat?: Chat;
}

interface Outcome {
  /** Что вернул prepare до ответа. */
  readonly turn: CompanyTurn;
  /** Блок о компании после оценки интереса: так его видит ответ, если клиента ждали (awaitingAnswer). */
  readonly prompt: CompanyPrompt;
}

/** Одна реплика клиента от пачки до конца ответа. */
async function conversation(h: Harness, reply: Reply = {}): Promise<Outcome> {
  const chat = reply.chat ?? makeChat();
  const turn = await h.service.prepare(chat, reply.messages ?? [makeMessage()]);
  const prompt = await h.service.applyAssessment(chat.id, reply.mention ?? null);
  h.service.markAsked(chat.id, reply.question ?? 'none', reply.sent ?? 'Понял вас.');
  await h.service.identifyAfterReply(chat);
  return { turn, prompt };
}

const NO_ANSWER: CompanyMention = {
  name: null,
  city: null,
  aliases: [],
  answer: 'none',
  pains: [],
};
const YES: CompanyMention = { ...NO_ANSWER, answer: 'yes' };
const NO: CompanyMention = { ...NO_ANSWER, answer: 'no' };

const BRIEF = makeBrief();
const BY_DOMAIN = ok([makeCandidate()]);
const BY_PHONE = ok([makeCandidate({ matchBy: 'phone' })]);

describe('сценарий: найден по домену, номер скрыт', () => {
  it('только @lid и сайт в бизнес-профиле: кандидат, вопрос, «да», справка в промпте', async () => {
    const h = createHarness({
      contacts: { profile: { kind: 'business', websites: ['https://www.sklad.kz'], email: null } },
      directory: { lookup: lookupBy({ domain: BY_DOMAIN }), brief: () => ok(BRIEF) },
    });
    const chat = lidChat();

    const first = await conversation(h, { chat, question: 'confirm' });
    const second = await conversation(h, { chat, mention: YES });

    expect(first.turn.prompt).toEqual({
      kind: 'candidate',
      name: 'Платформа-А',
      city: 'Алматы',
      withCity: false,
    });
    expect(first.turn.awaitingAnswer).toBe(false);
    expect(h.directory.lookups().map((query) => query.by)).toEqual(['domain']);
    expect(second.turn).toEqual({
      prompt: { kind: 'asked', name: 'Платформа-А', city: 'Алматы', awaitingAnswer: true },
      awaitingAnswer: true,
    });
    expect(second.prompt).toEqual({
      kind: 'confirmed',
      name: 'Платформа-А',
      rubric: 'Складское хранение',
      pains: ['Инвентаризация занимает дни и отрывает людей'],
      emailed: false,
    });
    expect(h.service.summary(chat.id)).toMatchObject({ status: 'confirmed', companyId: 8 });
  });
});

describe('сценарий: почта на gmail', () => {
  it('домен из почты не используется: компания ищется по номеру', async () => {
    const h = createHarness({
      contacts: { profile: { kind: 'business', websites: [], email: 'shop@gmail.com' } },
      directory: { lookup: lookupBy({ phone: BY_PHONE }) },
    });

    const first = await conversation(h, { question: 'confirm' });

    expect(h.directory.lookups().map((query) => query.by)).toEqual(['phone']);
    expect(first.turn.prompt).toMatchObject({ kind: 'candidate', name: 'Платформа-А' });
  });
});

describe('сценарий: найден по номеру', () => {
  it('обычный аккаунт: кандидат по номеру, «да», подтверждение со справкой', async () => {
    const h = createHarness({
      directory: { lookup: lookupBy({ phone: BY_PHONE }), brief: () => ok(BRIEF) },
    });

    const first = await conversation(h, { question: 'confirm' });
    const second = await conversation(h, { mention: YES });

    expect(first.turn.prompt.kind).toBe('candidate');
    expect(second.prompt).toMatchObject({ kind: 'confirmed', name: 'Платформа-А' });
    expect(h.repo.current().confirmed).toMatchObject({ brief: BRIEF });
    expect(h.directory.lookups().map((query) => query.by)).toEqual(['phone']);
  });
});

describe('сценарий: название из слов клиента', () => {
  it('бот спрашивает название, клиент называет его с городом, компания найдена уверенно: подтверждена без вопроса', async () => {
    const h = createHarness({
      directory: {
        lookup: lookupBy({ name: ok([makeCandidate({ matchBy: 'name', matchScore: 0.9 })]) }),
        brief: () => ok(BRIEF),
      },
    });
    const noPhone = lidChat();

    const first = await conversation(h, { chat: noPhone, question: 'name' });
    const second = await conversation(h, {
      chat: noPhone,
      mention: { ...NO_ANSWER, name: 'Платформа-А', city: 'Алматы' },
    });
    const third = await conversation(h, { chat: noPhone });

    expect(first.turn.prompt).toEqual({ kind: 'unknown', askName: true });
    expect(second.turn.prompt).toEqual({ kind: 'unknown', askName: false });
    expect(third.turn).toMatchObject({
      prompt: { kind: 'confirmed', name: 'Платформа-А', rubric: 'Складское хранение' },
      awaitingAnswer: false,
    });
    expect(h.directory.count('brief')).toBe(1);
    expect(h.repo.current()).toMatchObject({
      candidate: null,
      confirmed: { name: 'Платформа-А', city: 'Алматы' },
      statedName: 'Платформа-А',
      statedCity: 'Алматы',
      lookedUpName: 'платформа а',
      nameAskedAtMs: expect.any(Number) as number,
    });
    expect(h.directory.count('startResearch')).toBe(0);
  });
});

describe('сценарий: «нет, это не мы»', () => {
  it('кандидат сброшен, повторно не предлагается, название можно спросить', async () => {
    const h = createHarness({ directory: { lookup: lookupBy({ phone: BY_PHONE }) } });

    const first = await conversation(h, { question: 'confirm' });
    const second = await conversation(h, { mention: NO });
    const third = await conversation(h);

    expect(first.turn.prompt.kind).toBe('candidate');
    expect(second.prompt).toEqual({ kind: 'unknown', askName: true });
    expect(h.repo.current()).toMatchObject({ candidate: null, rejectedIds: [8] });
    expect(third.turn.prompt).toEqual({ kind: 'unknown', askName: true });
    expect(h.repo.current().candidate).toBeNull();
    expect(h.service.summary(makeChat().id).status).toBe('unknown');
  });

  it('после «нет» и ответа с названием ищется другая компания, отклонённая не возвращается', async () => {
    const other = makeCandidate({
      id: companyIdOf(9),
      name: 'Бета',
      matchBy: 'name',
      matchScore: 0.9,
    });
    const h = createHarness({
      directory: {
        lookup: (query) =>
          query.by === 'phone'
            ? BY_PHONE
            : ok([makeCandidate({ matchBy: 'name', matchScore: 0.95 }), other].slice(0, 2)),
      },
    });

    await conversation(h, { question: 'confirm' });
    await conversation(h, { mention: { ...NO, name: 'Бета', city: 'Астана' } });
    const third = await conversation(h, { question: 'name' });

    expect(h.repo.current().rejectedIds).toEqual([8]);
    expect(h.repo.current().candidate).toMatchObject({ id: 9, source: 'message' });
    expect(third.turn.prompt).toMatchObject({ kind: 'candidate', name: 'Бета', withCity: true });
  });
});

describe('сценарий: окно ответа на «Вы из компании X?»', () => {
  it('клиент не ответил на вопрос, а потом сказал «да» на другой вопрос: компания не подтверждена', async () => {
    const h = createHarness({
      directory: { lookup: lookupBy({ phone: BY_PHONE }), brief: () => ok(BRIEF) },
    });

    await conversation(h, { question: 'confirm', sent: 'Вы из компании Платформа-А, правильно?' });
    const ignored = await conversation(h, {
      mention: NO_ANSWER,
      sent: 'Хотите, расскажу подробнее?',
    });
    const later = await conversation(h, { mention: YES });

    expect(ignored.turn.awaitingAnswer).toBe(true);
    expect(later.turn).toEqual({
      prompt: { kind: 'asked', name: 'Платформа-А', city: 'Алматы', awaitingAnswer: false },
      awaitingAnswer: false,
    });
    expect(later.prompt.kind).toBe('asked');
    expect(h.repo.current().confirmed).toBeNull();
    expect(h.directory.count('brief')).toBe(0);
  });

  it('модель не отметила вопрос, но спросила название кандидата: следующее «да» подтверждает', async () => {
    const h = createHarness({
      directory: { lookup: lookupBy({ phone: BY_PHONE }), brief: () => ok(BRIEF) },
    });

    await conversation(h, { sent: 'Подскажите, вы из «Платформа-А»?' });
    const yes = await conversation(h, { mention: YES });

    expect(yes.turn.awaitingAnswer).toBe(true);
    expect(yes.prompt).toMatchObject({ kind: 'confirmed', name: 'Платформа-А' });
  });
});

describe('сценарий: неизвестная компания, проверка, справка, подтверждение', () => {
  it('research => справка => кандидат => «да» => confirmed со справкой', async () => {
    const brief = makeBrief({ id: companyIdOf(51), name: 'Гамма-Склад', city: 'Астана' });
    let polls = 0;
    const h = createHarness({
      directory: {
        startResearch: () => ok({ kind: 'queued', jobId: jobIdOf('job-1') }),
        researchStatus: () => {
          polls += 1;
          return polls < 2 ? ok({ status: 'running' }) : ok({ status: 'done', brief });
        },
        brief: () => ok(brief),
      },
    });

    const first = await conversation(h, { question: 'name' });
    const second = await conversation(h, {
      mention: { ...NO_ANSWER, name: 'Гамма', city: 'Астана' },
    });
    h.clock.advance(6 * SECOND_MS);
    const third = await conversation(h);
    h.clock.advance(6 * SECOND_MS);
    const fourth = await conversation(h, { question: 'confirm' });
    const fifth = await conversation(h, { mention: YES });

    expect(first.turn.prompt).toEqual({ kind: 'unknown', askName: true });
    expect(second.turn.prompt).toEqual({ kind: 'unknown', askName: false });
    expect(h.directory.calls.find((call) => call.method === 'startResearch')).toMatchObject({
      request: { name: 'Гамма', city: 'Астана', phone: null, domain: null },
    });
    expect(third.turn.prompt).toEqual({ kind: 'searching' });
    expect(fourth.turn.prompt).toEqual({
      kind: 'candidate',
      name: 'Гамма-Склад',
      city: 'Астана',
      withCity: true,
    });
    expect(fifth.turn.awaitingAnswer).toBe(true);
    expect(fifth.prompt).toMatchObject({
      kind: 'confirmed',
      name: 'Гамма-Склад',
      rubric: 'Складское хранение',
    });
    expect(h.repo.current()).toMatchObject({
      research: { status: 'done', companyId: 51 },
      confirmed: { id: 51, brief },
    });
    expect(h.service.summary(makeChat().id)).toMatchObject({ status: 'confirmed', companyId: 51 });
  });

  it('в логах всего сценария нет названий, городов, номеров и адресов', async () => {
    const brief = makeBrief({
      id: companyIdOf(51),
      name: 'СЕКРЕТНАЯ-КОМПАНИЯ',
      city: 'СЕКРЕТНЫЙ-ГОРОД',
    });
    let polls = 0;
    const h = createHarness({
      contacts: {
        profile: { kind: 'business', websites: ['https://secret-domain.kz'], email: null },
      },
      directory: {
        startResearch: () => ok({ kind: 'queued', jobId: jobIdOf('job-secret') }),
        researchStatus: () => {
          polls += 1;
          return polls < 2 ? fail('unavailable') : ok({ status: 'done', brief });
        },
        brief: () => fail('unavailable'),
      },
    });

    await conversation(h, {
      mention: { ...NO_ANSWER, name: 'СЕКРЕТНОЕ-ИМЯ', city: 'СЕКРЕТНЫЙ-ГОРОД' },
    });
    h.clock.advance(6 * SECOND_MS);
    await conversation(h, { question: 'confirm' });
    h.clock.advance(6 * SECOND_MS);
    await conversation(h, { question: 'confirm' });
    await conversation(h, { mention: YES });

    const text = loggedText(h.logs);
    for (const secret of ['СЕКРЕТН', 'secret-domain', 'job-secret', '77000000001']) {
      expect(text).not.toContain(secret);
    }
    expect(h.logs.length).toBeGreaterThan(0);
  });
});

describe('сценарий: лимит проверок исчерпан', () => {
  it('research 429: работа без справки, больше проверок нет, менеджер видит слова клиента', async () => {
    const h = createHarness({
      directory: { startResearch: () => fail('rate_limited') },
    });

    await conversation(h, {
      mention: { ...NO_ANSWER, name: 'Гамма', city: 'Астана', pains: ['Пересорт'] },
    });
    const next = await conversation(h);

    expect(h.repo.current().research).toMatchObject({ status: 'failed', reason: 'rate_limited' });
    expect(next.turn).toEqual({
      prompt: { kind: 'unknown', askName: false },
      awaitingAnswer: false,
    });
    expect(h.directory.count('startResearch')).toBe(1);
    expect(h.service.summary(makeChat().id)).toMatchObject({
      status: 'unknown',
      statedName: 'Гамма',
      confirmedPains: ['Пересорт'],
      research: { status: 'failed', reason: 'rate_limited' },
    });
  });
});

describe('сценарий: API проекта B недоступен', () => {
  it('промпт без данных, исключений нет, шаги повторяются на следующей пачке', async () => {
    let available = false;
    const h = createHarness({
      contacts: { profile: { kind: 'business', websites: ['https://sklad.kz'], email: null } },
      directory: {
        lookup: (query) =>
          available ? lookupBy({ domain: BY_DOMAIN })(query) : fail('unavailable'),
        brief: () => (available ? ok(BRIEF) : fail('unavailable')),
      },
    });

    const down = await conversation(h, { mention: { ...NO_ANSWER, pains: ['Пересорт'] } });
    available = true;
    const up = await conversation(h, { question: 'confirm' });

    expect(down.turn).toEqual({
      prompt: { kind: 'unknown', askName: false },
      awaitingAnswer: false,
    });
    expect(h.contacts.count('businessProfile')).toBe(1);
    expect(up.turn.prompt).toMatchObject({ kind: 'candidate', name: 'Платформа-А' });
    expect(h.repo.current().confirmedPains).toEqual(['Пересорт']);
  });

  it('API недоступно и после «да»: компания подтверждена, справку запросят перед следующим ответом', async () => {
    let available = false;
    const h = createHarness({
      directory: {
        lookup: lookupBy({ phone: BY_PHONE }),
        brief: () => (available ? ok(BRIEF) : fail('unavailable')),
      },
    });

    await conversation(h, { question: 'confirm' });
    const yes = await conversation(h, { mention: YES });
    available = true;
    const next = await conversation(h);

    expect(yes.prompt).toMatchObject({ kind: 'confirmed', rubric: null, pains: [] });
    expect(next.turn.prompt).toMatchObject({
      kind: 'confirmed',
      rubric: 'Складское хранение',
      pains: ['Инвентаризация занимает дни и отрывает людей'],
    });
  });
});

describe('сценарий: сводка для менеджера по ходу диалога', () => {
  it('unknown, затем candidate, затем confirmed; ссылка на карточку из адреса интерфейса', async () => {
    const h = createHarness({
      emailUiUrl: 'http://127.0.0.1:8000/',
      directory: { lookup: lookupBy({ phone: BY_PHONE }), brief: () => ok(BRIEF) },
    });
    const id = makeChat().id;

    expect(h.service.summary(id)).toMatchObject({ status: 'unknown', cardUrl: null });
    await conversation(h, { question: 'confirm' });
    expect(h.service.summary(id)).toMatchObject({
      status: 'candidate',
      candidateSource: 'phone',
      cardUrl: 'http://127.0.0.1:8000/companies/8',
    });
    await conversation(h, { mention: YES });
    expect(h.service.summary(id)).toMatchObject({
      status: 'confirmed',
      rubric: 'Складское хранение',
      cardUrl: 'http://127.0.0.1:8000/companies/8',
      emailed: false,
      briefPains: BRIEF.pains,
    });
  });
});
