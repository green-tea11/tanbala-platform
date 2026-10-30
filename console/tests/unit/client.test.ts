import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createBackendClient,
  errorCodeOf,
  type BackendClientOptions,
  type FetchLike,
} from '../../src/backends/client.js';
import { consolePath, PathTemplateError } from '../../src/backends/paths.js';
import { parseSafeJson, toSafeJson } from '../../src/backends/safe-json.js';
import { createLogger } from '../../src/shared/logger.js';
import { json } from '../helpers/fake-backends.js';
import { createFakeClock } from '../helpers/harness.js';

const BASE = 'http://127.0.0.1:8000';

function logSink() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { lines, logger: createLogger({ level: 'info', destination }) };
}

function makeClient(fetch: FetchLike, overrides: Partial<BackendClientOptions> = {}) {
  const clock = createFakeClock();
  const sink = logSink();
  const client = createBackendClient({
    name: 'leads',
    baseUrl: BASE,
    token: 'T'.repeat(40),
    fetch,
    clock,
    logger: sink.logger,
    ...overrides,
  });
  return { client, clock, lines: sink.lines };
}

const summary = consolePath(['summary']);

describe('адреса из шаблона', () => {
  it('слова шаблона и целые id; параметры кодируются, пустые пропускаются', () => {
    expect(consolePath(['drafts', 4, 'send-test'])).toEqual({
      pathname: '/internal/console/drafts/4/send-test',
      full: '/internal/console/drafts/4/send-test',
    });
    expect(consolePath(['chats'], { q: 'а&b=c', page: 2, status: undefined, level: '' }).full).toBe(
      '/internal/console/chats?q=%D0%B0%26b%3Dc&page=2',
    );
  });

  it('чужие части шаблона и id не целые — ошибка кода', () => {
    expect(() => consolePath(['../summary'])).toThrow(PathTemplateError);
    expect(() => consolePath(['chats', 0])).toThrow(PathTemplateError);
    expect(() => consolePath(['chats', 1.5])).toThrow(PathTemplateError);
    expect(() => consolePath(['chats'], { 'a-b': 1 })).toThrow(PathTemplateError);
  });
});

describe('копия JSON в пределах', () => {
  it('свежая неизменяемая копия без __proto__ и constructor', () => {
    const copy = parseSafeJson('{"a":[1,{"b":"x"}],"__proto__":{"p":1},"constructor":1}') as {
      a: unknown[];
    };
    expect(copy).toEqual({ a: [1, { b: 'x' }] });
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(copy.a)).toBe(true);
    expect(parseSafeJson('null')).toBeNull();
  });

  it('вне пределов или не JSON — undefined', () => {
    const limits = {
      maxDepth: 3,
      maxArrayItems: 2,
      maxObjectKeys: 2,
      maxKeyLength: 3,
      maxStringLength: 3,
    };
    expect(parseSafeJson('<html>', limits)).toBeUndefined();
    expect(parseSafeJson('[[[[1]]]]', limits)).toBeUndefined();
    expect(parseSafeJson('[1,2,3]', limits)).toBeUndefined();
    expect(parseSafeJson('{"a":1,"b":2,"c":3}', limits)).toBeUndefined();
    expect(parseSafeJson('{"long":1}', limits)).toBeUndefined();
    expect(parseSafeJson('"abcd"', limits)).toBeUndefined();
    expect(toSafeJson(Number.NaN)).toBeNull();
    expect(toSafeJson(() => 1)).toBeNull();
  });
});

describe('клиент приложения', () => {
  it('одинаковые одновременные чтения — один запрос; кэш 1.5 с', async () => {
    let calls = 0;
    const { client, clock } = makeClient(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return json({ n: calls });
    });
    const [first, second] = await Promise.all([client.get(summary), client.get(summary)]);
    expect(calls).toBe(1);
    expect(first).toBe(second);
    await client.get(summary);
    expect(calls).toBe(1);
    clock.advance(1_500);
    expect(await client.get(summary)).toMatchObject({ ok: true, data: { n: 2 } });
  });

  it('действие сбрасывает кэш, и ответ, начатый до действия, в кэш не ложится', async () => {
    let version = 0;
    let release: () => void = () => undefined;
    const { client } = makeClient(async (_url, init) => {
      if (init.method === 'POST') {
        version += 1;
        return json({ result: 'ok' });
      }
      const seen = version;
      if (seen === 0) await new Promise<void>((resolve) => (release = resolve));
      return json({ version: seen });
    });
    const slow = client.get(summary);
    await new Promise((resolve) => setImmediate(resolve));
    await client.post(consolePath(['runs']), {}, 'owner');
    release();
    expect(await slow).toMatchObject({ data: { version: 0 } });
    expect(await client.get(summary)).toMatchObject({ data: { version: 1 } });
  });

  it('не больше 4 запросов сразу; очередь сверх предела — «недоступно»', async () => {
    let active = 0;
    let peak = 0;
    const { client } = makeClient(
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return json({});
      },
      { limits: { maxQueued: 3 } },
    );
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => client.get(consolePath(['runs', index + 1]))),
    );
    expect(peak).toBe(4);
    expect(results.filter((result) => result.ok)).toHaveLength(7);
  });

  it('таймаут: «недоступно», код timeout в лог (не чаще раза в минуту)', async () => {
    const { client, lines, clock } = makeClient(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
      { limits: { getTimeoutMs: 10 } },
    );
    expect(await client.get(summary)).toEqual({ ok: false, failure: { kind: 'unavailable' } });
    expect(await client.get(consolePath(['runs']))).toMatchObject({ ok: false });
    expect(lines.map((line) => line['code'])).toEqual(['timeout']);
    clock.advance(60_000);
    await client.get(consolePath(['blocked']));
    expect(lines).toHaveLength(2);
    expect(JSON.stringify(lines)).not.toContain('T'.repeat(40));
  });

  it('ответ больше предела, не UTF-8, не JSON: «недоступно»', async () => {
    const bodies = [
      () => json({ big: 'x'.repeat(200) }),
      () => new Response(new Uint8Array([0xff, 0xfe, 0x00])),
      () => new Response('<html>ошибка</html>', { headers: { 'content-type': 'text/html' } }),
    ];
    for (const body of bodies) {
      const { client } = makeClient(() => Promise.resolve(body()), {
        limits: { maxResponseBytes: 100 },
      });
      expect(await client.get(summary)).toEqual({ ok: false, failure: { kind: 'unavailable' } });
    }
  });

  it('401/403 — auth (в лог раз в 10 минут); 404 без тела — not_found; 418 — «недоступно»', async () => {
    let status = 401;
    const { client, lines } = makeClient(() => Promise.resolve(new Response(null, { status })));
    expect(await client.get(summary)).toEqual({ ok: false, failure: { kind: 'auth' } });
    status = 403;
    expect(await client.get(consolePath(['runs']))).toEqual({
      ok: false,
      failure: { kind: 'auth' },
    });
    expect(lines.filter((line) => line['level'] === 50)).toHaveLength(1);
    status = 404;
    expect(await client.get(consolePath(['history']))).toEqual({
      ok: false,
      failure: { kind: 'rejected', status: 404, code: 'not_found', message: null },
    });
    status = 418;
    expect(await client.get(consolePath(['blocked']))).toMatchObject({
      failure: { kind: 'unavailable' },
    });
    status = 503;
    expect(await client.get(consolePath(['letters']))).toMatchObject({
      failure: { kind: 'unavailable' },
    });
  });

  it('код отказа не по виду заменяется кодом по статусу', async () => {
    const { client } = makeClient(() =>
      Promise.resolve(json({ error: 'Bad Code!', message: 42 }, 422)),
    );
    expect(await client.post(consolePath(['runs']), {}, 'owner')).toEqual({
      ok: false,
      failure: { kind: 'rejected', status: 422, code: 'refused', message: null },
    });
  });

  it('сетевая ошибка: код из причины; адрес вне шаблона не уходит', async () => {
    expect(errorCodeOf(new TypeError('x', { cause: { code: 'ECONNREFUSED' } }))).toBe(
      'ECONNREFUSED',
    );
    expect(errorCodeOf(Object.assign(new Error('x'), { code: 'bad code' }))).toBe('network_error');
    expect(errorCodeOf('строка')).toBe('network_error');
    let called = false;
    const { client } = makeClient(() => {
      called = true;
      return Promise.resolve(json({}));
    });
    const escaped = { pathname: '/x', full: '//evil.example/internal/console/x' };
    expect(await client.get(escaped)).toMatchObject({ ok: false });
    expect(await client.get({ pathname: '/x', full: '/other/x' })).toMatchObject({ ok: false });
    expect(called).toBe(false);
  });
});
