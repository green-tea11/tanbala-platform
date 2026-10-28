import { initAuthCreds, type SignalDataSet, type SignalKeyStore } from 'baileys';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { LoadedAuthState } from '../../../src/whatsapp/connection-types.js';
import { trackAuthWrites } from '../../../src/whatsapp/probe-auth.js';
import { createFakeLogger, type LogEntry } from '../../helpers/fake-logger.js';

// Учёт записей сессии пробы: creds по порядку, ключи Signal с учётом незаконченных записей. Файлов нет, всё в памяти.

const KEY_DATA: SignalDataSet = { session: { '100000000000001.0': new Uint8Array([1, 2, 3]) } };

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Даёт пройти всем уже готовым промисам (одна макрозадача, без таймеров). */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Ждёт промис не дольше одной макрозадачи: 'pending', если он ещё не завершился. */
async function peek<T>(promise: Promise<T>): Promise<T | 'pending'> {
  const marker = new Promise<'pending'>((resolve) => {
    setImmediate(() => {
      resolve('pending');
    });
  });
  return Promise.race([promise, marker]);
}

interface Harness {
  readonly auth: LoadedAuthState;
  readonly keys: SignalKeyStore;
  readonly get: Mock<(type: string, ids: string[]) => Record<string, undefined>>;
  readonly set: Mock<SignalKeyStore['set']>;
  readonly saveCreds: Mock<() => Promise<void>>;
  readonly logs: LogEntry[];
}

function setup(
  keysSet: SignalKeyStore['set'] = () => undefined,
  credsSave: () => Promise<void> = () => Promise.resolve(),
): Harness {
  const logs: LogEntry[] = [];
  const get = vi.fn((_type: string, ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, undefined])),
  );
  const set = vi.fn(keysSet);
  const saveCreds = vi.fn(credsSave);
  const keys: SignalKeyStore = {
    // Подделка get без привязки к типам ключей: проверяется только то, что проба отдаёт ответ как есть.
    get: get as unknown as SignalKeyStore['get'],
    set,
  };
  const auth: LoadedAuthState = { state: { creds: initAuthCreds(), keys }, saveCreds };
  return { auth, keys, get, set, saveCreds, logs };
}

describe('whatsapp/probe-auth trackAuthWrites: состояние для сокета', () => {
  it('creds тот же объект: Baileys меняет его на месте, saveCreds пишет его же', () => {
    const h = setup();

    const writes = trackAuthWrites(h.auth, createFakeLogger(h.logs));

    expect(writes.state.creds).toBe(h.auth.state.creds);
    expect(writes.state.keys).not.toBe(h.keys);
    expect(writes.state.keys).not.toHaveProperty('clear');
  });

  it('keys.get отдаёт то, что отдал исходный get, с теми же аргументами', async () => {
    const h = setup();
    const writes = trackAuthWrites(h.auth, createFakeLogger(h.logs));

    const value = await writes.state.keys.get('session', ['a', 'b']);

    expect(h.get).toHaveBeenCalledExactlyOnceWith('session', ['a', 'b']);
    expect(value).toEqual({ a: undefined, b: undefined });
  });

  it('нет записей: settled сразу true', async () => {
    const h = setup();

    await expect(trackAuthWrites(h.auth, createFakeLogger(h.logs)).settled()).resolves.toBe(true);
  });
});

describe('whatsapp/probe-auth trackAuthWrites: ключи (keys.set)', () => {
  it('незаконченная запись ключа: settled ждёт её, а Baileys получает её же промис', async () => {
    const write = deferred();
    const h = setup(() => write.promise);
    const writes = trackAuthWrites(h.auth, createFakeLogger(h.logs));

    const returned = writes.state.keys.set(KEY_DATA);
    const settled = writes.settled();

    expect(h.set).toHaveBeenCalledExactlyOnceWith(KEY_DATA);
    expect(await peek(settled)).toBe('pending');
    expect(await peek(Promise.resolve(returned))).toBe('pending');
    write.resolve();
    await expect(settled).resolves.toBe(true);
    await expect(returned).resolves.toBeUndefined();
  });

  it('запись, начатая во время ожидания, тоже дожидается', async () => {
    const first = deferred();
    const second = deferred();
    const h = setup(vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    const writes = trackAuthWrites(h.auth, createFakeLogger(h.logs));

    void writes.state.keys.set(KEY_DATA);
    const settled = writes.settled();
    void writes.state.keys.set(KEY_DATA);
    first.resolve();

    expect(await peek(settled)).toBe('pending');
    second.resolve();
    await expect(settled).resolves.toBe(true);
  });

  it('запись ключа упала: Baileys видит отказ, settled false, в логе только имя ошибки', async () => {
    const h = setup(() =>
      Promise.reject(new Error('EACCES: /data/whatsapp-session/session-x.json')),
    );
    const writes = trackAuthWrites(h.auth, createFakeLogger(h.logs));

    const returned = writes.state.keys.set(KEY_DATA);

    await expect(returned).rejects.toThrow('EACCES');
    await expect(writes.settled()).resolves.toBe(false);
    expect(h.logs).toEqual([
      {
        level: 'error',
        context: { errorName: 'Error' },
        message: 'Не удалось сохранить ключи сессии WhatsApp',
      },
    ]);
  });

  it('синхронный бросок keys.set тоже сбой записи: отказ промиса, settled false', async () => {
    const h = setup(() => {
      throw new TypeError('bad key');
    });
    const writes = trackAuthWrites(h.auth, createFakeLogger(h.logs));

    const returned = writes.state.keys.set(KEY_DATA);

    await expect(returned).rejects.toBeInstanceOf(TypeError);
    await expect(writes.settled()).resolves.toBe(false);
    expect(h.logs[0]?.context).toEqual({ errorName: 'TypeError' });
  });

  it('отказ не Error: в логе тип значения', async () => {
    const h = setup(() => Promise.reject(new Error('x')));
    h.set.mockRejectedValueOnce('disk full');
    const writes = trackAuthWrites(h.auth, createFakeLogger(h.logs));

    await expect(writes.state.keys.set(KEY_DATA)).rejects.toBe('disk full');

    await expect(writes.settled()).resolves.toBe(false);
    expect(h.logs[0]?.context).toEqual({ errorName: 'string' });
  });

  it('синхронный set без промиса: запись закончена сразу', async () => {
    const h = setup(() => undefined);
    const writes = trackAuthWrites(h.auth, createFakeLogger(h.logs));

    await expect(writes.state.keys.set(KEY_DATA)).resolves.toBeUndefined();

    await expect(writes.settled()).resolves.toBe(true);
  });
});

describe('whatsapp/probe-auth trackAuthWrites: creds', () => {
  it('сохранения по порядку: второе начинается после конца первого, settled ждёт оба', async () => {
    const first = deferred();
    const second = deferred();
    const h = setup();
    const writes = trackAuthWrites(h.auth, createFakeLogger(h.logs));
    h.saveCreds
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    writes.saveCreds();
    writes.saveCreds();
    const settled = writes.settled();
    await settle();

    expect(h.saveCreds).toHaveBeenCalledTimes(1);
    first.resolve();
    await settle();
    expect(h.saveCreds).toHaveBeenCalledTimes(2);
    expect(await peek(settled)).toBe('pending');
    second.resolve();
    await expect(settled).resolves.toBe(true);
  });

  it('первое сохранение упало: второе всё равно идёт, settled false, в логе имя ошибки', async () => {
    const h = setup();
    const writes = trackAuthWrites(h.auth, createFakeLogger(h.logs));
    h.saveCreds.mockRejectedValueOnce(new RangeError('ENOSPC'));

    writes.saveCreds();
    writes.saveCreds();

    await expect(writes.settled()).resolves.toBe(false);
    expect(h.saveCreds).toHaveBeenCalledTimes(2);
    expect(h.logs).toEqual([
      {
        level: 'error',
        context: { errorName: 'RangeError' },
        message: 'Не удалось сохранить сессию WhatsApp',
      },
    ]);
  });

  it('settled ждёт и creds, и ключи вместе', async () => {
    const creds = deferred();
    const key = deferred();
    const h = setup(
      () => key.promise,
      () => creds.promise,
    );
    const writes = trackAuthWrites(h.auth, createFakeLogger(h.logs));

    writes.saveCreds();
    void writes.state.keys.set(KEY_DATA);
    const settled = writes.settled();
    key.resolve();

    expect(await peek(settled)).toBe('pending');
    creds.resolve();
    await expect(settled).resolves.toBe(true);
  });
});
