import {
  DEF_MEDIA_HOST,
  downloadContentFromMessage,
  normalizeMessageContent,
  type DownloadableMessage,
  type MediaType,
  type WAMessage,
} from 'baileys';
import type { Clock } from '../domain/ports.js';
import type { AudioClip, MediaRef } from '../domain/types.js';
import type { WaEvent } from './inbound.js';

/** Сколько голосовое клиента ждёт скачивания в памяти, мс: пачка уходит в обработку за секунды. */
export const VOICE_TTL_MS = 10 * 60_000;

/** Потолок голосовых в памяти: сверх него вытесняется самое старое. */
export const VOICE_CACHE_LIMIT = 200;

/** Срок скачивания голосового целиком, мс: Baileys не передаёт сигнал отмены в fetch, срок держит хранилище. */
export const VOICE_DOWNLOAD_TIMEOUT_MS = 40_000;

/** Скачивание голосового потоком; по умолчанию createWhatsAppAudioDownload. */
export type MediaDownload = (message: WAMessage) => Promise<AsyncIterable<unknown>>;

/** Загрузка и расшифровка медиа по пути на сервере WhatsApp (downloadContentFromMessage из Baileys). */
export type MediaContentFetch = (
  media: DownloadableMessage,
  type: MediaType,
  options: { readonly host: string },
) => Promise<AsyncIterable<unknown>>;

/** Голосовые клиентов в памяти адаптера: наружу уходит только MediaRef. */
export interface VoiceStore {
  /** После разбора: голосовое из события client запоминается по MediaRef, остальное в память не попадает. */
  remember(message: WAMessage, event: WaEvent): void;
  /**
   * Скачивает голосовое потоком, обрывая на maxBytes, не дольше VOICE_DOWNLOAD_TIMEOUT_MS; нет в памяти, пусто,
   * больше лимита или срок вышел => ошибка.
   */
  download(media: MediaRef, maxBytes: number): Promise<AudioClip>;
}

/** Зависимости хранилища голосовых. */
export interface VoiceStoreOptions {
  readonly clock: Clock;
  readonly download: MediaDownload;
}

interface VoiceEntry {
  readonly message: WAMessage;
  readonly mimeType: string;
  readonly expiresAtMs: number;
}

const TIMED_OUT = Symbol('timed-out');

/**
 * Хранилище голосовых: сырой WAMessage (по mediaKey и directPath медиа можно расшифровать) только в памяти,
 * с TTL VOICE_TTL_MS и потолком VOICE_CACHE_LIMIT, в базу не пишется. Запоминаются только голосовые из событий
 * client: чужие голосовые и голосовые простоя в память не попадают. После скачивания запись удаляется.
 * Тип аудио берётся из разбора (whatsapp/inbound.ts уже проверил его), а не из сырого сообщения.
 */
export function createVoiceStore(options: VoiceStoreOptions): VoiceStore {
  // Map хранит порядок вставки: первым идёт самое старое голосовое.
  const entries = new Map<MediaRef, VoiceEntry>();
  const prune = (nowMs: number): void => {
    for (const [ref, entry] of entries) {
      if (entry.expiresAtMs <= nowMs || entries.size > VOICE_CACHE_LIMIT) entries.delete(ref);
    }
  };
  return {
    remember(message, event) {
      if (event.type !== 'client' || event.message.content.kind !== 'voice') return;
      const { media, mimeType } = event.message.content;
      const nowMs = options.clock.now();
      entries.delete(media);
      entries.set(media, { message, mimeType, expiresAtMs: nowMs + VOICE_TTL_MS });
      prune(nowMs);
    },
    async download(media, maxBytes) {
      prune(options.clock.now());
      const entry = entries.get(media);
      if (entry === undefined) {
        throw new Error('Голосовое не найдено в памяти: устарело или пришло до запуска бота');
      }
      const data = await withinTimeout(options.clock, async (signal) =>
        readLimited(await options.download(entry.message), maxBytes, signal),
      );
      entries.delete(media);
      return { data, mimeType: entry.mimeType };
    },
  };
}

/**
 * Скачивание голосового с сервера медиа WhatsApp. Адрес только из directPath (путь, начинается с «/») на хосте
 * DEF_MEDIA_HOST: поле url и хост из него задаёт отправитель, по ним бот пошёл бы на чужой адрес (SSRF), поэтому
 * они не используются. Нет пути или ключа медиа => ошибка без запроса. fetchContent подменяется в тестах.
 */
export function createWhatsAppAudioDownload(
  fetchContent: MediaContentFetch = downloadContentFromMessage,
): MediaDownload {
  return (message) => {
    const audio = normalizeMessageContent(message.message)?.audioMessage;
    const directPath = audio?.directPath;
    const mediaKey = audio?.mediaKey;
    if (typeof directPath !== 'string' || !directPath.startsWith('/') || !mediaKey?.length) {
      return Promise.reject(new Error('Голосовое без пути медиа WhatsApp: скачивание отменено'));
    }
    return fetchContent({ mediaKey, directPath }, 'audio', { host: DEF_MEDIA_HOST });
  };
}

/** Работа за VOICE_DOWNLOAD_TIMEOUT_MS: по сроку ошибка, а сигнал останавливает чтение потока на следующем куске. */
async function withinTimeout(
  clock: Clock,
  work: (signal: AbortSignal) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const stop = new AbortController();
  const timedOut = (): typeof TIMED_OUT => TIMED_OUT;
  const timer = clock.sleep(VOICE_DOWNLOAD_TIMEOUT_MS, stop.signal).then(timedOut, timedOut);
  const running = work(stop.signal);
  // Сбой работы после срока уже никому не нужен: он не должен стать необработанным отказом.
  running.catch(() => undefined);
  try {
    const result = await Promise.race([running, timer]);
    if (result === TIMED_OUT) throw new Error('Голосовое не скачалось вовремя');
    return result;
  } finally {
    stop.abort();
  }
}

/** Читает поток целиком, обрывая его, как только байтов больше maxBytes (выход из цикла закрывает поток). */
async function readLimited(
  stream: AsyncIterable<unknown>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    if (signal.aborted) throw new Error('Скачивание голосового остановлено: срок вышел');
    if (!(chunk instanceof Uint8Array)) throw new Error('Поток голосового отдал не байты');
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error('Голосовое больше лимита байт: скачивание прервано');
    chunks.push(chunk);
  }
  if (total === 0) throw new Error('Голосовое пустое');
  return Buffer.concat(chunks);
}
