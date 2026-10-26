import type { Logger, MessagesRepo, Transcriber, WhatsAppInbox } from '../domain/ports.js';
import type { BudgetScope, ChatId, InboundMessage, WaMessageId } from '../domain/types.js';
import { MAX_AUDIO_BYTES } from '../voice/transcriber.js';

// Расшифровка голосовых сообщений пачки (этап 7 перенесён на этап 3).

/** Лимит расшифровки в символах, как у текста сообщения (whatsapp/inbound.MAX_TEXT_CHARS). */
const MAX_TRANSCRIPT_CHARS = 4096;

/** Что нужно расшифровке: порт скачивания, расшифровщик, запись в базу и лог. */
export interface VoiceDeps {
  readonly messages: Pick<MessagesRepo, 'setTranscript'>;
  readonly transcriber: Transcriber;
  readonly inbox: Pick<WhatsAppInbox, 'downloadAudio'>;
  readonly logger: Logger;
}

/** Расшифровки голосовых пачки: уже известные по waId и голосовые, которые не удалось расшифровать. */
export interface Transcribed {
  readonly transcripts: ReadonlyMap<WaMessageId, string>;
  readonly unheard: ReadonlySet<WaMessageId>;
}

/** Пачка и то, что с ней уже сделано: при перегенерации расшифровка не повторяется. */
export interface VoiceBatch extends Transcribed {
  readonly messages: readonly InboundMessage[];
}

/** Расшифровка одного голосового. */
type Heard =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'unheard' }
  | { readonly kind: 'budget'; readonly scope: BudgetScope };

/**
 * Скачивает и расшифровывает голосовые пачки, которых ещё нет в transcripts и unheard. Расшифровка сохраняется
 * в базе (messages.setTranscript): следующие ответы видят в истории, что клиент сказал голосом. Расшифровка
 * выключена, сбой, пустой текст или голосовое, которого нет в памяти => голосовое в unheard. Исчерпан дневной лимит
 * API => { scope }: пачка дальше не обрабатывается. Вход не меняется, результат новый.
 */
export async function transcribeVoices(
  deps: VoiceDeps,
  chatId: ChatId,
  batch: VoiceBatch,
): Promise<Transcribed | { readonly scope: BudgetScope }> {
  const transcripts = new Map(batch.transcripts);
  const unheard = new Set(batch.unheard);
  for (const message of batch.messages) {
    const { content, waId } = message;
    if (content.kind !== 'voice' || transcripts.has(waId) || unheard.has(waId)) continue;
    const heard = await transcribe(deps, chatId, content.media);
    if (heard.kind === 'budget') return { scope: heard.scope };
    if (heard.kind === 'text') {
      saveTranscript(deps, chatId, waId, heard.text);
      transcripts.set(waId, heard.text);
    } else {
      unheard.add(waId);
    }
  }
  return { transcripts, unheard };
}

async function transcribe(
  deps: VoiceDeps,
  chatId: ChatId,
  media: Extract<InboundMessage['content'], { kind: 'voice' }>['media'],
): Promise<Heard> {
  const { transcriber } = deps;
  if (!transcriber.enabled) return { kind: 'unheard' };
  try {
    const clip = await deps.inbox.downloadAudio(media, MAX_AUDIO_BYTES);
    const result = await transcriber.transcribe(clip, chatId);
    if (result.ok) return heardText(result.value);
    if (result.failure === 'budget_exceeded') return { kind: 'budget', scope: result.scope };
    deps.logger.warn({ chatId, failure: result.failure }, 'Голосовое не расшифровано');
  } catch (error: unknown) {
    deps.logger.warn({ chatId, err: error }, 'Голосовое не скачано или не расшифровано');
  }
  return { kind: 'unheard' };
}

/** Расшифровка в базу: следующие ответы видят в истории, что клиент сказал голосом. */
function saveTranscript(deps: VoiceDeps, chatId: ChatId, waId: WaMessageId, text: string): void {
  if (!deps.messages.setTranscript(chatId, waId, text)) {
    deps.logger.warn(
      { chatId },
      'Расшифровка голосового не записана: в базе нет такого голосового без текста',
    );
  }
}

function heardText(raw: string): Heard {
  const text = Array.from(raw.trim()).slice(0, MAX_TRANSCRIPT_CHARS).join('');
  return text === '' ? { kind: 'unheard' } : { kind: 'text', text };
}
