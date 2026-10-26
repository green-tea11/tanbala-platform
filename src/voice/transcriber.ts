import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type { CallBudget, Clock, Logger, TokenLog, Transcriber } from '../domain/ports.js';
import type { AudioClip, ChatId, LlmResult } from '../domain/types.js';

/** Адрес расшифровки OpenRouter зафиксирован в коде: ключ уходит только сюда. */
export const OPENROUTER_TRANSCRIPTIONS_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';

/**
 * Потолок голосового в байтах: столько конвейер передаёт в WhatsAppInbox.downloadAudio, больше в API не уходит.
 * 5 МиБ: это минут 20 голосового WhatsApp (Opus), расшифровка через elevenlabs/scribe-v2 около $0.07.
 */
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

/** Тайм-аут запроса по умолчанию: OpenRouter сам обрывает обработку у провайдера через 60 с. */
export const TRANSCRIBE_TIMEOUT_MS = 60_000;

/** Потолок расшифровки в символах после NFKC: как у текстового сообщения (whatsapp/inbound MAX_TEXT_CHARS). */
const MAX_TRANSCRIPT_CHARS = 4096;

/** Невидимые и управляющие символы (Cc, Cf), кроме перевода строки: как у текста клиента в whatsapp/inbound. */
const INVISIBLE_EXCEPT_NEWLINE = /(?!\n)[\p{Cc}\p{Cf}]/gu;

const HTTP_TOO_MANY_REQUESTS = 429;

/**
 * Тип аудио без параметров => input_audio.format OpenRouter. Голосовые WhatsApp приходят как
 * audio/ogg; codecs=opus: Opus в контейнере Ogg, ElevenLabs принимает OGG и Opus.
 */
const AUDIO_FORMATS: ReadonlyMap<string, string> = new Map([
  ['audio/ogg', 'ogg'],
  ['audio/opus', 'ogg'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp4', 'm4a'],
  ['audio/wav', 'wav'],
  ['audio/webm', 'webm'],
  ['audio/aac', 'aac'],
  ['audio/flac', 'flac'],
]);

/** Зависимости расшифровки через OpenRouter. */
export interface OpenRouterTranscriberDeps {
  /** OPENROUTER_API_KEY: передаётся явно. */
  apiKey: string;
  /** ID модели OpenRouter из config/models.json (ключ transcribe), например elevenlabs/scribe-v2. */
  model: string;
  fetchFn: typeof fetch;
  /** Дневной предохранитель: вызов OpenRouter тоже считается вызовом API. */
  budget: CallBudget;
  /** now для лимита, sleep для тайм-аута запроса. */
  clock: Clock;
  tokenLog: TokenLog;
  /** Причины сбоев: статус HTTP или имя ошибки, без текста ошибки, аудио, расшифровки и ключа. */
  logger: Logger;
  /** Тайм-аут запроса вместе с чтением ответа, мс; по умолчанию TRANSCRIBE_TIMEOUT_MS. */
  timeoutMs?: number;
}

type UsageTokens = { readonly input: number; readonly output: number };

/** Секунды аудио и стоимость в долларах из usage OpenRouter: по ним виден реальный расход на голосовые. */
interface AudioSpend {
  readonly audioSeconds: number | null;
  readonly costUsd: number | null;
}

/** Итог одного запроса к OpenRouter: результат, токены из usage для лога расхода и расход, если пришёл ответ. */
interface CallOutcome {
  readonly result: LlmResult<string>;
  readonly usage: UsageTokens;
  readonly spend?: AudioSpend;
}

const UNAVAILABLE = { ok: false, failure: 'unavailable' } as const;
const INVALID_OUTPUT = { ok: false, failure: 'invalid_output' } as const;
const NO_USAGE: UsageTokens = { input: 0, output: 0 };

/** Токены из usage: нет поля или не число => 0 (Scribe считает секунды аудио, а не токены). */
const tokenCount = z.number().int().nonnegative().catch(0);

/** Секунды и доллары из usage: нет поля или не число => null. */
const spendAmount = z.number().nonnegative().nullable().catch(null);

/** Ответ OpenRouter { text, usage }: без текста или с текстом не строкой => пустая расшифровка. */
const responseSchema = z.object({
  text: z.string().catch(''),
  usage: z
    .object({
      input_tokens: tokenCount,
      output_tokens: tokenCount,
      seconds: spendAmount,
      cost: spendAmount,
    })
    .catch({ input_tokens: 0, output_tokens: 0, seconds: null, cost: null }),
});

/** Имя ошибки для лога: текст ошибки не пишется, в нём бывают адреса и ключи. */
function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** format OpenRouter по типу аудио; неизвестный тип, пустое или слишком большое аудио => null. */
function audioFormatOf(clip: AudioClip): string | null {
  if (clip.data.byteLength === 0 || clip.data.byteLength > MAX_AUDIO_BYTES) return null;
  const baseType = clip.mimeType.replace(/;.*$/s, '').trim().toLowerCase();
  return AUDIO_FORMATS.get(baseType) ?? null;
}

/** Расшифровка такой же недоверенный текст, как сообщение: без Cc и Cf, NFKC, без краевых пробелов, лимит. */
function cleanTranscript(raw: string): string {
  const cleaned = raw.replace(INVISIBLE_EXCEPT_NEWLINE, '').normalize('NFKC').trim();
  if (cleaned.length <= MAX_TRANSCRIPT_CHARS) return cleaned;
  return Array.from(cleaned).slice(0, MAX_TRANSCRIPT_CHARS).join('').trimEnd();
}

function outcomeOf(body: unknown): CallOutcome {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) return { result: INVALID_OUTPUT, usage: NO_USAGE };
  const { text, usage } = parsed.data;
  const transcript = cleanTranscript(text);
  return {
    result: transcript === '' ? INVALID_OUTPUT : { ok: true, value: transcript },
    usage: { input: usage.input_tokens, output: usage.output_tokens },
    spend: { audioSeconds: usage.seconds, costUsd: usage.cost },
  };
}

/**
 * Один запрос к OpenRouter. Тайм-аут через clock.sleep обрывает и запрос, и чтение ответа.
 * Любой сбой приходит значением, наружу ничего не выходит; в лог только статус HTTP или имя ошибки.
 */
async function requestTranscript(
  deps: OpenRouterTranscriberDeps,
  clip: AudioClip,
  format: string,
): Promise<CallOutcome> {
  const request = new AbortController();
  const timer = new AbortController();
  void deps.clock.sleep(deps.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS, timer.signal).then(
    () => request.abort(),
    // Пауза снята: ответ пришёл раньше тайм-аута.
    () => undefined,
  );
  try {
    const response = await deps.fetchFn(OPENROUTER_TRANSCRIPTIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: deps.model,
        input_audio: { data: Buffer.from(clip.data).toString('base64'), format },
      }),
      // Переадресация не нужна: ключ не уходит никуда, кроме адреса OpenRouter.
      redirect: 'error',
      signal: request.signal,
    });
    if (!response.ok) {
      deps.logger.warn({ status: response.status }, 'OpenRouter отказал в расшифровке голосового');
      const failure = response.status === HTTP_TOO_MANY_REQUESTS ? 'rate_limited' : 'unavailable';
      return { result: { ok: false, failure }, usage: NO_USAGE };
    }
    return outcomeOf(await response.json());
  } catch (error: unknown) {
    // Сеть, тайм-аут (AbortError) или ответ не JSON: вызывающий ответит фразой про голосовое.
    deps.logger.warn({ errorName: errorNameOf(error) }, 'Расшифровка голосового не получена');
    return { result: UNAVAILABLE, usage: NO_USAGE };
  } finally {
    timer.abort();
    // Непрочитанное тело ответа с ошибкой держало бы соединение: обрываем его.
    request.abort();
  }
}

async function transcribeClip(
  deps: OpenRouterTranscriberDeps,
  clip: AudioClip,
  chatId: ChatId,
): Promise<LlmResult<string>> {
  const format = audioFormatOf(clip);
  if (format === null) return UNAVAILABLE;
  const decision = deps.budget.tryConsume(chatId, deps.clock.now());
  if (!decision.ok) return { ok: false, failure: 'budget_exceeded', scope: decision.scope };
  const { result, usage, spend } = await requestTranscript(deps, clip, format);
  if (spend !== undefined) {
    // Только числа из ответа OpenRouter: без расшифровки, номера и ключа.
    deps.logger.info({ ...spend }, 'Расход на расшифровку голосового');
  }
  try {
    await deps.tokenLog.record({
      provider: 'openrouter',
      purpose: 'transcribe',
      model: deps.model,
      input: usage.input,
      output: usage.output,
      cacheRead: 0,
      cacheWrite: 0,
      chatId,
      ok: result.ok,
    });
  } catch (error: unknown) {
    // Как у клиента Claude: оплаченная расшифровка не теряется, сбой записи виден в логе.
    deps.logger.error(
      { errorName: errorNameOf(error) },
      'Расход OpenRouter не записан в лог токенов',
    );
  }
  return result;
}

/**
 * Расшифровка голосовых через OpenRouter (перенесено владельцем с этапа 7 на этап 3).
 * Реальные вызовы только с разрешения владельца: тесты на моках fetchFn.
 * Неизвестный тип, пустое аудио или больше MAX_AUDIO_BYTES => 'unavailable' без вызова API и без списания лимита.
 * Перед запросом budget.tryConsume(chatId, clock.now()); отказ => 'budget_exceeded' со scope, без запроса.
 * Запрос: POST OPENROUTER_TRANSCRIPTIONS_URL, Bearer ключ, JSON { model, input_audio: { data: base64, format } }.
 * Ответ { text, usage }: usage.input_tokens и output_tokens в лог расхода (нет полей => 0), cacheRead и cacheWrite 0;
 * usage.seconds и usage.cost (доллары) уходят в лог приложения строкой info на каждый полученный ответ.
 * Каждый запрос пишется в TokenLog (provider 'openrouter', purpose 'transcribe'), ok как у результата;
 * сбой записи не теряет расшифровку и уходит в лог ошибкой.
 * HTTP 429 => 'rate_limited'; другой отказ HTTP, сеть и тайм-аут => 'unavailable' (статус или имя ошибки в лог);
 * пустая расшифровка => 'invalid_output'.
 * Повторов нет: при любом сбое вызывающий отвечает фразой про голосовое, клиент напишет текстом.
 * Голосовые WhatsApp уходят как format 'ogg'. Если живой тест (только с разрешения владельца) покажет отказ,
 * понадобится перекодирование в wav.
 */
export function createOpenRouterTranscriber(deps: OpenRouterTranscriberDeps): Transcriber {
  return {
    enabled: true,
    transcribe: (clip, chatId) => transcribeClip(deps, clip, chatId),
  };
}

/**
 * Выключенная расшифровка: нет ключа OpenRouter. На голосовое конвейер отвечает ровно «Сейчас не могу
 * прослушать голосовое, напишите, пожалуйста, текстом» через outbox.sendVoiceNotice (решение владельца), без LLM.
 */
export function createDisabledTranscriber(): Transcriber {
  return { enabled: false };
}
