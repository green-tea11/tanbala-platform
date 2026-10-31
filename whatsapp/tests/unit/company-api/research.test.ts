import { describe, expect, it } from 'vitest';
import type {
  CompanyBrief,
  CompanyId,
  ResearchJobId,
  ResearchRequest,
} from '../../../src/domain/company.js';
import type { PhoneDigits } from '../../../src/domain/types.js';
import { BASE_URL, createHarness, json, TOKEN } from './harness.js';

// POST /internal/research и GET /internal/research/{job_id}: проверка новой компании.

const JOB_ID = '3f2c9e0a-1b2c-4d5e-8f90-a1b2c3d4e5f6' as ResearchJobId;
const PHONE = '77011234567' as PhoneDigits;

const REQUEST: ResearchRequest = {
  name: 'Платформа-А',
  aliases: [],
  city: null,
  phone: null,
  domain: null,
};

const CONTRACT_BRIEF = {
  id: 51,
  name: 'Платформа-А',
  city: 'Алматы',
  rubric: 'Складское хранение',
  segment: null,
  fit: 'yes',
  fit_score: 80,
  reason: 'Подходит',
  pains: [],
  emailed: false,
  emailed_at: null,
  email_subject: null,
};

describe('company-api startResearch: запрос', () => {
  it('POST /internal/research: JSON с name, aliases, city, phone, domain (null для пустых), заголовки по контракту', async () => {
    const h = createHarness();
    h.reply(json(202, { job_id: JOB_ID }));

    await h.directory.startResearch(REQUEST);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.url).toBe(`${BASE_URL}/internal/research`);
    expect(h.sent[0]?.method).toBe('POST');
    expect(h.sent[0]?.headers).toEqual({
      'X-Internal-Token': TOKEN,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(h.sent[0]?.redirect).toBe('manual');
    expect(JSON.parse(h.sent[0]?.body ?? 'null')).toEqual({
      name: 'Платформа-А',
      aliases: [],
      city: null,
      phone: null,
      domain: null,
    });
    expect(Object.keys(JSON.parse(h.sent[0]?.body ?? '{}') as object)).toEqual([
      'name',
      'aliases',
      'city',
      'phone',
      'domain',
    ]);
  });

  it('все поля заполнены: уходят как есть', async () => {
    const h = createHarness();
    h.reply(json(202, { job_id: JOB_ID }));

    await h.directory.startResearch({
      name: 'Тинькофф',
      aliases: ['Т-Банк', 'Tinkoff'],
      city: 'Алматы',
      phone: PHONE,
      domain: 'platforma.kz',
    });

    expect(JSON.parse(h.sent[0]?.body ?? 'null')).toEqual({
      name: 'Тинькофф',
      aliases: ['Т-Банк', 'Tinkoff'],
      city: 'Алматы',
      phone: PHONE,
      domain: 'platforma.kz',
    });
  });

  it('значения обрезаются по краям, пустые city и domain становятся null', async () => {
    const h = createHarness();
    h.reply(json(202, { job_id: JOB_ID }));

    await h.directory.startResearch({
      name: '  Платформа-А \n',
      aliases: ['  Platforma-A ', '  '],
      city: '   ',
      phone: null,
      domain: ' \t ',
    });

    expect(JSON.parse(h.sent[0]?.body ?? 'null')).toEqual({
      name: 'Платформа-А',
      aliases: ['Platforma-A'],
      city: null,
      phone: null,
      domain: null,
    });
  });

  it('варианты названия: пустые и повторы названия или друг друга (без учёта регистра) отбрасываются, не больше трёх', async () => {
    const h = createHarness();
    h.reply(json(202, { job_id: JOB_ID }));

    await h.directory.startResearch({
      ...REQUEST,
      name: 'Тинькофф',
      aliases: ['тинькофф', '', 'Т-Банк', 'т-банк', 'Tinkoff', 'ТОО Т-Банк', 'Тинькофф Банк'],
    });

    expect(JSON.parse(h.sent[0]?.body ?? 'null')).toMatchObject({
      name: 'Тинькофф',
      aliases: ['Т-Банк', 'Tinkoff', 'ТОО Т-Банк'],
    });
  });

  it('длинные значения обрезаются: name до 200, domain до 253, city до 100', async () => {
    const h = createHarness();
    h.reply(json(202, { job_id: JOB_ID }));

    await h.directory.startResearch({
      name: 'н'.repeat(300),
      aliases: ['в'.repeat(300)],
      city: 'г'.repeat(300),
      phone: null,
      domain: 'd'.repeat(300),
    });

    expect(JSON.parse(h.sent[0]?.body ?? 'null')).toEqual({
      name: 'н'.repeat(200),
      aliases: ['в'.repeat(200)],
      city: 'г'.repeat(100),
      phone: null,
      domain: 'd'.repeat(253),
    });
  });

  it('тело запроса меньше предела 8 КБ даже в худшем случае: три варианта, все знаки экранируются в JSON (6 байт)', async () => {
    const h = createHarness();
    h.reply(json(202, { job_id: JOB_ID }));
    const escaped = (mark: number): string => String.fromCodePoint(mark).repeat(300);

    await h.directory.startResearch({
      name: escaped(1),
      aliases: [escaped(2), escaped(3), escaped(4)],
      city: escaped(5),
      phone: PHONE,
      domain: escaped(6),
    });

    const size = Buffer.byteLength(h.sent[0]?.body ?? '');
    expect(size).toBeGreaterThan(6000);
    expect(size).toBeLessThan(8192);
  });
});

describe('company-api startResearch: проверка до сети', () => {
  it.each([
    ['пустое название', { ...REQUEST, name: '' }],
    ['название из пробелов', { ...REQUEST, name: '  \n ' }],
    ['телефон с 8 в начале', { ...REQUEST, phone: '87011234567' as PhoneDigits }],
    ['телефон из 10 цифр', { ...REQUEST, phone: '7701123456' as PhoneDigits }],
    ['телефон с плюсом', { ...REQUEST, phone: '+77011234567' as PhoneDigits }],
    ['пустой телефон', { ...REQUEST, phone: '' as PhoneDigits }],
  ])('%s => bad_request без запроса', async (_case, request) => {
    const h = createHarness();

    expect(await h.directory.startResearch(request)).toEqual({ ok: false, failure: 'bad_request' });
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe('company-api startResearch: ответ', () => {
  it('200 done: компания уже есть и оценена', async () => {
    const h = createHarness();
    h.reply(json(200, { status: 'done', company_id: 8 }));

    expect(await h.directory.startResearch(REQUEST)).toEqual({
      ok: true,
      value: { kind: 'done', companyId: 8 as CompanyId },
    });
  });

  it('202: задача в очереди, job_id из UUID', async () => {
    const h = createHarness();
    h.reply(json(202, { job_id: JOB_ID }));

    expect(await h.directory.startResearch(REQUEST)).toEqual({
      ok: true,
      value: { kind: 'queued', jobId: JOB_ID },
    });
  });

  it('лишние поля не мешают', async () => {
    const h = createHarness();
    h.reply(json(202, { job_id: JOB_ID, queue_position: 2 }));

    expect(await h.directory.startResearch(REQUEST)).toEqual({
      ok: true,
      value: { kind: 'queued', jobId: JOB_ID },
    });
  });

  it.each([
    ['429 rate_limited', 429, { error: 'rate_limited' }, 'rate_limited'],
    ['429 budget_exhausted', 429, { error: 'budget_exhausted' }, 'budget_exhausted'],
    ['400 bad_request', 400, { error: 'bad_request' }, 'bad_request'],
    ['401 unauthorized', 401, { error: 'unauthorized' }, 'unauthorized'],
    ['503 db_unavailable', 503, { error: 'db_unavailable' }, 'unavailable'],
  ])('%s => %s', async (_case, status, body, failure) => {
    const h = createHarness();
    h.reply(json(status, body));

    expect(await h.directory.startResearch(REQUEST)).toEqual({ ok: false, failure });
  });

  it.each([
    ['200 без company_id', 200, { status: 'done' }],
    ['200 с другим status', 200, { status: 'queued', company_id: 8 }],
    ['200 с job_id вместо company_id', 200, { job_id: JOB_ID }],
    ['200 company_id ноль', 200, { status: 'done', company_id: 0 }],
    ['200 company_id строкой', 200, { status: 'done', company_id: '8' }],
    ['202 без job_id', 202, {}],
    ['202 с company_id вместо job_id', 202, { status: 'done', company_id: 8 }],
    ['202 job_id не строка', 202, { job_id: 17 }],
    ['202 пустой job_id', 202, { job_id: '' }],
    ['202 job_id длиннее 100', 202, { job_id: 'a'.repeat(101) }],
    ['202 job_id с запрещёнными символами', 202, { job_id: 'abc/../x' }],
    ['202 job_id с пробелом', 202, { job_id: 'abc def' }],
    ['202 job_id с кириллицей', 202, { job_id: 'абв' }],
    ['не объект', 202, 'text'],
  ])('%s => invalid_response', async (_case, status, body) => {
    const h = createHarness();
    h.reply(json(status, body));

    expect(await h.directory.startResearch(REQUEST)).toEqual({
      ok: false,
      failure: 'invalid_response',
    });
  });

  it('job_id на границе 100 символов из букв, цифр и дефиса принимается', async () => {
    const h = createHarness();
    const jobId = `${'aZ09-'.repeat(20)}`;
    h.reply(json(202, { job_id: jobId }));

    expect(await h.directory.startResearch(REQUEST)).toEqual({
      ok: true,
      value: { kind: 'queued', jobId },
    });
  });
});

describe('company-api researchStatus: запрос', () => {
  it('GET /internal/research/{job_id} с токеном и Accept, без тела', async () => {
    const h = createHarness();
    h.reply(json(200, { status: 'running', company_id: null, brief: null, reason: null }));

    await h.directory.researchStatus(JOB_ID);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.url).toBe(`${BASE_URL}/internal/research/${JOB_ID}`);
    expect(h.sent[0]?.method).toBe('GET');
    expect(h.sent[0]?.headers).toEqual({ 'X-Internal-Token': TOKEN, Accept: 'application/json' });
    expect(h.sent[0]?.body).toBeUndefined();
  });

  it.each([
    ['пустой', ''],
    ['с косой чертой', 'abc/../secret'],
    ['с вопросом', 'abc?x=1'],
    ['с пробелом', 'abc def'],
    ['длиннее 100', 'a'.repeat(101)],
    ['с кириллицей', 'абв'],
  ])('job_id %s => bad_request без запроса', async (_case, jobId) => {
    const h = createHarness();

    const result = await h.directory.researchStatus(jobId as ResearchJobId);

    expect(result).toEqual({ ok: false, failure: 'bad_request' });
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe('company-api researchStatus: ответ', () => {
  it.each(['queued', 'running'] as const)('%s', async (status) => {
    const h = createHarness();
    h.reply(json(200, { status, company_id: null, brief: null, reason: null }));

    expect(await h.directory.researchStatus(JOB_ID)).toEqual({ ok: true, value: { status } });
  });

  it('done: справка из ответа разбирается так же, как у /brief', async () => {
    const h = createHarness();
    h.reply(json(200, { status: 'done', company_id: 51, brief: CONTRACT_BRIEF, reason: null }));

    const result = await h.directory.researchStatus(JOB_ID);

    const expected: Partial<CompanyBrief> = {
      id: 51 as CompanyId,
      name: 'Платформа-А',
      fit: 'yes',
      fitScore: 80,
      pains: [],
    };
    expect(result).toEqual({
      ok: true,
      value: { status: 'done', brief: expect.objectContaining(expected) as unknown },
    });
  });

  it.each([
    ['not_in_2gis', 'not_in_2gis'],
    ['city_unsupported', 'city_unsupported'],
    ['budget_exhausted', 'budget_exhausted'],
    ['error', 'error'],
  ])('failed с причиной %s', async (reason, expected) => {
    const h = createHarness();
    h.reply(json(200, { status: 'failed', company_id: null, brief: null, reason }));

    expect(await h.directory.researchStatus(JOB_ID)).toEqual({
      ok: true,
      value: { status: 'failed', reason: expected },
    });
  });

  it.each([
    ['причины нет в ответе', { status: 'failed' }],
    ['причина null', { status: 'failed', reason: null }],
    ['причина неизвестная', { status: 'failed', reason: 'new_reason' }],
    ['причина не строка', { status: 'failed', reason: 5 }],
  ])('failed: %s => reason null (поле необязательное)', async (_case, body) => {
    const h = createHarness();
    h.reply(json(200, body));

    expect(await h.directory.researchStatus(JOB_ID)).toEqual({
      ok: true,
      value: { status: 'failed', reason: null },
    });
  });

  it('not_found: задачи нет, HTTP 200 всё равно', async () => {
    const h = createHarness();
    h.reply(json(200, { status: 'not_found', company_id: null, brief: null }));

    expect(await h.directory.researchStatus(JOB_ID)).toEqual({
      ok: true,
      value: { status: 'not_found' },
    });
  });

  it.each([
    ['статус неизвестный', { status: 'finished' }],
    ['нет статуса', {}],
    ['статус не строка', { status: 1 }],
    ['done без справки', { status: 'done', company_id: 51, brief: null }],
    ['done без поля brief', { status: 'done', company_id: 51 }],
    ['done со справкой не по схеме', { status: 'done', brief: { id: 'x' } }],
    ['не объект', 'done'],
    ['null', null],
  ])('%s => invalid_response', async (_case, body) => {
    const h = createHarness();
    h.reply(json(200, body));

    expect(await h.directory.researchStatus(JOB_ID)).toEqual({
      ok: false,
      failure: 'invalid_response',
    });
  });

  it('202 вместо 200 на статусе: ответ не по контракту', async () => {
    const h = createHarness();
    h.reply(json(202, { status: 'queued' }));

    expect(await h.directory.researchStatus(JOB_ID)).toEqual({
      ok: false,
      failure: 'invalid_response',
    });
  });
});
