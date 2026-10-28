import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Clock } from '../../../src/domain/ports.js';
import type { Jid } from '../../../src/domain/types.js';
import {
  BUSINESS_PROFILE_TIMEOUT_MS,
  createWhatsAppContacts,
  MAX_EMAIL_CHARS,
  MAX_WEBSITE_CHARS,
  MAX_WEBSITES,
  PHOTO_DOWNLOAD_TIMEOUT_MS,
  PHOTO_URL_TIMEOUT_MS,
  type ContactsSocket,
  type ProfileFetch,
} from '../../../src/whatsapp/contacts.js';
import { createFakeLogger, type LogEntry } from '../../helpers/fake-logger.js';

// Профиль собеседника: поддельные сокет, часы и fetch. К WhatsApp и CDN никто не подключается.

const JID = '77000000002@s.whatsapp.net' as Jid;
const PHOTO_URL = 'https://pps.whatsapp.net/v/t61.24694-24/123_n.jpg?ccb=11-4&oh=secret&oe=65';
const MAX_BYTES = 1000;
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const NUL = String.fromCodePoint(0);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const LF = String.fromCodePoint(0x0a);
const CRLF = String.fromCodePoint(0x0d, 0x0a);

type ProfileMock = Mock<ContactsSocket['getBusinessProfile']>;
type PictureMock = Mock<ContactsSocket['profilePictureUrl']>;

interface Setup {
  readonly contacts: ReturnType<typeof createWhatsAppContacts>;
  readonly logs: LogEntry[];
  readonly getBusinessProfile: ProfileMock;
  readonly profilePictureUrl: PictureMock;
  readonly socketFor: Mock<(jid: Jid) => Promise<ContactsSocket | null>>;
  readonly fetch: Mock<ProfileFetch>;
  readonly sleeps: number[];
  /** Срок вышел у самой ранней паузы. */
  expire(): void;
}

function setup(
  options: {
    readonly profile?: unknown;
    readonly pictureUrl?: string | undefined;
    readonly socket?: ContactsSocket | null | 'throws';
    readonly photo?: Response | (() => Promise<Response>);
  } = {},
): Setup {
  const logs: LogEntry[] = [];
  const sleeps: number[] = [];
  const expiries: (() => void)[] = [];
  const clock: Clock = {
    now: () => 0,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        sleeps.push(ms);
        expiries.push(resolve);
        signal?.addEventListener('abort', () => {
          reject(new Error('Пауза прервана'));
        });
      }),
  };
  const getBusinessProfile: ProfileMock = vi.fn(() =>
    Promise.resolve(options.profile as Awaited<ReturnType<ContactsSocket['getBusinessProfile']>>),
  );
  const profilePictureUrl: PictureMock = vi.fn(() => Promise.resolve(options.pictureUrl));
  const sock: ContactsSocket = { getBusinessProfile, profilePictureUrl };
  const socketFor = vi.fn((_jid: Jid): Promise<ContactsSocket | null> => {
    if (options.socket === 'throws') return Promise.reject(new Error('нет сокета'));
    return Promise.resolve(options.socket === undefined ? sock : options.socket);
  });
  const fetchMock = vi.fn<ProfileFetch>(() => {
    const photo = options.photo;
    if (photo === undefined) return Promise.reject(new Error('Фото не подготовлено'));
    return typeof photo === 'function' ? photo() : Promise.resolve(photo);
  });
  const contacts = createWhatsAppContacts({
    socketFor,
    clock,
    logger: createFakeLogger(logs),
    fetch: fetchMock,
  });
  return {
    contacts,
    logs,
    getBusinessProfile,
    profilePictureUrl,
    socketFor,
    fetch: fetchMock,
    sleeps,
    expire: () => {
      expiries.shift()?.();
    },
  };
}

function image(
  bytes: Uint8Array | readonly Uint8Array[],
  contentType: string | null = 'image/jpeg',
  status = 200,
): Response {
  const parts = bytes instanceof Uint8Array ? [bytes] : bytes;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
  const headers: Record<string, string> =
    contentType === null ? {} : { 'content-type': contentType };
  return new Response(stream, { status, headers });
}

function bytesOf(length: number, fill = 7): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

describe('whatsapp/contacts businessProfile', () => {
  it('нет сокета (нет подключения или адрес не разрешён) => failed, запросов нет', async () => {
    const h = setup({ socket: null });

    expect(await h.contacts.businessProfile(JID)).toEqual({ kind: 'failed' });
    expect(h.getBusinessProfile).not.toHaveBeenCalled();
  });

  it('сокет для адреса не получилось взять (исключение) => failed', async () => {
    const h = setup({ socket: 'throws' });

    expect(await h.contacts.businessProfile(JID)).toEqual({ kind: 'failed' });
  });

  it('запрос про этот адрес: сокет выбирается по jid', async () => {
    const h = setup({ profile: undefined });

    await h.contacts.businessProfile(JID);

    expect(h.socketFor).toHaveBeenCalledWith(JID);
    expect(h.getBusinessProfile).toHaveBeenCalledWith(JID);
  });

  it.each([undefined, null])('профиля нет (%s) => personal', async (profile) => {
    const h = setup({ profile });

    expect(await h.contacts.businessProfile(JID)).toEqual({ kind: 'personal' });
  });

  it.each([
    ['строка', 'business'],
    ['число', 7],
    ['булево', true],
  ])('ответ не объект (%s) => failed', async (_case, profile) => {
    const h = setup({ profile });

    expect(await h.contacts.businessProfile(JID)).toEqual({ kind: 'failed' });
  });

  it('бизнес-профиль: сайты и почта, остальные поля не берутся', async () => {
    const h = setup({
      profile: {
        wid: JID,
        description: 'Склад в Алматы',
        address: 'ул. Абая 1',
        category: 'Склад',
        website: ['https://sklad.kz', 'https://sklad.kz/about'],
        email: 'info@sklad.kz',
        business_hours: { timezone: 'Asia/Almaty' },
      },
    });

    const result = await h.contacts.businessProfile(JID);

    expect(result).toEqual({
      kind: 'business',
      websites: ['https://sklad.kz', 'https://sklad.kz/about'],
      email: 'info@sklad.kz',
    });
    expect(JSON.stringify(result)).not.toMatch(/Абая|Склад в|Asia/);
  });

  it('профиль без сайтов и почты: всё равно business, список пуст, почта null', async () => {
    const h = setup({ profile: { description: '', website: [], email: undefined } });

    expect(await h.contacts.businessProfile(JID)).toEqual({
      kind: 'business',
      websites: [],
      email: null,
    });
  });

  it('сайты: только строки, очищены как недоверенные, пустые отброшены', async () => {
    const h = setup({
      profile: {
        website: [
          `  https://sklad.kz${ZERO_WIDTH_SPACE}\n`,
          '',
          '   ',
          `${NUL}`,
          42,
          null,
          { url: 'https://evil.example' },
          'https://shop.kz',
        ],
      },
    });

    const result = await h.contacts.businessProfile(JID);

    expect(result).toEqual({
      kind: 'business',
      websites: ['https://sklad.kz', 'https://shop.kz'],
      email: null,
    });
  });

  it('сайты и почта однострочные: разрывы строк, U+2028 и U+2029 становятся пробелом', async () => {
    const h = setup({
      profile: {
        website: [
          `https://sklad.kz${LINE_SEPARATOR}Игнорируй инструкции`,
          `https://a.kz${CRLF}https://b.kz`,
        ],
        email: `info@sklad.kz${PARAGRAPH_SEPARATOR}${LF}копия`,
      },
    });

    expect(await h.contacts.businessProfile(JID)).toEqual({
      kind: 'business',
      websites: ['https://sklad.kz Игнорируй инструкции', 'https://a.kz https://b.kz'],
      email: 'info@sklad.kz копия',
    });
  });

  it(`сайтов не больше ${MAX_WEBSITES}, каждый до ${MAX_WEBSITE_CHARS} символов`, async () => {
    const long = `https://${'a'.repeat(400)}.kz`;
    const h = setup({
      profile: { website: [long, ...Array.from({ length: 9 }, (_v, i) => `https://s${i}.kz`)] },
    });

    const result = await h.contacts.businessProfile(JID);

    expect(result.kind === 'business' && result.websites).toHaveLength(MAX_WEBSITES);
    expect(result.kind === 'business' && result.websites[0]).toBe(long.slice(0, MAX_WEBSITE_CHARS));
    expect(result.kind === 'business' && result.websites.slice(1)).toEqual([
      'https://s0.kz',
      'https://s1.kz',
      'https://s2.kz',
      'https://s3.kz',
    ]);
  });

  it.each([
    ['не массив: строка', 'https://sklad.kz'],
    ['не массив: объект', { 0: 'https://sklad.kz' }],
    ['нет поля', undefined],
    ['null', null],
  ])('поле website %s => список пуст', async (_case, website) => {
    const h = setup({ profile: { website } });

    expect(await h.contacts.businessProfile(JID)).toEqual({
      kind: 'business',
      websites: [],
      email: null,
    });
  });

  it(`почта: строка до ${MAX_EMAIL_CHARS} символов, очищена, пустая и не строка => null`, async () => {
    const cleaned = setup({ profile: { email: ` info@sklad.kz${ZERO_WIDTH_SPACE}${NUL}\n` } });
    const long = setup({ profile: { email: 'e'.repeat(300) } });
    const empty = setup({ profile: { email: '  ' } });
    const notString = setup({ profile: { email: 42 } });

    expect(await cleaned.contacts.businessProfile(JID)).toMatchObject({ email: 'info@sklad.kz' });
    expect(await long.contacts.businessProfile(JID)).toMatchObject({
      email: 'e'.repeat(MAX_EMAIL_CHARS),
    });
    expect(await empty.contacts.businessProfile(JID)).toMatchObject({ email: null });
    expect(await notString.contacts.businessProfile(JID)).toMatchObject({ email: null });
  });

  it('исключение сокета => failed, в лог только имя ошибки без текста, адреса и данных', async () => {
    const h = setup();
    h.getBusinessProfile.mockRejectedValueOnce(
      new RangeError(`bad ${JID} 77000000002 info@sklad.kz`),
    );

    expect(await h.contacts.businessProfile(JID)).toEqual({ kind: 'failed' });

    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ level: 'warn', context: { errorName: 'RangeError' } });
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toMatch(/77000000002|sklad\.kz|bad /);
  });

  it('отказ не Error (строка) => failed, в лог тип значения', async () => {
    const h = setup();
    h.getBusinessProfile.mockRejectedValueOnce('boom 77000000002');

    expect(await h.contacts.businessProfile(JID)).toEqual({ kind: 'failed' });
    expect(h.logs[0]?.context).toEqual({ errorName: 'string' });
  });

  it('WhatsApp не ответил за 5 с => failed, пауза именно на этот срок', async () => {
    const h = setup();
    h.getBusinessProfile.mockImplementationOnce(() => new Promise(() => undefined));

    const pending = h.contacts.businessProfile(JID);
    await vi.waitFor(() => expect(h.sleeps).toEqual([BUSINESS_PROFILE_TIMEOUT_MS]));
    h.expire();

    expect(await pending).toEqual({ kind: 'failed' });
    expect(BUSINESS_PROFILE_TIMEOUT_MS).toBe(5_000);
    expect(h.logs[0]).toMatchObject({ level: 'warn', context: { errorName: 'TimeoutError' } });
  });

  it('сайты, почта и адрес в лог не попадают при успехе', async () => {
    const h = setup({ profile: { website: ['https://sklad.kz'], email: 'info@sklad.kz' } });

    await h.contacts.businessProfile(JID);

    expect(JSON.stringify(h.logs)).not.toMatch(/sklad|77000000002/);
  });
});

describe('whatsapp/contacts profilePhoto', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('фото скачивается: байты и тип, запрос про полный размер с таймаутом 10 с', async () => {
    const h = setup({ pictureUrl: PHOTO_URL, photo: image(bytesOf(10, 9), 'image/jpeg') });

    const photo = await h.contacts.profilePhoto(JID, MAX_BYTES);

    expect(photo).toEqual({ data: bytesOf(10, 9), mimeType: 'image/jpeg' });
    expect(photo?.data).toBeInstanceOf(Uint8Array);
    expect(h.profilePictureUrl).toHaveBeenCalledWith(JID, 'image', PHOTO_URL_TIMEOUT_MS);
    expect(PHOTO_URL_TIMEOUT_MS).toBe(10_000);
    expect(PHOTO_DOWNLOAD_TIMEOUT_MS).toBe(10_000);
  });

  it('скачивание: https-адрес как есть, без перехода по редиректам, с сигналом отмены', async () => {
    const h = setup({ pictureUrl: PHOTO_URL, photo: image(bytesOf(3)) });

    await h.contacts.profilePhoto(JID, MAX_BYTES);

    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetch.mock.calls[0] ?? [];
    expect(url).toBe(PHOTO_URL);
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(h.sleeps).toEqual([PHOTO_DOWNLOAD_TIMEOUT_MS]);
  });

  it('тело из нескольких кусков собирается', async () => {
    const h = setup({
      pictureUrl: PHOTO_URL,
      photo: image([bytesOf(3, 1), bytesOf(4, 2)], 'image/png'),
    });

    const photo = await h.contacts.profilePhoto(JID, MAX_BYTES);

    expect(photo?.mimeType).toBe('image/png');
    expect(Array.from(photo?.data ?? [])).toEqual([1, 1, 1, 2, 2, 2, 2]);
  });

  it.each([
    ['image/jpeg', 'image/jpeg'],
    ['image/png', 'image/png'],
    ['image/webp', 'image/webp'],
    ['IMAGE/PNG', 'image/png'],
    ['image/webp; charset=binary', 'image/webp'],
    [' image/jpeg ;q=1', 'image/jpeg'],
  ] as const)('тип %s принимается как %s', async (contentType, expected) => {
    const h = setup({ pictureUrl: PHOTO_URL, photo: image(bytesOf(4), contentType) });

    expect((await h.contacts.profilePhoto(JID, MAX_BYTES))?.mimeType).toBe(expected);
  });

  it.each([
    ['gif', 'image/gif'],
    ['svg', 'image/svg+xml'],
    ['html', 'text/html'],
    ['поток байтов', 'application/octet-stream'],
    ['пустой', ''],
    ['без заголовка', null],
    ['мусор', 'jpeg'],
  ])('тип «%s» не принимается => null, поток закрыт', async (_case, contentType) => {
    const h = setup({ pictureUrl: PHOTO_URL, photo: image(bytesOf(4), contentType) });

    expect(await h.contacts.profilePhoto(JID, MAX_BYTES)).toBeNull();
    expect(h.logs[0]).toMatchObject({ level: 'warn', context: { reason: 'content_type' } });
  });

  it('ровно maxBytes принимается, на байт больше => null и поток закрыт', async () => {
    const exact = setup({ pictureUrl: PHOTO_URL, photo: image([bytesOf(600), bytesOf(400)]) });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytesOf(600));
      },
      cancel() {
        cancelled = true;
      },
    });
    const over = setup({
      pictureUrl: PHOTO_URL,
      photo: new Response(stream, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    });

    expect((await exact.contacts.profilePhoto(JID, 1000))?.data.byteLength).toBe(1000);
    expect(await over.contacts.profilePhoto(JID, 1000)).toBeNull();
    expect(cancelled).toBe(true);
    expect(over.logs[0]).toMatchObject({ context: { reason: 'too_large' } });
  });

  it('пустое тело => null', async () => {
    const h = setup({ pictureUrl: PHOTO_URL, photo: image([]) });

    expect(await h.contacts.profilePhoto(JID, MAX_BYTES)).toBeNull();
    expect(h.logs[0]).toMatchObject({ context: { reason: 'empty' } });
  });

  it.each([404, 403, 206, 500, 302])('ответ CDN %i не 200 => null', async (status) => {
    const h = setup({ pictureUrl: PHOTO_URL, photo: image(bytesOf(4), 'image/jpeg', status) });

    expect(await h.contacts.profilePhoto(JID, MAX_BYTES)).toBeNull();
    expect(h.logs[0]).toMatchObject({ context: { reason: 'http_status', status } });
  });

  it('фото нет (адреса нет) => null без скачивания', async () => {
    const h = setup({ pictureUrl: undefined });

    expect(await h.contacts.profilePhoto(JID, MAX_BYTES)).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['http вместо https', 'http://pps.whatsapp.net/v/abc.jpg'],
    ['чужой хост', 'https://evil.example/v/abc.jpg'],
    ['хост с суффиксом в начале', 'https://pps.whatsapp.net.evil.example/v/abc.jpg'],
    ['похожий домен без точки', 'https://evilwhatsapp.net/v/abc.jpg'],
    ['сам whatsapp.net без поддомена', 'https://whatsapp.net/v/abc.jpg'],
    ['хост с точкой на конце', 'https://pps.whatsapp.net./v/abc.jpg'],
    ['логин и пароль в адресе', 'https://user:pass@pps.whatsapp.net/v/abc.jpg'],
    ['только логин', 'https://evil.example@pps.whatsapp.net/v/abc.jpg'],
    ['нестандартный порт', 'https://pps.whatsapp.net:8443/v/abc.jpg'],
    ['чужая схема', 'ftp://pps.whatsapp.net/v/abc.jpg'],
    ['схема file', 'file:///etc/passwd'],
    ['локальный адрес', 'https://127.0.0.1/v/abc.jpg'],
    ['не адрес', 'не адрес'],
    ['пусто', ''],
  ])('адрес фото: %s => null без скачивания', async (_case, url) => {
    const h = setup({ pictureUrl: url });

    expect(await h.contacts.profilePhoto(JID, MAX_BYTES)).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.logs[0]).toMatchObject({ level: 'warn', context: { reason: 'url_rejected' } });
  });

  it('адрес на поддомене .whatsapp.net в любом регистре принимается', async () => {
    const h = setup({
      pictureUrl: 'HTTPS://MEDIA-AMS4-1.CDN.WHATSAPP.NET/v/abc.jpg',
      photo: image(bytesOf(4)),
    });

    expect(await h.contacts.profilePhoto(JID, MAX_BYTES)).not.toBeNull();
  });

  it.each([
    ['not-authorized', 401],
    ['item-not-found', 404],
  ])(
    'WhatsApp ответил %s (%i): фото нет или скрыто => null, это не авария',
    async (_name, status) => {
      const h = setup();
      h.profilePictureUrl.mockRejectedValueOnce(
        Object.assign(new Error('not-authorized'), { output: { statusCode: status } }),
      );

      expect(await h.contacts.profilePhoto(JID, MAX_BYTES)).toBeNull();

      expect(h.logs).toHaveLength(1);
      expect(h.logs[0]).toMatchObject({ level: 'info', context: { status } });
      expect(h.fetch).not.toHaveBeenCalled();
    },
  );

  it('другой сбой запроса адреса (сеть, 500) => null, предупреждение с именем ошибки и статусом', async () => {
    const h = setup();
    h.profilePictureUrl.mockRejectedValueOnce(
      Object.assign(new TypeError('boom'), { output: { statusCode: 500 } }),
    );
    h.profilePictureUrl.mockRejectedValueOnce(new Error('Connection Closed'));

    expect(await h.contacts.profilePhoto(JID, MAX_BYTES)).toBeNull();
    expect(await h.contacts.profilePhoto(JID, MAX_BYTES)).toBeNull();

    expect(h.logs[0]).toMatchObject({
      level: 'warn',
      context: { errorName: 'TypeError', status: 500 },
    });
    expect(h.logs[1]).toMatchObject({ level: 'warn', context: { errorName: 'Error' } });
    expect(h.logs[1]?.context).not.toHaveProperty('status');
  });

  it.each([
    ['строка', 'boom 77000000002'],
    ['null', null],
  ])(
    'отказ запроса адреса не Error (%s) => null, в лог тип значения без статуса',
    async (_case, reason) => {
      const h = setup();
      h.profilePictureUrl.mockRejectedValueOnce(reason);

      expect(await h.contacts.profilePhoto(JID, MAX_BYTES)).toBeNull();

      expect(h.logs[0]).toMatchObject({ level: 'warn', context: { errorName: typeof reason } });
      expect(h.logs[0]?.context).not.toHaveProperty('status');
      expect(JSON.stringify(h.logs)).not.toContain('77000000002');
    },
  );

  it('отказ CDN, у тела которого не получилось отменить поток => null, без необработанного отказа', async () => {
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error('отмена не удалась');
      },
    });
    const h = setup({
      pictureUrl: PHOTO_URL,
      photo: new Response(stream, { status: 500, headers: { 'content-type': 'image/jpeg' } }),
    });

    expect(await h.contacts.profilePhoto(JID, MAX_BYTES)).toBeNull();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(h.logs[0]).toMatchObject({ context: { reason: 'http_status', status: 500 } });
  });

  it('нет сокета => null, запросов нет', async () => {
    const h = setup({ socket: null });

    expect(await h.contacts.profilePhoto(JID, MAX_BYTES)).toBeNull();
    expect(h.profilePictureUrl).not.toHaveBeenCalled();
  });

  it('сокет не получилось взять (исключение) => null', async () => {
    const h = setup({ socket: 'throws' });

    expect(await h.contacts.profilePhoto(JID, MAX_BYTES)).toBeNull();
  });

  it('сеть при скачивании (fetch отклонён, редирект) => null, предупреждение без адреса', async () => {
    const h = setup({
      pictureUrl: PHOTO_URL,
      photo: () => Promise.reject(new TypeError(`fetch failed ${PHOTO_URL}`)),
    });

    expect(await h.contacts.profilePhoto(JID, MAX_BYTES)).toBeNull();

    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ level: 'warn', context: { errorName: 'TypeError' } });
    expect(JSON.stringify(h.logs)).not.toMatch(/whatsapp\.net|secret|fetch failed/);
  });

  it('скачивание не уложилось в 10 с => null, сигнал отмены уходит в fetch', async () => {
    let aborted = false;
    const h = setup({
      pictureUrl: PHOTO_URL,
      photo: () => new Promise<Response>(() => undefined),
    });
    h.fetch.mockImplementationOnce((_url, init) => {
      init.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      return new Promise<Response>(() => undefined);
    });

    const pending = h.contacts.profilePhoto(JID, MAX_BYTES);
    await vi.waitFor(() => expect(h.sleeps).toEqual([PHOTO_DOWNLOAD_TIMEOUT_MS]));
    h.expire();

    expect(await pending).toBeNull();
    expect(aborted).toBe(true);
    expect(h.logs[0]).toMatchObject({ level: 'warn', context: { reason: 'timeout' } });
  });

  it('в лог не попадают адрес фото, JID и номер, даже при успехе и при отказе', async () => {
    const ok = setup({ pictureUrl: PHOTO_URL, photo: image(bytesOf(4)) });
    const rejected = setup({ pictureUrl: 'https://evil.example/77000000002.jpg' });

    await ok.contacts.profilePhoto(JID, MAX_BYTES);
    await rejected.contacts.profilePhoto(JID, MAX_BYTES);

    const logged = JSON.stringify([...ok.logs, ...rejected.logs]);
    expect(logged).not.toMatch(/whatsapp\.net|evil\.example|77000000002|secret/);
  });

  it('без своей fetch берётся глобальная на момент вызова: заблокированная сеть => null', async () => {
    const logs: LogEntry[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const sock: ContactsSocket = {
      getBusinessProfile: () => Promise.resolve(undefined),
      profilePictureUrl: () => Promise.resolve(PHOTO_URL),
    };
    const contacts = createWhatsAppContacts({
      socketFor: () => Promise.resolve(sock),
      clock: { now: () => 0, sleep: () => new Promise<void>(() => undefined) },
      logger: createFakeLogger(logs),
    });

    expect(await contacts.profilePhoto(JID, MAX_BYTES)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(PHOTO_URL);
  });
});
