import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCompanyDirectory } from '../../../src/company-api/directory.js';
import type { CompanyId, ResearchJobId } from '../../../src/domain/company.js';
import { SafeError } from '../../../src/shared/safe-error.js';
import { createFakeLogger, type LogEntry } from '../../helpers/fake-logger.js';
import {
  BASE_URL,
  chunked,
  createHarness,
  hanging,
  json,
  networkError,
  plain,
  START_MS,
  TOKEN,
  type Harness,
  type Reply,
  type Responder,
} from './harness.js';

// Транспорт: статусы HTTP, таймаут, предел тела, пауза после сбоя и записи в лог.

const MINUTE_MS = 60_000;
const ENCODER = new TextEncoder();
const EMPTY_LOOKUP = { candidates: [] };
const SECRET_DOMAIN = 'secret-company-domain.kz';

afterEach(() => {
  vi.useRealTimers();
});

function lookup(h: Harness) {
  return h.directory.lookup({ by: 'domain', domain: SECRET_DOMAIN });
}

/** Тело ответа ровно нужного размера в байтах: валидный JSON с набивкой. */
function bodyOfSize(bytes: number): Uint8Array {
  const base = JSON.stringify({ candidates: [], pad: '' });
  const pad = 'x'.repeat(bytes - Buffer.byteLength(base));
  return ENCODER.encode(JSON.stringify({ candidates: [], pad }));
}

describe('company-api транспорт: статусы HTTP', () => {
  it('400 приходит текстом (неверный Host), не JSON => bad_request', async () => {
    const h = createHarness();
    h.reply(plain(400, 'Invalid host header'));

    expect(await lookup(h)).toEqual({ ok: false, failure: 'bad_request' });
  });

  it('400 с JSON => bad_request', async () => {
    const h = createHarness();
    h.reply(json(400, { error: 'bad_request' }));

    expect(await lookup(h)).toEqual({ ok: false, failure: 'bad_request' });
  });

  it('401 => unauthorized', async () => {
    const h = createHarness();
    h.reply(json(401, { error: 'unauthorized' }));

    expect(await lookup(h)).toEqual({ ok: false, failure: 'unauthorized' });
  });

  it('404 => not_found', async () => {
    const h = createHarness();
    h.reply(json(404, { error: 'not_found' }));

    expect(await lookup(h)).toEqual({ ok: false, failure: 'not_found' });
  });

  it.each([
    ['budget_exhausted', json(429, { error: 'budget_exhausted' }), 'budget_exhausted'],
    ['rate_limited', json(429, { error: 'rate_limited' }), 'rate_limited'],
    ['пустой объект', json(429, {}), 'rate_limited'],
    ['неизвестный код', json(429, { error: 'new_code' }), 'rate_limited'],
    ['код не строка', json(429, { error: 7 }), 'rate_limited'],
    ['не JSON', plain(429, 'Too Many Requests'), 'rate_limited'],
    ['пустое тело', plain(429, ''), 'rate_limited'],
    ['JSON null', json(429, null), 'rate_limited'],
    ['слишком большое тело', chunked(429, [new Uint8Array(300 * 1024)]), 'rate_limited'],
  ] as const)('429, %s => %s', async (_case, response, failure) => {
    const h = createHarness();
    h.reply(response);

    expect(await lookup(h)).toEqual({ ok: false, failure });
  });

  it.each([500, 502, 503, 504, 599])('%i => unavailable', async (status) => {
    const h = createHarness();
    h.reply(json(status, { error: 'db_unavailable' }));

    expect(await lookup(h)).toEqual({ ok: false, failure: 'unavailable' });
  });

  it.each([201, 301, 302, 307, 403, 405, 408, 409, 413, 418, 422])(
    'остальной статус %i => invalid_response, паузу он не включает',
    async (status) => {
      const h = createHarness();
      h.reply(json(status, EMPTY_LOOKUP), json(200, EMPTY_LOOKUP));

      expect(await lookup(h)).toEqual({ ok: false, failure: 'invalid_response' });
      expect(await lookup(h)).toEqual({ ok: true, value: [] });
      expect(h.fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('204 без тела => invalid_response', async () => {
    const h = createHarness();
    h.reply(new Response(null, { status: 204 }));

    expect(await lookup(h)).toEqual({ ok: false, failure: 'invalid_response' });
  });

  it('200 и 202 принимаются по контракту каждого запроса', async () => {
    const h = createHarness();
    h.reply(json(200, EMPTY_LOOKUP));

    expect(await lookup(h)).toEqual({ ok: true, value: [] });
  });
});

describe('company-api транспорт: сеть и таймаут', () => {
  it.each([
    ['отказ соединения', networkError('ECONNREFUSED')],
    ['TypeError без причины', () => Promise.reject(new TypeError('fetch failed'))],
    ['не Error', vi.fn<Responder>().mockRejectedValue('boom')],
    ['AbortError от самого fetch', () => Promise.reject(new DOMException('x', 'AbortError'))],
  ])('%s => unavailable (не timeout: ответа точно не было)', async (_case, responder) => {
    const h = createHarness();
    h.reply(responder);

    expect(await lookup(h)).toEqual({ ok: false, failure: 'unavailable' });
  });

  it('запрос, который не отвечает, прерывается по таймауту => timeout, сигнал отмены уходит в fetch', async () => {
    const h = createHarness({ timeoutMs: 20 });
    let aborted = false;
    h.reply((request, signal) => {
      signal?.addEventListener('abort', () => {
        aborted = true;
      });
      return hanging()(request, signal);
    });

    const result = await lookup(h);

    expect(result).toEqual({ ok: false, failure: 'timeout' });
    expect(aborted).toBe(true);
  });

  it('fetch, который игнорирует сигнал отмены, тоже не держит вызов дольше таймаута', async () => {
    const h = createHarness({ timeoutMs: 20 });
    h.reply(() => new Promise<Response>(() => undefined));

    expect(await lookup(h)).toEqual({ ok: false, failure: 'timeout' });
  });

  it('таймаут по умолчанию 3 с: на 2999 мс вызов ещё ждёт, на 3000 мс он завершён', async () => {
    vi.useFakeTimers();
    const h = createHarness();
    h.reply(hanging());
    let settled = false;
    const call = lookup(h).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await call).toEqual({ ok: false, failure: 'timeout' });
  });

  it('таймаут охватывает и чтение тела: поток, который встал, прерывается и закрывается', async () => {
    const h = createHarness({ timeoutMs: 20 });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(ENCODER.encode('{"candi'));
      },
      cancel() {
        cancelled = true;
      },
    });
    h.reply(new Response(stream, { status: 200 }));

    expect(await lookup(h)).toEqual({ ok: false, failure: 'timeout' });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('обрыв потока посреди тела => unavailable', async () => {
    const h = createHarness();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(ENCODER.encode('{"candi'));
        else controller.error(new TypeError('terminated'));
      },
    });
    h.reply(new Response(stream, { status: 200 }));

    expect(await lookup(h)).toEqual({ ok: false, failure: 'unavailable' });
  });

  it('без своей fetch берётся глобальная на момент вызова: заблокированная сеть => unavailable', async () => {
    const entries: LogEntry[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const directory = createCompanyDirectory({
      baseUrl: BASE_URL,
      token: TOKEN,
      clock: { now: () => START_MS },
      logger: createFakeLogger(entries),
    });

    const result = await directory.lookup({ by: 'domain', domain: 'sklad.kz' });

    expect(result).toEqual({ ok: false, failure: 'unavailable' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(`${BASE_URL}/internal/lookup?domain=sklad.kz`);
  });
});

describe('company-api транспорт: тело ответа', () => {
  it('предел тела 256 КБ: ровно 256 КБ принимается', async () => {
    const h = createHarness();
    h.reply(chunked(200, [bodyOfSize(256 * 1024)]));

    expect(await lookup(h)).toEqual({ ok: true, value: [] });
  });

  it('на байт больше предела => invalid_response', async () => {
    const h = createHarness();
    h.reply(chunked(200, [bodyOfSize(256 * 1024 + 1)]));

    expect(await lookup(h)).toEqual({ ok: false, failure: 'invalid_response' });
  });

  it('поток обрывается, как только предел пройден: лишнее не читается', async () => {
    const h = createHarness();
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(100 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    h.reply(new Response(stream, { status: 200 }));

    expect(await lookup(h)).toEqual({ ok: false, failure: 'invalid_response' });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(5);
  });

  it('тело из нескольких кусков собирается, в том числе с многобайтовыми символами на стыке', async () => {
    const h = createHarness();
    const bytes = ENCODER.encode(
      JSON.stringify({
        candidates: [
          {
            id: 1,
            name: 'Платформа',
            city: null,
            rubric: null,
            match_by: 'name',
            match_score: 0.9,
            emailed: false,
          },
        ],
      }),
    );
    const cut = bytes.indexOf(0xd0) + 1;
    h.reply(chunked(200, [bytes.slice(0, cut), bytes.slice(cut)]));

    expect(await lookup(h)).toEqual({
      ok: true,
      value: [expect.objectContaining({ id: 1 as CompanyId, name: 'Платформа' })],
    });
  });

  it.each([
    ['не JSON', plain(200, 'not json')],
    ['пустое тело', plain(200, '')],
    ['HTML', plain(200, '<html>502</html>')],
    ['обрезанный JSON', plain(200, '{"candidates":[')],
    ['JSON null', json(200, null)],
    ['JSON число', json(200, 42)],
    ['JSON строка', json(200, 'ok')],
  ])('200 с телом: %s => invalid_response', async (_case, response) => {
    const h = createHarness();
    h.reply(response);

    expect(await lookup(h)).toEqual({ ok: false, failure: 'invalid_response' });
  });

  it('ответ без тела (null) на 200 => invalid_response', async () => {
    const h = createHarness();
    h.reply(new Response(null, { status: 200 }));

    expect(await lookup(h)).toEqual({ ok: false, failure: 'invalid_response' });
  });

  it('тело ошибок, кроме 429, не читается: большое тело 500 не задерживает ответ', async () => {
    const h = createHarness();
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    h.reply(new Response(stream, { status: 500 }));

    expect(await lookup(h)).toEqual({ ok: false, failure: 'unavailable' });
    expect(pulled).toBeLessThanOrEqual(2);
  });

  it('непрочитанное тело с уже упавшим потоком: отказ его закрытия не становится необработанным', async () => {
    const h = createHarness();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('terminated'));
      },
    });
    h.reply(new Response(stream, { status: 404 }));

    expect(await lookup(h)).toEqual({ ok: false, failure: 'not_found' });
  });
});

describe('company-api транспорт: пауза после сбоя', () => {
  const outages: readonly (readonly [string, Reply, 'unavailable' | 'timeout'])[] = [
    ['503', json(503, { error: 'db_unavailable' }), 'unavailable'],
    ['500', plain(500, 'oops'), 'unavailable'],
    ['сеть', networkError(), 'unavailable'],
    ['таймаут', hanging(), 'timeout'],
  ];

  it.each(outages)(
    'после сбоя (%s, сам вызов: %s) вызовы сразу возвращают unavailable без сети',
    async (_case, outage, first) => {
      const h = createHarness({ timeoutMs: 20 });
      h.reply(outage);

      expect(await lookup(h)).toEqual({ ok: false, failure: first });
      expect(h.fetch).toHaveBeenCalledTimes(1);

      expect(await lookup(h)).toEqual({ ok: false, failure: 'unavailable' });
      expect(await h.directory.brief(1 as CompanyId)).toEqual({
        ok: false,
        failure: 'unavailable',
      });
      expect(
        await h.directory.startResearch({
          name: 'Ромашка',
          aliases: [],
          city: null,
          phone: null,
          domain: null,
        }),
      ).toEqual({ ok: false, failure: 'unavailable' });
      expect(await h.directory.researchStatus('abc-1' as ResearchJobId)).toEqual({
        ok: false,
        failure: 'unavailable',
      });
      expect(h.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('пауза по умолчанию минута: за миллисекунду до конца сети ещё нет, в конце она снова доступна', async () => {
    const h = createHarness();
    h.reply(json(503, {}), json(200, EMPTY_LOOKUP));
    await lookup(h);

    h.clock.advance(MINUTE_MS - 1);
    expect(await lookup(h)).toEqual({ ok: false, failure: 'unavailable' });
    expect(h.fetch).toHaveBeenCalledTimes(1);

    h.clock.advance(1);
    expect(await lookup(h)).toEqual({ ok: true, value: [] });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('после таймаута тоже пауза в минуту: за миллисекунду до конца unavailable, в конце запрос уходит', async () => {
    const h = createHarness({ timeoutMs: 20 });
    h.reply(hanging(), json(200, EMPTY_LOOKUP));

    expect(await lookup(h)).toEqual({ ok: false, failure: 'timeout' });
    h.clock.advance(MINUTE_MS - 1);
    expect(await lookup(h)).toEqual({ ok: false, failure: 'unavailable' });
    expect(h.fetch).toHaveBeenCalledTimes(1);

    h.clock.advance(1);
    expect(await lookup(h)).toEqual({ ok: true, value: [] });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('таймаут запуска проверки: timeout, а не unavailable (запрос мог дойти до проекта B)', async () => {
    const h = createHarness({ timeoutMs: 20 });
    h.reply(hanging());

    expect(
      await h.directory.startResearch({
        name: 'Ромашка',
        aliases: [],
        city: null,
        phone: null,
        domain: null,
      }),
    ).toEqual({ ok: false, failure: 'timeout' });
  });

  it('длину паузы задаёт cooldownMs', async () => {
    const h = createHarness({ cooldownMs: 5_000 });
    h.reply(json(503, {}), json(200, EMPTY_LOOKUP));
    await lookup(h);

    h.clock.advance(4_999);
    expect((await lookup(h)).ok).toBe(false);
    h.clock.advance(1);

    expect(await lookup(h)).toEqual({ ok: true, value: [] });
  });

  it('второй сбой после конца паузы начинает новую паузу', async () => {
    const h = createHarness();
    h.reply(json(503, {}), json(503, {}), json(200, EMPTY_LOOKUP));
    await lookup(h);
    h.clock.advance(MINUTE_MS);

    expect(await lookup(h)).toEqual({ ok: false, failure: 'unavailable' });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.clock.advance(MINUTE_MS - 1);
    expect((await lookup(h)).ok).toBe(false);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.clock.advance(1);
    expect(await lookup(h)).toEqual({ ok: true, value: [] });
  });

  it.each([
    ['400', json(400, {})],
    ['401', json(401, {})],
    ['404', json(404, {})],
    ['429', json(429, { error: 'rate_limited' })],
    ['ответ не по схеме', json(200, { candidates: 'x' })],
    ['302', json(302, {})],
  ])('%s паузу не включает: следующий запрос уходит в сеть', async (_case, response) => {
    const h = createHarness();
    h.reply(response, json(200, EMPTY_LOOKUP));

    await lookup(h);

    expect(await lookup(h)).toEqual({ ok: true, value: [] });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('плохой запрос во время паузы получает bad_request без сети: проверка не зависит от паузы', async () => {
    const h = createHarness();
    h.reply(json(503, {}));
    await lookup(h);

    expect(await h.directory.lookup({ by: 'name', name: '  ' })).toEqual({
      ok: false,
      failure: 'bad_request',
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('company-api транспорт: записи в лог', () => {
  it('начало паузы: одно предупреждение с адресом запроса и статусом', async () => {
    const h = createHarness();
    h.reply(json(503, { error: 'db_unavailable' }));

    await lookup(h);

    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({
      level: 'warn',
      context: { endpoint: 'lookup', status: 503 },
    });
    expect(h.logs[0]?.message).toMatch(/^API почтового проекта недоступно, /);
  });

  it.each([
    ['отказ соединения', networkError('ECONNREFUSED'), { code: 'ECONNREFUSED' }],
    ['сокет закрыт', networkError('UND_ERR_SOCKET'), { code: 'UND_ERR_SOCKET' }],
    ['странный код ошибки', networkError('не код: 77012345678'), { code: 'network_error' }],
    [
      'сбой без кода',
      () => Promise.reject(new TypeError('fetch failed')),
      { code: 'network_error' },
    ],
  ])('сеть (%s): в логе code вместо status', async (_case, responder, expected) => {
    const h = createHarness();
    h.reply(responder);

    await lookup(h);

    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]?.context).toEqual({ endpoint: 'lookup', ...expected, pauseMs: MINUTE_MS });
  });

  it('таймаут: code timeout', async () => {
    const h = createHarness({ timeoutMs: 20 });
    h.reply(hanging());

    await lookup(h);

    expect(h.logs[0]?.context).toMatchObject({ endpoint: 'lookup', code: 'timeout' });
  });

  it('endpoint называет вызов: lookup, brief, research, research_status', async () => {
    const h = createHarness({ cooldownMs: 1 });
    h.reply(json(503, {}), json(503, {}), json(503, {}), json(503, {}));

    await lookup(h);
    h.clock.advance(1);
    await h.directory.brief(1 as CompanyId);
    h.clock.advance(1);
    await h.directory.startResearch({
      name: 'Ромашка',
      aliases: [],
      city: null,
      phone: null,
      domain: null,
    });
    h.clock.advance(1);
    await h.directory.researchStatus('abc-1' as ResearchJobId);

    expect(h.logs.map((entry) => entry.context['endpoint'])).toEqual([
      'lookup',
      'brief',
      'research',
      'research_status',
    ]);
  });

  it('вызовы во время паузы в лог не пишут: одно предупреждение на паузу', async () => {
    const h = createHarness();
    h.reply(json(503, {}));

    for (let call = 0; call < 5; call += 1) await lookup(h);

    expect(h.logs).toHaveLength(1);
  });

  it('новая пауза после конца прежней: новое предупреждение', async () => {
    const h = createHarness();
    h.reply(json(503, {}), json(500, {}));

    await lookup(h);
    h.clock.advance(MINUTE_MS);
    await lookup(h);

    expect(h.logs.map((entry) => entry.context['status'])).toEqual([503, 500]);
  });

  it('одновременные сбои: одна пауза и одно предупреждение', async () => {
    const h = createHarness();
    h.reply(json(503, {}), json(503, {}), json(503, {}));

    const results = await Promise.all([lookup(h), lookup(h), lookup(h)]);

    expect(results.every((result) => !result.ok)).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(h.logs).toHaveLength(1);
  });

  it('401: ошибка в лог не чаще раза в 10 минут', async () => {
    const h = createHarness();
    h.reply(...Array.from({ length: 5 }, () => json(401, { error: 'unauthorized' })));

    await lookup(h);
    h.clock.advance(10 * MINUTE_MS - 1);
    await lookup(h);
    expect(h.logs).toHaveLength(1);
    h.clock.advance(1);
    await lookup(h);
    await lookup(h);

    expect(h.logs).toHaveLength(2);
    expect(h.logs[0]).toMatchObject({
      level: 'error',
      context: { endpoint: 'lookup', status: 401 },
    });
    expect(h.logs[1]?.level).toBe('error');
  });

  it('401 в самом начале времени тоже попадает в лог (первая запись не зависит от значения часов)', async () => {
    const h = createHarness();
    h.clock.set(0);
    h.reply(json(401, {}));

    await lookup(h);

    expect(h.logs).toHaveLength(1);
  });

  it('401 не включает паузу', async () => {
    const h = createHarness();
    h.reply(json(401, {}), json(200, EMPTY_LOOKUP));

    await lookup(h);

    expect(await lookup(h)).toEqual({ ok: true, value: [] });
  });

  it.each([
    ['200', json(200, EMPTY_LOOKUP)],
    ['400', plain(400, 'Invalid host header')],
    ['404', json(404, {})],
    ['429', json(429, { error: 'budget_exhausted' })],
    ['ответ не по схеме', json(200, { candidates: 'x' })],
    ['не JSON', plain(200, 'xx')],
    ['302', json(302, {})],
  ])('%s: в лог ничего не пишется', async (_case, response) => {
    const h = createHarness();
    h.reply(response);

    await lookup(h);

    expect(h.logs).toEqual([]);
  });

  it('в логе нет токена, домена, номера и текста ответа, даже если они были в запросе и в ошибке', async () => {
    const h = createHarness({ timeoutMs: 20 });
    h.reply(
      json(401, { error: `unauthorized ${TOKEN}` }),
      json(503, { detail: SECRET_DOMAIN }),
      () => Promise.reject(new TypeError(`fetch failed ${SECRET_DOMAIN} ${TOKEN} 77011234567`)),
    );

    await lookup(h);
    await lookup(h);
    h.clock.advance(MINUTE_MS);
    await lookup(h);

    expect(h.logs.length).toBeGreaterThanOrEqual(2);
    const logged = JSON.stringify(h.logs);
    for (const secret of [TOKEN, SECRET_DOMAIN, '77011234567', 'detail']) {
      expect(logged).not.toContain(secret);
    }
    expect(h.sent.map((request) => request.headers['X-Internal-Token'])).toEqual([
      TOKEN,
      TOKEN,
      TOKEN,
    ]);
  });
});

describe('company-api: создание клиента', () => {
  it.each(['', '   '])('пустой токен %j: клиент не создаётся, SafeError', (token) => {
    const fetchSpy = vi.fn();

    expect(() =>
      createCompanyDirectory({
        baseUrl: BASE_URL,
        token,
        fetch: fetchSpy,
        clock: { now: () => START_MS },
        logger: createFakeLogger([]),
      }),
    ).toThrow(SafeError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    'http://mail.example.kz:8000',
    'http://192.168.1.10:8000',
    'http://localhost:8000',
    'http://[::1]:8000',
    'https://127.0.0.1:8000',
    'http://user:pass@127.0.0.1:8000',
    'http://127.0.0.1:8000/api',
    'не адрес',
  ])(
    'адрес не на этой машине или неверный (%s): клиент не создаётся, в ошибке нет адреса и токена',
    (baseUrl) => {
      const fetchSpy = vi.fn();
      let failure: unknown = null;

      try {
        createCompanyDirectory({
          baseUrl,
          token: TOKEN,
          fetch: fetchSpy,
          clock: { now: () => START_MS },
          logger: createFakeLogger([]),
        });
      } catch (error: unknown) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(SafeError);
      const message = (failure as SafeError).message;
      expect(message).not.toContain(baseUrl);
      expect(message).not.toContain(TOKEN);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['http://127.0.0.1:8000/', 'http://127.0.0.1:8000'],
    ['HTTP://127.0.0.1:8000', 'http://127.0.0.1:8000'],
  ])('адрес %s приводится к виду %s', async (baseUrl, expected) => {
    const h = createHarness({ baseUrl });
    h.reply(json(200, EMPTY_LOOKUP));

    await h.directory.lookup({ by: 'domain', domain: 'sklad.kz' });

    expect(h.sent[0]?.url).toBe(`${expected}/internal/lookup?domain=sklad.kz`);
  });

  it('это вариант enabled: true с четырьмя вызовами', () => {
    const h = createHarness();

    expect(h.directory.enabled).toBe(true);
    expect(Object.keys(h.directory).sort()).toEqual([
      'brief',
      'enabled',
      'lookup',
      'researchStatus',
      'startResearch',
    ]);
  });

  it('ни один вызов не бросает исключение при сбое сети', async () => {
    const h = createHarness();
    h.reply(networkError());

    await expect(lookup(h)).resolves.toMatchObject({ ok: false });
  });
});
