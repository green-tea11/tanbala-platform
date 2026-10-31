// Сеть процесса симулятора. globalThis.fetch подменяется до сборки бота:
// - расшифровка OpenRouter всегда поддельная (настоящего аудио нет): текст из поля transcript хода или отказ 503;
// - внутренний API почты (EMAIL_API_URL): в режиме подделок поддельная почта, иначе настоящий запрос; оба пишутся
//   в журнал (метод, путь, тело, статус, ответ; заголовки с токеном не пишутся);
// - остальное: в режиме подделок запрещено (исключение), иначе проходит как есть (Claude API).
// В режиме подделок ещё и net.Socket.prototype.connect бросает: ни одного TCP-подключения из процесса.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';
import net from 'node:net';

/** Кто делает запрос: бот или сам симулятор (ожидание проверки новой компании). */
export const requestOrigin = new AsyncLocalStorage();

const OPENROUTER_HOST = 'openrouter.ai';
const OPENROUTER_PATH = '/api/v1/audio/transcriptions';
const VOICE_PREFIX = 'SIMVOICE:';
const MAX_LOGGED_BODY_CHARS = 6000;

function parseJson(text) {
  if (typeof text !== 'string' || text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function urlOf(input) {
  if (typeof input === 'string' || input instanceof URL) return new URL(String(input));
  return new URL(input.url);
}

function headersOf(input, init) {
  if (init?.headers !== undefined) return new Headers(init.headers);
  if (typeof input === 'object' && input !== null && 'headers' in input) return new Headers(input.headers);
  return new Headers();
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Голосовые сценария: waId → расшифровка (null: расшифровка «не удалась»). Аудио несёт свой waId в байтах. */
export function createVoiceStore() {
  const transcripts = new Map();
  return {
    add(waId, transcript) {
      transcripts.set(waId, typeof transcript === 'string' ? transcript : null);
    },
    clip(waId) {
      const marker = Buffer.from(`${VOICE_PREFIX}${waId}:`, 'utf8');
      const data = new Uint8Array(4096);
      data.set(marker, 0);
      return { data, mimeType: 'audio/ogg; codecs=opus' };
    },
    transcriptFor(audioBase64) {
      const text = Buffer.from(String(audioBase64 ?? ''), 'base64').subarray(0, 200).toString('utf8');
      const match = /^SIMVOICE:([^:]+):/u.exec(text);
      if (match === null) return { waId: null, transcript: null };
      return { waId: match[1], transcript: transcripts.get(match[1]) ?? null };
    },
  };
}

/** Запрет TCP в режиме подделок: любая попытка подключиться бросает и считается. */
export function installNetGuard(stats) {
  net.Socket.prototype.connect = function blockedConnect() {
    stats.blockedSockets += 1;
    throw new Error('Симулятор: сетевые подключения запрещены в режиме подделок (SIM_FAKE=1)');
  };
}

/**
 * Запрет слушать порты в любом режиме: панель (3100) и API консоли (3101) уже слушает настоящий бот. Панель
 * и так не стартует (швы startPanel и startConsoleApi пустые), это второй предохранитель.
 */
export function installListenGuard(stats) {
  net.Server.prototype.listen = function blockedListen() {
    stats.blockedListen += 1;
    throw new Error('Симулятор: прослушивание портов запрещено');
  };
}

function decodedSearch(search) {
  try {
    return decodeURIComponent(search);
  } catch {
    return search;
  }
}

export function installFetch({ fake, leadsBaseUrl, fakeLeads, voiceStore, events, activity, stats }) {
  const realFetch = globalThis.fetch;
  const leadsOrigin = leadsBaseUrl === null ? null : new URL(leadsBaseUrl).origin;

  async function transcription(init) {
    stats.openrouter += 1;
    const body = parseJson(typeof init?.body === 'string' ? init.body : '');
    const { waId, transcript } = voiceStore.transcriptFor(body?.input_audio?.data);
    events.push({ type: 'voice', waId, transcript, model: body?.model ?? null });
    if (transcript === null) {
      return jsonResponse(503, {
        error: { message: 'Симулятор: для этого голосового расшифровка не задана (поле transcript)' },
      });
    }
    return jsonResponse(200, {
      text: transcript,
      usage: { input_tokens: 0, output_tokens: 0, seconds: 10, cost: 0 },
    });
  }

  async function leadsCall(input, init, url) {
    const origin = requestOrigin.getStore()?.origin ?? 'bot';
    const method = String(init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    const requestBody = parseJson(typeof init?.body === 'string' ? init.body : '');
    stats.leads += 1;
    activity.begin('fetch');
    const startedAt = Date.now();
    const entry = {
      type: 'leads',
      origin,
      method,
      path: `${url.pathname}${decodedSearch(url.search)}`,
      request: requestBody,
    };
    try {
      const response = fake
        ? fakeLeads.handle(method, url, requestBody, headersOf(input, init))
        : await realFetch(input, init);
      let text = '';
      try {
        text = await response.clone().text();
      } catch {
        text = '';
      }
      events.push({
        ...entry,
        status: response.status,
        response: parseJson(text) ?? text.slice(0, MAX_LOGGED_BODY_CHARS),
        ms: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      events.push({ ...entry, error: error?.name ?? String(error), ms: Date.now() - startedAt });
      throw error;
    } finally {
      activity.end('fetch');
    }
  }

  globalThis.fetch = async function simFetch(input, init) {
    const url = urlOf(input);
    if (url.hostname === OPENROUTER_HOST && url.pathname === OPENROUTER_PATH) return transcription(init);
    if (leadsOrigin !== null && url.origin === leadsOrigin) return leadsCall(input, init, url);
    if (fake) {
      stats.blockedFetch += 1;
      events.push({ type: 'note', text: `Запрос наружу запрещён в режиме подделок: ${url.host}` });
      throw new TypeError(`Симулятор: запрос к ${url.host} запрещён в режиме подделок`);
    }
    stats.other += 1;
    activity.begin('fetch');
    try {
      return await realFetch(input, init);
    } finally {
      activity.end('fetch');
    }
  };
}
