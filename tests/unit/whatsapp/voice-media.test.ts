import { DEF_MEDIA_HOST, type WAMessage } from 'baileys';
import { describe, expect, it, vi } from 'vitest';
import type { Clock } from '../../../src/domain/ports.js';
import type { InboundMessage, Jid, MediaRef, WaMessageId } from '../../../src/domain/types.js';
import type { WaEvent } from '../../../src/whatsapp/inbound.js';
import {
  createVoiceStore,
  createWhatsAppAudioDownload,
  VOICE_CACHE_LIMIT,
  VOICE_DOWNLOAD_TIMEOUT_MS,
  VOICE_TTL_MS,
  type MediaContentFetch,
  type MediaDownload,
} from '../../../src/whatsapp/voice-media.js';

// Скачивание подменено: сети нет, поток собирается из массива кусков.

const NOW = Date.UTC(2026, 9, 26, 9, 0, 0);
const JID = '77000000002@s.whatsapp.net' as Jid;
const MIME = 'audio/ogg; codecs=opus';
const MEDIA_KEY = new Uint8Array([1, 2, 3]);

function raw(id: string, audio: Record<string, unknown> = {}): WAMessage {
  return {
    key: { id, remoteJid: JID, fromMe: false },
    message: { audioMessage: { ptt: true, mimetype: MIME, ...audio } },
  };
}

function inbound(id: string, content: InboundMessage['content']): InboundMessage {
  return {
    waId: id as WaMessageId,
    identity: { replyJid: JID, lidJid: null, pnJid: JID },
    pushName: null,
    content,
    tsMs: NOW,
  };
}

function voiceEvent(id: string, type: 'client' | 'stale' = 'client'): WaEvent {
  const content = { kind: 'voice', media: id as MediaRef, mimeType: MIME, seconds: 3 } as const;
  return { type, message: inbound(id, content) };
}

async function* chunks(...parts: readonly unknown[]): AsyncGenerator<unknown> {
  for (const part of parts) {
    await Promise.resolve();
    yield part;
  }
}

/** Пауза, которая завершается только отменой: срок скачивания в обычных тестах не наступает. */
function pendingSleep(_ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      reject(new Error('Пауза прервана'));
    });
  });
}

interface Setup {
  readonly store: ReturnType<typeof createVoiceStore>;
  readonly download: ReturnType<typeof vi.fn<MediaDownload>>;
  readonly sleep: ReturnType<typeof vi.fn<Clock['sleep']>>;
  readonly setNow: (ms: number) => void;
}

function setup(parts: readonly unknown[] = [Buffer.from('ogg'), Buffer.from('-opus')]): Setup {
  let nowMs = NOW;
  const sleep = vi.fn<Clock['sleep']>(pendingSleep);
  const clock: Clock = { now: () => nowMs, sleep };
  const download = vi.fn<MediaDownload>(() => Promise.resolve(chunks(...parts)));
  return {
    store: createVoiceStore({ clock, download }),
    download,
    sleep,
    setNow: (ms) => {
      nowMs = ms;
    },
  };
}

describe('whatsapp/voice-media: хранилище голосовых', () => {
  it('голосовое клиента скачивается по MediaRef: байты целиком, тип из разбора, сырое сообщение в загрузчик', async () => {
    const { store, download } = setup();
    const source = raw('V1');
    store.remember(source, voiceEvent('V1'));

    const clip = await store.download('V1' as MediaRef, 1024);

    expect(Buffer.from(clip.data).toString()).toBe('ogg-opus');
    expect(clip.mimeType).toBe(MIME);
    expect(download).toHaveBeenCalledWith(source);
  });

  it('после скачивания сообщение не держится в памяти', async () => {
    const { store } = setup();
    store.remember(raw('V1'), voiceEvent('V1'));
    await store.download('V1' as MediaRef, 1024);

    await expect(store.download('V1' as MediaRef, 1024)).rejects.toThrow('Голосовое не найдено');
  });

  it.each<[string, WaEvent]>([
    ['голосовое простоя (stale)', voiceEvent('V1', 'stale')],
    ['текст клиента', { type: 'client', message: inbound('V1', { kind: 'text', text: 'да' }) }],
    [
      'своё голосовое',
      {
        type: 'own',
        message: {
          waId: 'V1' as WaMessageId,
          chatJid: JID,
          content: { kind: 'voice', media: 'V1' as MediaRef, mimeType: MIME, seconds: 1 },
          tsMs: NOW,
        },
      },
    ],
  ])('%s в память не попадает', async (_case, event) => {
    const { store, download } = setup();

    store.remember(raw('V1'), event);

    await expect(store.download('V1' as MediaRef, 1024)).rejects.toThrow('Голосовое не найдено');
    expect(download).not.toHaveBeenCalled();
  });

  it('устаревшее по TTL не скачивается', async () => {
    const { store, setNow } = setup();
    store.remember(raw('V1'), voiceEvent('V1'));

    setNow(NOW + VOICE_TTL_MS);

    await expect(store.download('V1' as MediaRef, 1024)).rejects.toThrow('Голосовое не найдено');
  });

  it('сверх потолка вытесняется самое старое', async () => {
    const { store } = setup();
    for (let index = 0; index <= VOICE_CACHE_LIMIT; index += 1) {
      store.remember(raw(`V${index}`), voiceEvent(`V${index}`));
    }

    await expect(store.download('V0' as MediaRef, 1024)).rejects.toThrow('Голосовое не найдено');
    await expect(store.download(`V${VOICE_CACHE_LIMIT}` as MediaRef, 1024)).resolves.toMatchObject({
      mimeType: MIME,
    });
  });

  it('ровно maxBytes скачивается, на байт больше: поток обрывается с ошибкой', async () => {
    const exact = setup([Buffer.alloc(6), Buffer.alloc(4)]);
    exact.store.remember(raw('V1'), voiceEvent('V1'));
    const over = setup([Buffer.alloc(6), Buffer.alloc(5), Buffer.alloc(100)]);
    over.store.remember(raw('V1'), voiceEvent('V1'));

    await expect(exact.store.download('V1' as MediaRef, 10)).resolves.toMatchObject({
      data: expect.objectContaining({ byteLength: 10 }) as unknown,
    });
    await expect(over.store.download('V1' as MediaRef, 10)).rejects.toThrow('больше лимита');
  });

  it.each<[string, readonly unknown[], string]>([
    ['пустой поток', [], 'пустое'],
    ['не байты в потоке', ['текст'], 'не байты'],
  ])('%s: ошибка', async (_case, parts, text) => {
    const { store } = setup(parts);
    store.remember(raw('V1'), voiceEvent('V1'));

    await expect(store.download('V1' as MediaRef, 1024)).rejects.toThrow(text);
  });

  it('срок скачивания вышел: ошибка, а поток закрывается на следующем куске', async () => {
    const { store, download, sleep } = setup();
    let release: () => void = () => undefined;
    let closed = false;
    async function* stalled(): AsyncGenerator<unknown> {
      try {
        yield Buffer.from('ogg');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield Buffer.from('-opus');
      } finally {
        closed = true;
      }
    }
    download.mockResolvedValue(stalled());
    sleep.mockImplementationOnce(() => Promise.resolve());
    store.remember(raw('V1'), voiceEvent('V1'));

    await expect(store.download('V1' as MediaRef, 1024)).rejects.toThrow('не скачалось вовремя');
    release();

    await vi.waitFor(() => expect(closed).toBe(true));
    expect(sleep).toHaveBeenCalledWith(VOICE_DOWNLOAD_TIMEOUT_MS, expect.any(AbortSignal));
  });
});

describe('whatsapp/voice-media: скачивание с сервера WhatsApp', () => {
  function fetchMock(): ReturnType<typeof vi.fn<MediaContentFetch>> {
    return vi.fn<MediaContentFetch>(() => Promise.resolve(chunks(Buffer.from('ogg'))));
  }

  it('только directPath на хосте медиа WhatsApp: url отправителя не используется', async () => {
    const fetchContent = fetchMock();
    const download = createWhatsAppAudioDownload(fetchContent);

    await download(
      raw('V1', { url: 'https://evil.example/x', directPath: '/v/t62/abc', mediaKey: MEDIA_KEY }),
    );

    expect(fetchContent).toHaveBeenCalledWith(
      { mediaKey: MEDIA_KEY, directPath: '/v/t62/abc' },
      'audio',
      { host: DEF_MEDIA_HOST },
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ['нет directPath, есть только url', { url: 'https://evil.example/x', mediaKey: MEDIA_KEY }],
    ['directPath не путь', { directPath: 'https://evil.example/x', mediaKey: MEDIA_KEY }],
    ['нет ключа медиа', { directPath: '/v/t62/abc' }],
  ])('%s: скачивание отменено', async (_case, audio) => {
    const fetchContent = fetchMock();
    const download = createWhatsAppAudioDownload(fetchContent);

    await expect(download(raw('V1', audio))).rejects.toThrow('скачивание отменено');
    expect(fetchContent).not.toHaveBeenCalled();
  });
});
