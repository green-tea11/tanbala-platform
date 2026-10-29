/** Кусок потока не байты: fetch так не отдаёт, а подменённый ответ мог бы. Целое тело из такого не собрать. */
const NOT_BYTES = 'Тело ответа читается только байтами';

/** Склеивает куски в свой массив, а не Buffer.concat: у Buffer из пула буфер общий, и data.buffer выдал бы чужие байты. */
function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

/**
 * Читает тело ответа потоком, обрывая его, как только байтов больше maxBytes: тогда null, а поток закрыт отменой
 * (лишнее не качается). Нет тела или оно пустое: пустой результат. Сбой потока, кусок не из байтов и отмена
 * по signal поднимаются ошибкой: обрывок тела за целое не выдаётся, а поток закрывается.
 */
export async function readLimitedBytes(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  const { body } = response;
  if (body === null) return new Uint8Array(0);
  // Тип куска у Response.body не задан: каждый проверяется ниже.
  const reader: ReadableStreamDefaultReader<unknown> = body.getReader();
  const cancel = (): void => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    signal?.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      // Отмена закрыла поток: чтение вернуло done, но тело неполное.
      signal?.throwIfAborted();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError(NOT_BYTES);
      total += value.byteLength;
      if (total > maxBytes) {
        cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch (error: unknown) {
    cancel();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  return concat(chunks, total);
}
