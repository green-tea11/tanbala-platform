import { describe, expect, it } from 'vitest';
import { emptyCompanyState } from '../../../src/db/repos/chat-companies.js';
import {
  API_TOKEN,
  API_URL,
  CLIENT_JID,
  CLIENT_LID,
  CLIENT_PHONE,
  createScenario,
  dataOf,
  EMAIL_UI_URL,
  json,
  nothingFound,
  type ApiAnswer,
  type ApiCall,
  type ApiRoutes,
} from './company-scenarios-harness.js';
import type { InterestScript, LlmScript } from './scripted-llm.js';

// Сценарии владельца о компании клиента (требования 27.10.2026, пункт 9) на уровне конвейера: реплики клиента
// проходят очередь склейки, конвейер, настоящий сервис компании и клиент внутреннего API до сети. Проект B, WhatsApp
// и модель поддельные (стенд company-scenarios-harness.ts): 0 токенов, без сети. Проверяется видимое: что ушло
// клиенту и менеджеру, что попало в данные вызова модели, что записано в базе и какие запросы ушли бы в API.

const SKLAD_ID = 8;
const SKLAD = 'ТОО Склад Алматы';
const SKLAD_DOMAIN = 'sklad-almaty.kz';
const BEREKE_ID = 21;
const BEREKE = 'ТОО Береке';
const JOB_ID = '3f2b8c1e-7a4d-4c2e-9b1a-5d6e7f8a9b0c';

/** Боль справки: пункт списка раздела 5 knowledge/tanbala-agent.md. */
const PAIN_INVENTORY = 'Инвентаризация занимает дни и отрывает людей от работы';
const PAIN_MIXUP = 'Пересорт при отгрузке';
/** Цитаты и источники болей, оценка и тема письма из справки: модели их видеть нельзя, только менеджеру в панели. */
const EVIDENCE_SITE = 'Пересчитываем склад вручную раз в квартал';
const EVIDENCE_2GIS = 'Привезли не тот товар, разбирались неделю';
const FIT_REASON = 'Большой склад и ручной пересчёт';
const EMAIL_SUBJECT = 'Учёт склада без пересчёта';

/** Ответы бота (черновики поддельной модели); все проходят проверки кодом. */
const ASK_CONFIRM = `Здравствуйте. Подскажите, вы из компании ${SKLAD}, правильно?`;
const ASK_NAME = 'Подберём решение под вашу задачу. Подскажите, из какой вы компании?';
const ASK_BEREKE = `Спасибо. ${BEREKE}, Караганда, верно?`;
const PLAIN = 'Учёт подбираем под задачу. Что вы храните?';
const HOW_IT_WORKS =
  'Метку клеят на вещь, а ридеры с антеннами стоят на входах и выходах. Система сама отмечает приход и уход.';
const PAIN_QUESTION = `Спасибо. У похожих компаний бывает ${PAIN_MIXUP.toLowerCase()}. У вас такое случается?`;
/** Фраза владельца при передаче после вопроса цены. */
const PRICE_PHRASE = 'Цена сильно зависит от объёма. Уточню у коллеги и вернусь к вам.';

const CLIENT_HELLO = 'Здравствуйте, нужен учёт на складе';

// Ответы проекта B по контракту INTERNAL_API.md.

function candidateJson(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    id: SKLAD_ID,
    name: SKLAD,
    city: 'Алматы',
    rubric: 'Складское хранение',
    match_by: 'phone',
    match_score: 1,
    emailed: true,
    ...overrides,
  };
}

function found(candidate: unknown): Response {
  return json(200, { candidates: [candidate] });
}

function briefJson(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    id: SKLAD_ID,
    name: SKLAD,
    city: 'Алматы',
    rubric: 'Складское хранение',
    segment: 'Склады и логистика',
    fit: 'yes',
    fit_score: 64,
    reason: FIT_REASON,
    pains: [
      { pain: PAIN_INVENTORY, evidence: EVIDENCE_SITE, source: 'site' },
      { pain: PAIN_MIXUP, evidence: EVIDENCE_2GIS, source: '2gis' },
    ],
    emailed: true,
    emailed_at: '2026-10-20T10:00:00+05:00',
    email_subject: EMAIL_SUBJECT,
    ...overrides,
  };
}

const BEREKE_BRIEF = briefJson({
  id: BEREKE_ID,
  name: BEREKE,
  city: 'Караганда',
  rubric: 'Оптовая торговля',
  emailed: false,
  emailed_at: null,
  email_subject: null,
});

/** Проект B знает компанию клиента по номеру и отдаёт её справку. */
const SKLAD_BY_PHONE: ApiRoutes = {
  lookup: (query) => (query['phone'] === CLIENT_PHONE ? found(candidateJson()) : nothingFound()),
  brief: (id) => (id === SKLAD_ID ? json(200, briefJson()) : json(404, { error: 'not_found' })),
};

function lookupCall(query: Readonly<Record<string, string>>): ApiCall {
  return {
    method: 'GET',
    origin: API_URL,
    path: '/internal/lookup',
    query,
    body: null,
    token: API_TOKEN,
  };
}

function requestLines(calls: readonly ApiCall[]): string[] {
  return calls.map((call) => `${call.method} ${call.path}`);
}

// Ответы поддельной модели.

/** Ответ answer с вопросом о компании (или без него) и оценка интереса этой реплики. */
function reply(
  text: string,
  companyQuestion: 'none' | 'confirm' | 'name' = 'none',
  interest: InterestScript = {},
): LlmScript {
  return { replies: [{ outcome: 'answer', text, companyQuestion }], interests: [interest] };
}

/** Модель решает передать чат (hot) после вопроса цены и пишет фразу владельца о цене. */
function priceHandoff(interest: InterestScript = {}): LlmScript {
  return {
    replies: [{ outcome: 'hot', text: PRICE_PHRASE, aboutPrice: true }],
    interests: [{ ...interest, priceAsked: true }],
  };
}

/** Вопрос о недостающем для передачи по цене (решение владельца 29.10.2026). */
const ASK_COUNT =
  'Цена сильно зависит от объёма. Сколько примерно вещей нужно учитывать? Это нужно, чтобы коллега сразу назвал ориентир.';

describe('сценарии владельца: как находится компания клиента', () => {
  it('1. номер скрыт (только @lid), сайт в бизнес-профиле: найдена по домену, черновик спрашивает подтверждение, после отправки кандидат спрошен', async () => {
    const s = createScenario({
      hiddenNumber: true,
      openMode: true,
      profile: {
        kind: 'business',
        websites: [`https://www.${SKLAD_DOMAIN}/kontakty`],
        email: null,
      },
      api: {
        lookup: (query) =>
          query['domain'] === SKLAD_DOMAIN
            ? found(candidateJson({ match_by: 'domain' }))
            : nothingFound(),
      },
    });

    const turn = await s.say(CLIENT_HELLO, reply(ASK_CONFIRM, 'confirm'));

    expect(s.contacts.businessProfile).toHaveBeenCalledWith(CLIENT_LID);
    // Номера нет: поиска по номеру нет, только по домену сайта, с токеном и только на эту машину.
    expect(turn.api).toEqual([lookupCall({ domain: SKLAD_DOMAIN })]);
    expect(turn.data('reply')).toContain(
      `«Вы из компании ${SKLAD}, правильно?» (companyQuestion: confirm)`,
    );
    expect(turn.outcome).toEqual({ kind: 'replied' });
    expect(turn.toClient).toEqual([ASK_CONFIRM]);
    expect(s.state().candidate).toEqual({
      id: SKLAD_ID,
      name: SKLAD,
      city: 'Алматы',
      source: 'profile_domain',
      askedAtMs: turn.atMs,
      awaitingAnswer: true,
    });
  });

  it('2. в бизнес-профиле почта на gmail и страница в соцсети: поиска по домену нет; сначала логотип, потом бот один раз спрашивает компанию', async () => {
    const s = createScenario({
      profile: {
        kind: 'business',
        websites: ['https://instagram.com/sklad_almaty'],
        email: 'sklad.almaty@gmail.com',
      },
    });

    const first = await s.say(CLIENT_HELLO, reply(PLAIN));
    const second = await s.say('Как это работает?', reply(ASK_NAME, 'name'));

    expect(s.state()).toMatchObject({ profileKind: 'business', profileDomain: null });
    expect(first.api.map((call) => call.query)).toEqual([{ phone: CLIENT_PHONE }]);
    expect(JSON.stringify(s.api)).not.toMatch(/domain|gmail|instagram/);
    // Шаг д раньше шага е: у бизнес-аккаунта название не спрашивают, пока не проверен логотип.
    expect(first.data('reply')).toContain(
      'Компания клиента неизвестна. О компании сейчас не спрашивай.',
    );
    expect(s.contacts.profilePhoto).toHaveBeenCalledTimes(1);
    expect(second.data('reply')).toContain(
      'один раз естественно спроси, из какой он компании (companyQuestion: name)',
    );
    expect(second.toClient).toEqual([ASK_NAME]);
    expect(s.state().nameAskedAtMs).toBe(second.atMs);
  });

  it('3. найдена по номеру: черновик спрашивает подтверждение, кандидат спрошен, менеджеру видна ссылка на карточку', async () => {
    const s = createScenario({ api: SKLAD_BY_PHONE });

    const turn = await s.say(CLIENT_HELLO, reply(ASK_CONFIRM, 'confirm'));

    expect(s.contacts.businessProfile).toHaveBeenCalledWith(CLIENT_JID);
    expect(turn.api).toEqual([lookupCall({ phone: CLIENT_PHONE })]);
    expect(turn.data('reply')).toContain(`«Вы из компании ${SKLAD}, правильно?»`);
    expect(turn.toClient).toEqual([ASK_CONFIRM]);
    expect(s.state().candidate).toMatchObject({
      id: SKLAD_ID,
      source: 'phone',
      askedAtMs: turn.atMs,
      awaitingAnswer: true,
    });
    expect(s.company.service.summary(s.chatId())).toMatchObject({
      status: 'candidate',
      candidateSource: 'phone',
      cardUrl: `${EMAIL_UI_URL}/companies/${SKLAD_ID}`,
    });
  });

  it('4. найдена по названию из слов клиента, но город карточки другой: поиск после ответа, в следующей реплике блок кандидата с городом', async () => {
    const romashka = candidateJson({
      id: 34,
      name: 'ТОО Ромашка',
      match_by: 'name',
      match_score: 0.9,
    });
    const s = createScenario({
      api: { lookup: (query) => (query['name'] === 'Ромашка' ? found(romashka) : nothingFound()) },
    });

    const named = await s.say(
      'Мы Ромашка из Шымкента, нужен учёт товара',
      reply(PLAIN, 'none', { companyName: 'Ромашка', companyCity: 'Шымкент' }),
    );
    const next = await s.say(
      'Товар храним на двух складах',
      reply('Спасибо. ТОО Ромашка, Алматы, верно?', 'confirm'),
    );

    // Черновик первой реплики писался до поиска: компания ещё неизвестна.
    expect(named.data('reply')).toContain('Компания клиента неизвестна');
    expect(named.toClient).toEqual([PLAIN]);
    expect(named.api.map((call) => call.query)).toEqual([
      { phone: CLIENT_PHONE },
      { name: 'Ромашка' },
    ]);
    expect(next.api).toEqual([]);
    expect(next.data('reply')).toContain(
      '«ТОО Ромашка, Алматы, верно?» (companyQuestion: confirm)',
    );
    expect(s.state()).toMatchObject({
      statedName: 'Ромашка',
      statedCity: 'Шымкент',
      candidate: { id: 34, source: 'message', askedAtMs: next.atMs, awaitingAnswer: true },
    });
  });
});

describe('сценарии владельца: ответ клиента на вопрос о компании', () => {
  it('5. «Нет, это не мы»: сначала оценка, потом черновик; кандидат сброшен, компания неизвестна и больше не предлагается', async () => {
    const s = createScenario({ api: SKLAD_BY_PHONE });
    await s.say(CLIENT_HELLO, reply(ASK_CONFIRM, 'confirm'));

    const refused = await s.say('Нет, это не мы', reply(ASK_NAME, 'name', { companyAnswer: 'no' }));
    const later = await s.say('Пока не скажу. Как это работает?', reply(HOW_IT_WORKS));

    expect(refused.llm.purposes()).toEqual(['interest', 'reply', 'review']);
    expect(refused.data('interest')).toContain(
      `Бот спросил клиента, из компании ли он «${SKLAD}» (Алматы)`,
    );
    expect(refused.data('reply')).toContain('Компания клиента неизвестна');
    expect(refused.data('reply')).not.toContain(SKLAD);
    expect(refused.toClient).toEqual([ASK_NAME]);
    // Номер снова приводит к той же компании, но клиент от неё отказался: её не предлагают.
    expect(later.data('reply')).toContain(
      'Компания клиента неизвестна. О компании сейчас не спрашивай.',
    );
    expect(later.llm.requests.map(dataOf).join('\n')).not.toContain(SKLAD);
    expect(later.toClient).toEqual([HOW_IT_WORKS]);
    expect(s.state()).toMatchObject({ candidate: null, confirmed: null, rejectedIds: [SKLAD_ID] });
  });

  it('6. новая компания: проверка в очереди, следующая реплика узнаёт статус done, «да» в той же реплике даёт черновику справку без цитат и источников', async () => {
    const s = createScenario({
      api: {
        research: () => json(202, { job_id: JOB_ID, status: 'queued' }),
        status: (jobId) =>
          jobId === JOB_ID
            ? json(200, { status: 'done', brief: BEREKE_BRIEF })
            : json(404, { error: 'not_found' }),
        brief: (id) =>
          id === BEREKE_ID ? json(200, BEREKE_BRIEF) : json(404, { error: 'not_found' }),
      },
    });

    // Город клиент не назвал: проверка идёт в городе по умолчанию, найденную компанию бот уточняет вопросом.
    const named = await s.say('Мы ТОО Береке', reply(PLAIN, 'none', { companyName: BEREKE }));
    const polled = await s.say('Товар храним на одном складе', reply(ASK_BEREKE, 'confirm'));
    const confirmed = await s.say(
      'Да, это мы',
      reply(PAIN_QUESTION, 'none', { companyAnswer: 'yes' }),
    );

    expect(requestLines(named.api)).toEqual([
      'GET /internal/lookup',
      'GET /internal/lookup',
      'POST /internal/research',
    ]);
    expect(named.api[2]?.body).toEqual({
      name: BEREKE,
      aliases: [],
      city: null,
      // Обычный аккаунт: личный номер в проверку новой компании не уходит.
      phone: null,
      domain: null,
    });
    expect(requestLines(polled.api)).toEqual([`GET /internal/research/${JOB_ID}`]);
    expect(polled.data('reply')).toContain(
      `«${BEREKE}, Караганда, верно?» (companyQuestion: confirm)`,
    );
    expect(confirmed.llm.purposes()).toEqual(['interest', 'reply', 'review']);
    expect(requestLines(confirmed.api)).toEqual([`GET /internal/companies/${BEREKE_ID}/brief`]);
    const data = confirmed.data('reply');
    expect(data).toContain(`Компания клиента: «${BEREKE}».`);
    expect(data).toContain('Рубрика: Оптовая торговля.');
    // Обе боли справки, без отбора по разделу 5 knowledge/tanbala-agent.md (решение владельца 30.10.2026).
    expect(data).toContain(
      `Трудности, которые часто бывают у похожих компаний: ${PAIN_INVENTORY}; ${PAIN_MIXUP}.`,
    );
    expect(data).toContain('Мы этой компании на почту не писали: не говори, что писали.');
    const allData = confirmed.llm.requests.map(dataOf).join('\n');
    for (const hidden of [EVIDENCE_SITE, EVIDENCE_2GIS, FIT_REASON, 'site', '2gis', '64']) {
      expect(allData).not.toContain(hidden);
    }
    expect(s.state().confirmed).toMatchObject({ id: BEREKE_ID, name: BEREKE });
  });

  it('7. проверка новой компании отклонена 429: справки нет, бот отвечает как обычно и не запускает её снова', async () => {
    const s = createScenario({ api: { research: () => json(429, { error: 'rate_limited' }) } });

    const named = await s.say(
      'Мы ТОО Береке из Караганды',
      reply(PLAIN, 'none', { companyName: BEREKE, companyCity: 'Караганда' }),
    );
    const next = await s.say('Как это работает?', reply(HOW_IT_WORKS));

    expect(requestLines(named.api).at(-1)).toBe('POST /internal/research');
    expect(s.state().research).toEqual({
      status: 'failed',
      reason: 'rate_limited',
      finishedAtMs: named.atMs,
    });
    expect(next.outcome).toEqual({ kind: 'replied' });
    expect(next.toClient).toEqual([HOW_IT_WORKS]);
    expect(next.api).toEqual([]);
    expect(next.data('reply')).toContain(
      'Компания клиента неизвестна. О компании сейчас не спрашивай.',
    );
    expect(s.state()).toMatchObject({ candidate: null, confirmed: null });
  });

  it('8. после «Вы из компании X?» клиент просит человека: передача снимает ожидание, после возврата боту «да» компанию не подтверждает', async () => {
    const s = createScenario({ api: SKLAD_BY_PHONE });
    await s.say(CLIENT_HELLO, reply(ASK_CONFIRM, 'confirm'));

    const handed = await s.say('Позовите, пожалуйста, человека', {
      replies: [{ outcome: 'asked_human' }],
    });
    const afterHandoff = s.state().candidate;
    await s.services.handoff.returnToBot(s.chatId());
    const yes = await s.say('Да', reply(PLAIN, 'none', { companyAnswer: 'yes' }));

    expect(handed.outcome).toEqual({ kind: 'handed_off', reason: 'asked_human' });
    expect(afterHandoff).toMatchObject({ id: SKLAD_ID, awaitingAnswer: false });
    // Ответа о компании больше не ждут: оценке сказано, что вопроса нет, «да» не засчитывается, справки нет.
    expect(yes.data('interest')).toContain(
      'Бот не ждёт ответа на вопрос «Вы из компании X?»: companyAnswer none.',
    );
    expect(yes.outcome).toEqual({ kind: 'replied' });
    expect(yes.api).toEqual([]);
    expect(s.state()).toMatchObject({ confirmed: null, candidate: { awaitingAnswer: false } });
  });
});

describe('сценарии владельца: вопрос цены', () => {
  it('8. ранний вопрос цены: модель отвечает answer с вопросом о компании, ответ ушёл, передачи нет', async () => {
    const s = createScenario();

    const turn = await s.say('Сколько стоит?', reply(ASK_NAME, 'name'));

    expect(turn.outcome).toEqual({ kind: 'replied' });
    expect(turn.toClient).toEqual([ASK_NAME]);
    expect(turn.toManager).toEqual([]);
    expect(s.storage.handoffs.findOpen(s.chatId())).toBeNull();
    expect(s.storage.chats.getById(s.chatId())?.control).toEqual({ status: 'bot', by: null });
    expect(s.state().nameAskedAtMs).toBe(turn.atMs);
  });

  it('9. цена после согласия с болью, но без числа вещей и 1С: чат у бота; минимум собран: передача hot, в уведомлении компания, карточка, боли и минимум', async () => {
    const s = createScenario({ api: SKLAD_BY_PHONE });
    await s.say(CLIENT_HELLO, reply(ASK_CONFIRM, 'confirm'));
    const yes = await s.say('Да, это мы', reply(PAIN_QUESTION, 'none', { companyAnswer: 'yes' }));
    const agreed = { problemAgreed: true, scope: 'ввоз и вывоз' };

    const early = await s.say('Да, пересорт бывает. Сколько стоит?', {
      ...priceHandoff({ level: 'hot', confirmedPains: [PAIN_MIXUP], profile: agreed }),
      replies: [{ outcome: 'hot', text: PRICE_PHRASE, aboutPrice: true }, ASK_COUNT],
    });
    const price = await s.say(
      'Около 3000 позиций, металлические запчасти на складе в Алматы, 1С есть. Так сколько?',
      priceHandoff({
        level: 'hot',
        profile: {
          ...agreed,
          items: 'запчасти',
          material: 'металл',
          premises: 'склад',
          city: 'Алматы',
          itemCount: 'около 3000',
          has1C: true,
        },
      }),
    );

    expect(yes.data('reply')).toContain(
      'Мы уже писали этой компании на почту: можно один раз сказать «мы писали вам на почту».',
    );
    expect(early.outcome).toEqual({ kind: 'replied' });
    expect(early.toClient).toEqual([ASK_COUNT]);
    expect(early.toManager).toEqual([]);
    expect(price.outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(price.toClient).toEqual([PRICE_PHRASE]);
    expect(s.storage.handoffs.findOpen(s.chatId())).toMatchObject({ reason: 'hot', level: 'hot' });
    expect(price.toManager).toHaveLength(1);
    const notice = price.toManager[0] ?? '';
    expect(notice).toContain('Передача чата менеджеру: горячий клиент.');
    expect(notice).toContain(`Компания: «${SKLAD}», Алматы (подтверждена)`);
    expect(notice).toContain(`Карточка: ${EMAIL_UI_URL}/companies/${SKLAD_ID}`);
    expect(notice).toContain(`Подтверждённые боли: ${PAIN_MIXUP}`);
    // Что для расчёта известно и чего не хватает (решение владельца 30.10.2026).
    expect(notice).toContain(
      'Для расчёта известно: что лежит на хранении, сколько этого примерно, есть ли 1С и какая, город',
    );
    expect(notice).toContain(
      'Для расчёта не хватает: чем занимается клиент, сколько нового приходит в месяц, сколько проходов нужно учитывать',
    );
    expect(notice).toContain('Причина: Спрашивает цену, сроки или договор, задача понятна.');
  });

  it('10. цена второй раз без минимума: модель отвечает hot, но чат остаётся у бота, уходит один вопрос', async () => {
    const s = createScenario();
    const first = await s.say('Сколько стоит?', {
      replies: [{ outcome: 'answer', text: ASK_NAME, companyQuestion: 'name' }],
      interests: [{ priceAsked: true }],
    });

    const second = await s.say('Я же спросил, сколько стоит?', {
      ...priceHandoff({ level: 'hot' }),
      replies: [{ outcome: 'hot', text: PRICE_PHRASE, aboutPrice: true }, ASK_COUNT],
    });

    expect(first.outcome).toEqual({ kind: 'replied' });
    expect(second.outcome).toEqual({ kind: 'replied' });
    expect(second.llm.purposes()).toEqual(['interest', 'reply', 'reply', 'review']);
    expect(second.toClient).toEqual([ASK_COUNT]);
    expect(second.toManager).toEqual([]);
    expect(s.storage.chats.getById(s.chatId())?.control.status).toBe('bot');
    expect(s.storage.chats.getProgress(s.chatId())).toEqual({
      priceAsks: 2,
      refused: false,
      lastStage: 'details',
    });
  });
});

describe('сценарии владельца: API почтового проекта недоступно', () => {
  const CLIENT_NAME = 'Айгерим';
  const CLIENT_TEXT = 'Здравствуйте, у нас склад запчастей';

  it.each<[string, () => ApiAnswer]>([
    ['сеть', () => 'network_error'],
    ['503', () => json(503, { error: 'unavailable' })],
  ])(
    '11. %s: ответ уходит как обычно, клиенту ничего про API, в логе нет номера, адреса, имени, названия, домена и токена',
    async (_case, down) => {
      const s = createScenario({
        profile: { kind: 'business', websites: [`https://${SKLAD_DOMAIN}`], email: null },
        pushName: CLIENT_NAME,
        verifiedName: SKLAD,
        api: { lookup: down, brief: down, research: down, status: down },
      });

      const turn = await s.say(CLIENT_TEXT, reply(PLAIN));

      expect(turn.outcome).toEqual({ kind: 'replied' });
      expect(turn.toClient).toEqual([PLAIN]);
      // Первый сбой включает паузу: остальные шаги поиска в сеть не идут.
      expect(turn.api).toEqual([lookupCall({ domain: SKLAD_DOMAIN })]);
      expect(turn.data('reply')).not.toContain(SKLAD);
      // Шаги не засчитаны: после паузы поиск повторится.
      expect(s.state().freeStepsAtMs).toBeNull();
      expect(s.logs).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          context: { chatId: s.chatId(), step: 'profile_domain', failure: 'unavailable' },
        }),
      );
      const logged = JSON.stringify(s.logs);
      for (const secret of [
        CLIENT_PHONE,
        CLIENT_JID,
        CLIENT_NAME,
        SKLAD,
        SKLAD_DOMAIN,
        API_TOKEN,
        CLIENT_TEXT,
      ]) {
        expect(logged).not.toContain(secret);
      }
    },
  );
});

describe('сценарии владельца: закрытый режим и выключенная функция', () => {
  it('чат вне TEST_ALLOWLIST при TEST_MODE: ни профиля WhatsApp, ни запросов к API, ни вызовов модели', async () => {
    const s = createScenario({
      allowlist: '77000000005',
      profile: { kind: 'business', websites: [`https://${SKLAD_DOMAIN}`], email: null },
      api: SKLAD_BY_PHONE,
    });

    const turn = await s.say(CLIENT_HELLO, reply(PLAIN));

    expect(turn.outcome).toEqual({ kind: 'blocked', reason: 'skipped_test_mode' });
    expect(s.contacts.businessProfile).not.toHaveBeenCalled();
    expect(s.contacts.profilePhoto).not.toHaveBeenCalled();
    expect(s.api).toEqual([]);
    expect(turn.llm.requests).toEqual([]);
    expect(turn.toClient).toEqual([]);
    expect(s.state()).toEqual(emptyCompanyState(s.chatId()));
  });

  it('функция выключена (INTERNAL_API_TOKEN не задан): в данных ответа и проверки нет блока о компании, наружу ни запроса', async () => {
    const s = createScenario({
      api: null,
      profile: { kind: 'business', websites: [`https://${SKLAD_DOMAIN}`], email: null },
    });

    const turn = await s.say(CLIENT_HELLO, reply(PLAIN));

    expect(turn.outcome).toEqual({ kind: 'replied' });
    expect(turn.toClient).toEqual([PLAIN]);
    expect(turn.data('reply')).not.toMatch(/компани/i);
    expect(turn.data('review')).not.toMatch(/компани/i);
    expect(s.contacts.businessProfile).not.toHaveBeenCalled();
    expect(s.contacts.profilePhoto).not.toHaveBeenCalled();
    expect(s.api).toEqual([]);
  });
});
