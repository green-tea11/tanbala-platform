import { describe, expect, it } from 'vitest';
import type { CompanyCandidate, CompanyId } from '../../../src/domain/company.js';
import type { PhoneDigits } from '../../../src/domain/types.js';
import { BASE_URL, createHarness, json, TOKEN } from './harness.js';

// GET /internal/lookup: один признак за вызов, кандидаты по контракту INTERNAL_API.md.

const PHONE = '77011234567' as PhoneDigits;
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const NUL = String.fromCodePoint(0);
const FULLWIDTH_TOO = String.fromCodePoint(0xff34, 0xff2f, 0xff2f);

const CONTRACT_CANDIDATE = {
  id: 8,
  name: 'Платформа-А',
  city: 'Алматы',
  rubric: 'Складское хранение',
  match_by: 'domain',
  match_score: 1.0,
  emailed: false,
  emailed_at: null,
};

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...CONTRACT_CANDIDATE, ...overrides };
}

function found(...candidates: readonly Record<string, unknown>[]): Response {
  return json(200, { candidates });
}

describe('company-api lookup: запрос', () => {
  it.each([
    [
      'domain',
      { by: 'domain', domain: 'sklad.kz' } as const,
      `${BASE_URL}/internal/lookup?domain=sklad.kz`,
    ],
    ['phone', { by: 'phone', phone: PHONE } as const, `${BASE_URL}/internal/lookup?phone=${PHONE}`],
    [
      'name',
      { by: 'name', name: 'Платформа-А' } as const,
      `${BASE_URL}/internal/lookup?name=${encodeURIComponent('Платформа-А')}`,
    ],
  ])('по %s: GET с одним параметром', async (_by, query, url) => {
    const h = createHarness();
    h.reply(found());

    await h.directory.lookup(query);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.url).toBe(url);
    expect(h.sent[0]?.method).toBe('GET');
    expect(h.sent[0]?.body).toBeUndefined();
  });

  it('заголовки: токен и Accept; у GET нет Content-Type; редиректы не выполняются', async () => {
    const h = createHarness();
    h.reply(found());

    await h.directory.lookup({ by: 'domain', domain: 'sklad.kz' });

    expect(h.sent[0]?.headers).toEqual({
      'X-Internal-Token': TOKEN,
      Accept: 'application/json',
    });
    expect(h.sent[0]?.redirect).toBe('manual');
  });

  it('значение кодируется целиком: пробелы, амперсанд, решётка, знак равенства, процент', async () => {
    const h = createHarness();
    h.reply(found());

    await h.directory.lookup({ by: 'name', name: 'ТОО «Zeta & Co» #1=100% a+b' });

    const url = h.sent[0]?.url ?? '';
    expect(url.startsWith(`${BASE_URL}/internal/lookup?name=`)).toBe(true);
    const query = url.slice(url.indexOf('?') + 1);
    expect(query.split('&')).toHaveLength(1);
    expect(new URLSearchParams(query).get('name')).toBe('ТОО «Zeta & Co» #1=100% a+b');
    expect(query).not.toMatch(/[ #+]/);
  });

  it('базовый адрес с хвостовым слэшем не даёт двойного слэша', async () => {
    const h = createHarness({ baseUrl: `${BASE_URL}/` });
    h.reply(found());

    await h.directory.lookup({ by: 'domain', domain: 'sklad.kz' });

    expect(h.sent[0]?.url).toBe(`${BASE_URL}/internal/lookup?domain=sklad.kz`);
  });
});

describe('company-api lookup: проверка до сети', () => {
  it.each([
    ['пустое название', { by: 'name', name: '' } as const],
    ['название из пробелов', { by: 'name', name: ' \t\n ' } as const],
    ['пустой домен', { by: 'domain', domain: '' } as const],
    ['домен из пробелов', { by: 'domain', domain: '   ' } as const],
    ['телефон с плюсом', { by: 'phone', phone: '+77011234567' as PhoneDigits } as const],
    ['телефон с 8 в начале', { by: 'phone', phone: '87011234567' as PhoneDigits } as const],
    ['телефон из 10 цифр', { by: 'phone', phone: '7701123456' as PhoneDigits } as const],
    ['телефон из 12 цифр', { by: 'phone', phone: '770112345678' as PhoneDigits } as const],
    ['телефон с буквой', { by: 'phone', phone: '7701123456a' as PhoneDigits } as const],
    ['пустой телефон', { by: 'phone', phone: '' as PhoneDigits } as const],
  ])('%s => bad_request без запроса', async (_case, query) => {
    const h = createHarness();

    const result = await h.directory.lookup(query);

    expect(result).toEqual({ ok: false, failure: 'bad_request' });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('название обрезается по краям и до 200 символов (по символам, пары не рвутся)', async () => {
    const h = createHarness();
    h.reply(found(), found());
    const emoji = String.fromCodePoint(0x1f600);

    await h.directory.lookup({ by: 'name', name: `  ${'а'.repeat(250)}  ` });
    await h.directory.lookup({ by: 'name', name: emoji.repeat(250) });

    const [first, second] = h.sent.map((request) =>
      new URLSearchParams(request.url.slice(request.url.indexOf('?') + 1)).get('name'),
    );
    expect(first).toBe('а'.repeat(200));
    expect(second).toBe(emoji.repeat(200));
  });

  it('домен обрезается по краям и до 253 символов', async () => {
    const h = createHarness();
    h.reply(found(), found());

    await h.directory.lookup({ by: 'domain', domain: '  sklad.kz\n' });
    await h.directory.lookup({ by: 'domain', domain: 'd'.repeat(300) });

    const [first, second] = h.sent.map((request) => request.url.split('domain=')[1]);
    expect(first).toBe('sklad.kz');
    expect(second).toBe('d'.repeat(253));
  });
});

describe('company-api lookup: ответ', () => {
  it('пример из контракта разбирается в кандидата', async () => {
    const h = createHarness();
    h.reply(found(CONTRACT_CANDIDATE));

    const result = await h.directory.lookup({ by: 'domain', domain: 'platforma.kz' });

    const expected: CompanyCandidate = {
      id: 8 as CompanyId,
      name: 'Платформа-А',
      city: 'Алматы',
      rubric: 'Складское хранение',
      matchBy: 'domain',
      matchScore: 1,
      emailed: false,
    };
    expect(result).toEqual({ ok: true, value: [expected] });
  });

  it('ничего не нашлось: пустой список, это успех', async () => {
    const h = createHarness();
    h.reply(found());

    expect(await h.directory.lookup({ by: 'phone', phone: PHONE })).toEqual({
      ok: true,
      value: [],
    });
  });

  it('порядок кандидатов сохраняется, лишние поля не мешают, city и rubric могут быть null', async () => {
    const h = createHarness();
    h.reply(
      found(
        candidate({ id: 3, match_by: 'phone', city: null, rubric: null, extra: { x: 1 } }),
        candidate({ id: 5, match_by: 'name', match_score: 0.81, emailed: true }),
      ),
    );

    const result = await h.directory.lookup({ by: 'name', name: 'Платформа' });

    expect(result).toEqual({
      ok: true,
      value: [
        expect.objectContaining({ id: 3, matchBy: 'phone', city: null, rubric: null }),
        expect.objectContaining({ id: 5, matchBy: 'name', matchScore: 0.81, emailed: true }),
      ],
    });
    expect(JSON.stringify(result)).not.toContain('extra');
  });

  it.each([0, 0.63, 0.9, 1])('match_score %s на отрезке 0..1 принимается', async (score) => {
    const h = createHarness();
    h.reply(found(candidate({ match_score: score })));

    const result = await h.directory.lookup({ by: 'name', name: 'Платформа' });

    expect(result).toEqual({
      ok: true,
      value: [expect.objectContaining({ matchScore: score })],
    });
  });

  it('больше трёх кандидатов: остаются первые три', async () => {
    const h = createHarness();
    h.reply(found(...[1, 2, 3, 4, 5].map((id) => candidate({ id }))));

    const result = await h.directory.lookup({ by: 'name', name: 'Платформа' });

    expect(result.ok && result.value.map((item) => item.id)).toEqual([1, 2, 3]);
  });

  it('кандидат без названия после очистки отбрасывается, остальные остаются', async () => {
    const h = createHarness();
    h.reply(
      found(
        candidate({ id: 1, name: '' }),
        candidate({ id: 2, name: ` ${ZERO_WIDTH_SPACE}${NUL} ` }),
        candidate({ id: 3, name: 'Ромашка' }),
      ),
    );

    const result = await h.directory.lookup({ by: 'name', name: 'Ромашка' });

    expect(result.ok && result.value.map((item) => item.id)).toEqual([3]);
  });

  it('строки недоверенные: NFKC, управляющие и невидимые символы убраны, края обрезаны', async () => {
    const h = createHarness();
    h.reply(
      found(
        candidate({
          name: `  ${FULLWIDTH_TOO}${ZERO_WIDTH_SPACE} Ромашка\n${NUL} `,
          city: ` Алматы${ZERO_WIDTH_SPACE}`,
          rubric: `\t${NUL}Склад${ZERO_WIDTH_SPACE}`,
        }),
      ),
    );

    const result = await h.directory.lookup({ by: 'name', name: 'Ромашка' });

    expect(result).toEqual({
      ok: true,
      value: [expect.objectContaining({ name: 'TOO Ромашка', city: 'Алматы', rubric: 'Склад' })],
    });
  });

  it('пустые city и rubric после очистки становятся null', async () => {
    const h = createHarness();
    h.reply(found(candidate({ city: '  ', rubric: ZERO_WIDTH_SPACE })));

    const result = await h.directory.lookup({ by: 'name', name: 'Ромашка' });

    expect(result).toEqual({
      ok: true,
      value: [expect.objectContaining({ city: null, rubric: null })],
    });
  });

  it('длины по контракту: name и rubric до 200, city до 100', async () => {
    const h = createHarness();
    h.reply(
      found(candidate({ name: 'н'.repeat(500), rubric: 'р'.repeat(500), city: 'г'.repeat(500) })),
    );

    const result = await h.directory.lookup({ by: 'name', name: 'Ромашка' });

    expect(result).toEqual({
      ok: true,
      value: [
        expect.objectContaining({
          name: 'н'.repeat(200),
          rubric: 'р'.repeat(200),
          city: 'г'.repeat(100),
        }),
      ],
    });
  });

  it('id приводится к CompanyId только из положительного целого', async () => {
    const h = createHarness();
    h.reply(found(candidate({ id: 9_007_199_254_740_991 })));

    const result = await h.directory.lookup({ by: 'name', name: 'Ромашка' });

    expect(result.ok && result.value[0]?.id).toBe(9_007_199_254_740_991);
  });
});

describe('company-api lookup: ответ не по схеме => invalid_response', () => {
  it.each([
    ['не объект', 'text'],
    ['null', null],
    ['массив', []],
    ['нет candidates', {}],
    ['candidates не массив', { candidates: 'x' }],
    ['кандидат не объект', { candidates: [1] }],
    ['id ноль', { candidates: [candidate({ id: 0 })] }],
    ['id отрицательный', { candidates: [candidate({ id: -4 })] }],
    ['id дробный', { candidates: [candidate({ id: 1.5 })] }],
    ['id строкой', { candidates: [candidate({ id: '8' })] }],
    ['id больше безопасного целого', { candidates: [candidate({ id: 2 ** 53 })] }],
    ['name не строка', { candidates: [candidate({ name: 7 })] }],
    ['нет name', { candidates: [candidate({ name: undefined })] }],
    ['city числом', { candidates: [candidate({ city: 3 })] }],
    ['нет city', { candidates: [candidate({ city: undefined })] }],
    ['нет rubric', { candidates: [candidate({ rubric: undefined })] }],
    ['match_by неизвестный', { candidates: [candidate({ match_by: 'email' })] }],
    ['match_score строкой', { candidates: [candidate({ match_score: '1.0' })] }],
    ['match_score больше 1', { candidates: [candidate({ match_score: 1.4 })] }],
    ['match_score отрицательный', { candidates: [candidate({ match_score: -0.2 })] }],
    ['match_score как проценты', { candidates: [candidate({ match_score: 90 })] }],
    ['emailed строкой', { candidates: [candidate({ emailed: 'false' })] }],
    ['второй кандидат испорчен', { candidates: [candidate(), candidate({ id: 'x' })] }],
  ])('%s', async (_case, body) => {
    const h = createHarness();
    h.reply(json(200, body));

    const result = await h.directory.lookup({ by: 'name', name: 'Ромашка' });

    expect(result).toEqual({ ok: false, failure: 'invalid_response' });
  });
});
