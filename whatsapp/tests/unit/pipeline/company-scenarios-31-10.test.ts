import { describe, expect, it } from 'vitest';
import type { ClientProfile } from '../../../src/domain/types.js';
import {
  createScenario,
  json,
  nothingFound,
  type ApiAnswer,
  type ApiCall,
} from './company-scenarios-harness.js';
import type { InterestScript, LlmScript, ReplyScript } from './scripted-llm.js';

// Решения владельца 30.10.2026 о компании клиента на моках (живой тест 30.10: «Тинькофф, банки», в 2ГИС бренд уже
// «Т-Банк»). Реплики клиента идут через очередь склейки, конвейер, настоящие агент, сервис компании, клиент
// внутреннего API и базу; поддельные только модель, WhatsApp и проект B. Проверяется видимое: что ушло клиенту, какие
// запросы ушли бы в API и что система передала модели в блоке данных.

const T_BANK_ID = 77;
const T_BANK = 'Т-Банк';
const PAIN_ARCHIVE = 'Нужное дело в архиве ищут перебором полок';
const PAIN_INVENTORY = 'Инвентаризация занимает дни и отрывает людей от работы';
const EVIDENCE = 'Архив кредитных дел в отделениях';

const INTRO =
  'Здравствуйте! Мы в Tanbala ставим учёт на RFID-метках под ключ. Расскажите, из какой вы компании и чем она занимается?';
const HOOK =
  'Спасибо! В банках на хранении обычно много всего, архив с делами, запас техники и расходников, и ручной пересчёт отнимает у сотрудников дни. С метками на это уходят часы, достаточно пройти вдоль полок со сканером. Вы уже знаете, как работает RFID и что мы предлагаем?';
const EXPLAIN =
  'Всё просто. На каждый товар на хранении клеится метка. Антенны на входе и выходе считывают метки и сами отмечают, что пришло и что ушло, всю партию сразу. Данные уходят в вашу 1С, интеграцию делает наш сотрудник. Расскажите, что у вас лежит на хранении и как сейчас проходит проверка?';

const ASK_T_BANK =
  'Всё просто. На каждый товар на хранении клеится метка, а антенны на входе и выходе сами отмечают, что пришло и что ушло. Т-Банк, Алматы, верно?';
const DETAILS =
  'Спасибо! Ручной пересчёт архива и запасов обычно отнимает дни, а со сканером на это уходят часы. Расскажите, что у вас лежит на хранении и как сейчас проходит проверка?';

const BANK: Partial<ClientProfile> = { business: 'банк' };

function turn(reply: ReplyScript, interest: InterestScript = {}): LlmScript {
  return { replies: [reply], interests: [{ level: 'warm', ...interest }] };
}

function answer(
  text: string,
  stage: 'intro' | 'hook' | 'explain' | 'details',
  companyQuestion: 'none' | 'name' | 'confirm' = 'none',
): ReplyScript {
  return { outcome: 'answer', text, stage, companyQuestion };
}

function tBankBrief(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    id: T_BANK_ID,
    name: T_BANK,
    city: 'Алматы',
    rubric: 'Банки',
    segment: 'Офис, компания с большим имуществом',
    fit: 'yes',
    fit_score: 70,
    reason: 'Много отделений и архив',
    pains: [
      { pain: PAIN_ARCHIVE, evidence: EVIDENCE, source: 'site' },
      { pain: PAIN_INVENTORY, evidence: 'Склад расходников', source: '2gis' },
    ],
    emailed: false,
    emailed_at: null,
    email_subject: null,
    ...overrides,
  };
}

/** Проект B знает Т-Банк в Алматы только под новым названием: по «Тинькофф» поиск пуст. */
function tBankLookup(query: Readonly<Record<string, string>>): ApiAnswer {
  if (query['name'] !== T_BANK) return nothingFound();
  return json(200, {
    candidates: [
      {
        id: T_BANK_ID,
        name: T_BANK,
        city: 'Алматы',
        rubric: 'Банки',
        match_by: 'name',
        match_score: 0.9,
        emailed: false,
      },
    ],
  });
}

function requestLines(calls: readonly ApiCall[]): string[] {
  return calls.map((call) => `${call.method} ${call.path} ${JSON.stringify(call.query)}`);
}

const JOB_ID = '5a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const SEARCHING =
  'Клиент назвал свою компанию, система ищет данные о ней, пока их нет. Боль бери из знаний по бизнесу клиента.';

describe('31.10: пока идёт проверка новой компании', () => {
  it('ответ видит, что данных пока нет и боль из знаний; справка пришла: со следующего ответа боли компании', async () => {
    let status: 'running' | 'done' = 'running';
    const s = createScenario({
      api: {
        research: () => json(202, { job_id: JOB_ID }),
        status: () =>
          json(200, status === 'done' ? { status, brief: tBankBrief() } : { status, brief: null }),
        brief: () => json(200, tBankBrief()),
      },
    });

    await s.say('Здравствуйте', turn(answer(INTRO, 'intro', 'name')));
    const named = await s.say(
      'Т-Банк, Алматы',
      turn(answer(HOOK, 'hook'), { companyName: T_BANK, companyCity: 'Алматы', profile: BANK }),
    );
    const waiting = await s.say('Нет, расскажите подробнее', turn(answer(EXPLAIN, 'explain')));
    status = 'done';
    const ready = await s.say('Склад и архив', turn(answer(HOOK, 'details')));

    expect(named.api.at(-1)?.path).toBe('/internal/research');
    expect(waiting.data('reply')).toContain(SEARCHING);
    expect(waiting.data('reply')).not.toContain(PAIN_ARCHIVE);
    // Проверка нашла компанию в городе клиента: подтверждена без вопроса, справка запрошена в этом же ходе.
    expect(requestLines(ready.api)).toEqual([
      `GET /internal/research/${JOB_ID} {}`,
      `GET /internal/companies/${T_BANK_ID}/brief {}`,
    ]);
    expect(ready.data('reply')).not.toContain(SEARCHING);
    expect(ready.data('reply')).toContain(PAIN_ARCHIVE);
  });
});

const OFFICIAL_JOB_ID = '6b2f3c4d-5e6f-4a71-8b9c-0d1e2f3a4b5c';
const ASK_OFFICIAL =
  'Всё просто. На каждую вещь на хранении клеится метка, а антенны на входе и выходе сами отмечают, что пришло и что ушло. Подскажите, как компания называется официально?';
const OFFICIAL_LINE = '«Подскажите, как компания называется официально?» (companyQuestion: name)';
const NOT_FOUND =
  'Компанию клиента найти не удалось. О компании больше не спрашивай и ничего о ней не утверждай. Боль бери из знаний по бизнесу клиента.';

describe('31.10: проверка новой компании ничего не нашла', () => {
  it('один вопрос об официальном названии, вторая проверка по ответу, снова ничего: боли отрасли, о компании больше не спрашивать', async () => {
    const s = createScenario({
      api: {
        research: (body) =>
          json(202, {
            job_id: (body as { name: string }).name === 'Тинькофф' ? JOB_ID : OFFICIAL_JOB_ID,
          }),
        status: () => json(200, { status: 'failed', brief: null, reason: 'not_in_2gis' }),
      },
    });

    await s.say('Здравствуйте', turn(answer(INTRO, 'intro', 'name')));
    const named = await s.say(
      'Тинькофф, банки',
      turn(answer(HOOK, 'hook'), {
        companyName: 'Тинькофф',
        companyAliases: [T_BANK, 'Tinkoff'],
        profile: BANK,
      }),
    );
    const asked = await s.say(
      'Нет, расскажите подробнее',
      turn(answer(ASK_OFFICIAL, 'explain', 'name')),
    );
    const official = await s.say(
      'АО Тинькофф Банк',
      turn(answer(EXPLAIN, 'explain'), { companyName: 'АО Тинькофф Банк' }),
    );
    const after = await s.say('Склад и архив', turn(answer(HOOK, 'details')));
    const later = await s.say('Интересно, а что дальше?', turn(answer(EXPLAIN, 'details')));

    // Первая проверка: по названию клиента и его вариантам.
    expect(named.api.filter((call) => call.method === 'POST').map((call) => call.body)).toEqual([
      { name: 'Тинькофф', aliases: [T_BANK, 'Tinkoff'], city: null, phone: null, domain: null },
    ]);
    // Проверка ничего не нашла: один раз спросить официальное название.
    expect(asked.data('reply')).toContain(OFFICIAL_LINE);
    expect(asked.toClient).toEqual([ASK_OFFICIAL]);
    expect(s.state().officialNameAskedAtMs).toBe(asked.atMs);
    // Клиент назвал официальное название: поиск и вторая, последняя проверка по нему.
    expect(official.data('reply')).not.toContain(OFFICIAL_LINE);
    expect(official.api.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /internal/lookup',
      'POST /internal/research',
    ]);
    expect(official.api[1]?.body).toMatchObject({ name: 'АО Тинькофф Банк' });
    // Снова ничего: о компании больше не спрашивать, боль из отрасли.
    for (const reply of [after, later]) {
      expect(reply.data('reply')).toContain(NOT_FOUND);
      expect(reply.data('reply')).not.toMatch(/официально|companyQuestion: name/u);
    }
    expect(later.api).toEqual([]);
    expect(s.api.filter((call) => call.method === 'POST')).toHaveLength(2);
    expect(s.state()).toMatchObject({
      research: { status: 'failed', reason: 'not_in_2gis' },
      officialResearchStartedAtMs: official.atMs,
    });
  });
});

describe('31.10: «Тинькофф, банки», в базе почты бренд «Т-Банк»', () => {
  it('поиск по «Тинькофф» пуст, по варианту «Т-Банк» найден: бот спрашивает «Т-Банк, Алматы, верно?», после «да» ответ видит боли справки (ревью этапа 3)', async () => {
    const s = createScenario({
      api: {
        lookup: tBankLookup,
        brief: (id) =>
          id === T_BANK_ID ? json(200, tBankBrief()) : json(404, { error: 'not_found' }),
      },
    });

    await s.say('Здравствуйте', turn(answer(INTRO, 'intro', 'name')));
    const named = await s.say(
      'Тинькофф, банки',
      turn(answer(HOOK, 'hook'), {
        companyName: 'Тинькофф',
        companyAliases: [T_BANK, 'Tinkoff'],
        profile: BANK,
      }),
    );

    // Совпал только вариант от модели, город клиент не называл: кандидат, справки до «да» нет.
    expect(named.toClient).toEqual([HOOK]);
    expect(requestLines(named.api)).toEqual([
      'GET /internal/lookup {"name":"Тинькофф"}',
      `GET /internal/lookup {"name":"${T_BANK}"}`,
    ]);
    expect(s.state()).toMatchObject({
      statedName: 'Тинькофф',
      confirmed: null,
      candidate: { id: T_BANK_ID, source: 'message' },
    });

    const asked = await s.say(
      'Нет, расскажите подробнее',
      turn(answer(ASK_T_BANK, 'explain', 'confirm')),
    );
    expect(asked.data('reply')).toMatch(/верно\?/u);
    expect(asked.toClient).toEqual([ASK_T_BANK]);

    const yes = await s.say(
      'Да, это мы',
      turn(answer(DETAILS, 'details'), { companyAnswer: 'yes' }),
    );
    expect(s.state()).toMatchObject({ candidate: null, confirmed: { id: T_BANK_ID } });
    expect(yes.data('reply')).toContain(
      `Трудности, которые часто бывают у похожих компаний: ${PAIN_ARCHIVE}; ${PAIN_INVENTORY}.`,
    );
    expect(yes.toClient).toEqual([DETAILS]);
  });
});

const TOLD_EMAIL =
  'Мы писали вам на почту, рады продолжить здесь. На каждую вещь на хранении клеится метка, а антенны на входе и выходе сами отмечают, что пришло и что ушло. Расскажите, что у вас лежит на хранении?';
const EMAIL_ALLOWED =
  'Мы уже писали этой компании на почту: можно один раз сказать «мы писали вам на почту».';
const EMAIL_TOLD =
  'Мы писали этой компании на почту, и ты уже сказал об этом клиенту: сам не повторяй, на прямой вопрос клиента можно коротко подтвердить.';

describe('31.10: «мы писали вам на почту» один раз', () => {
  it('компания подтверждена, мы ей писали: фраза разрешена один раз, после неё блок просит не повторять', async () => {
    const s = createScenario({
      api: {
        lookup: tBankLookup,
        brief: () =>
          json(200, tBankBrief({ emailed: true, emailed_at: '2026-10-20T10:00:00+00:00' })),
      },
    });

    await s.say('Здравствуйте', turn(answer(INTRO, 'intro', 'name')));
    await s.say(
      'Т-Банк, Алматы',
      turn(answer(HOOK, 'hook'), { companyName: T_BANK, companyCity: 'Алматы', profile: BANK }),
    );
    const told = await s.say('Нет, расскажите подробнее', turn(answer(TOLD_EMAIL, 'explain')));
    const next = await s.say('Склад и архив', turn(answer(EXPLAIN, 'details')));
    const later = await s.say('Около 10 тысяч дел', turn(answer(HOOK, 'details')));

    expect(told.data('reply')).toContain(EMAIL_ALLOWED);
    expect(told.toClient).toEqual([TOLD_EMAIL]);
    expect(s.state().emailToldAtMs).toBe(told.atMs);
    for (const reply of [next, later]) {
      expect(reply.data('reply')).toContain(EMAIL_TOLD);
      expect(reply.data('reply')).not.toContain('можно один раз сказать');
    }
    expect(s.state().emailToldAtMs).toBe(told.atMs);
  });
});
