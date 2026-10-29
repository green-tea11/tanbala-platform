import { describe, expect, it, vi } from 'vitest';
import { readLimitedBytes } from '../../../src/shared/read-limited.js';

const ENCODER = new TextEncoder();

function bodyOf(...chunks: readonly Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe('shared/read-limited readLimitedBytes', () => {
  it('тело из нескольких кусков собирается целиком', async () => {
    const response = bodyOf(ENCODER.encode('ab'), ENCODER.encode('cd'), ENCODER.encode('e'));

    const bytes = await readLimitedBytes(response, 100);

    expect(Buffer.from(bytes ?? new Uint8Array()).toString()).toBe('abcde');
  });

  it('ровно maxBytes принимается, на байт больше: null', async () => {
    const exact = await readLimitedBytes(bodyOf(new Uint8Array(6), new Uint8Array(4)), 10);
    const over = await readLimitedBytes(bodyOf(new Uint8Array(6), new Uint8Array(5)), 10);

    expect(exact?.byteLength).toBe(10);
    expect(over).toBeNull();
  });

  it('предел пройден: поток закрывается отменой и дальше не читается', async () => {
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(100));
      },
      cancel() {
        cancelled = true;
      },
    });

    const bytes = await readLimitedBytes(new Response(stream), 250);

    expect(bytes).toBeNull();
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(5);
  });

  it('пустое тело и ответ без тела: пустой результат, не null', async () => {
    expect((await readLimitedBytes(bodyOf(), 10))?.byteLength).toBe(0);
    expect((await readLimitedBytes(new Response(null, { status: 204 }), 10))?.byteLength).toBe(0);
  });

  it('сбой потока посреди тела поднимается наверх: решает вызывающий', async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new Uint8Array(3));
        else controller.error(new TypeError('terminated'));
      },
    });

    await expect(readLimitedBytes(new Response(stream), 100)).rejects.toThrow('terminated');
  });

  it('кусок не из байтов (подменённый ответ): ошибка, поток закрыт, обрывок не выдаётся', async () => {
    let cancelled = false;
    const stream = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue(new Uint8Array(3));
        controller.enqueue('строка вместо байтов');
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      readLimitedBytes(new Response(stream as ReadableStream<Uint8Array>), 100),
    ).rejects.toThrow(TypeError);

    expect(cancelled).toBe(true);
  });

  it('сигнал отмены закрывает поток, который встал, а чтение завершается ошибкой, а не обрывком тела', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new Uint8Array(3));
      },
      cancel() {
        cancelled = true;
      },
    });
    const reading = readLimitedBytes(new Response(stream), 100, controller.signal);
    const outcome = expect(reading).rejects.toThrow();

    await vi.waitFor(() => undefined);
    controller.abort();

    await outcome;
    expect(cancelled).toBe(true);
  });

  it('уже отменённый сигнал: ошибка, поток закрыт', async () => {
    const controller = new AbortController();
    controller.abort();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        streamController.enqueue(new Uint8Array(3));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readLimitedBytes(new Response(stream), 100, controller.signal)).rejects.toThrow();

    expect(cancelled).toBe(true);
  });
});
