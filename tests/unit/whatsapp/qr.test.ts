import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../../src/domain/ports.js';
import { createQrPresenter } from '../../../src/whatsapp/qr.js';

// Похоже на QR привязки Baileys: ref, ключи и секрет через запятую.
const QR = '2@Q1w2E3r4T5y6U7i8O9p0,bm9pc2Uta2V5LWJhc2U2NA==,aWRlbnRpdHkta2V5,YWR2LXNlY3JldA==';
const NEXT_QR = '2@Z9x8C7v6B5n4M3,bm9pc2Uta2V5LWJhc2U2NA==,aWRlbnRpdHkta2V5,YWR2LXNlY3JldA==';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HINT = 'WhatsApp => Связанные устройства => Привязка устройства';

interface LogEntry {
  readonly level: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly message: string | undefined;
}

interface Captured {
  readonly output: { readonly isTTY: boolean; write(text: string): boolean };
  readonly logger: Logger;
  readonly logs: LogEntry[];
  text(): string;
}

function capture(isTTY: boolean): Captured {
  const chunks: string[] = [];
  const logs: LogEntry[] = [];
  const log =
    (level: string) =>
    (context: Readonly<Record<string, unknown>>, message?: string): void => {
      logs.push({ level, context, message });
    };
  const logger: Logger = {
    level: 'info',
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    fatal: log('fatal'),
    silent: log('silent'),
    child: () => logger,
  };
  return {
    output: {
      isTTY,
      write: (text: string): boolean => {
        chunks.push(text);
        return true;
      },
    },
    logger,
    logs,
    text: () => chunks.join(''),
  };
}

describe('whatsapp/qr: показ QR для привязки', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tanbala-qr-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('терминал: QR печатается текстом с подсказкой, где в WhatsApp привязать устройство', async () => {
    const captured = capture(true);
    const pngPath = join(dir, 'qr.png');
    const presenter = createQrPresenter({ ...captured, pngPath });

    await presenter.show(QR);

    const terminalQr = await QRCode.toString(QR, { type: 'terminal', small: true });
    expect(captured.text()).toContain(HINT);
    expect(captured.text()).toContain(terminalQr);
    expect(captured.text()).toContain(pngPath);
    expect(captured.logs).toEqual([]);
  });

  it('не терминал (служба, перенаправленный вывод): только PNG и строка в лог без самого QR', async () => {
    const captured = capture(false);
    const pngPath = join(dir, 'qr.png');
    const presenter = createQrPresenter({ ...captured, pngPath });

    await presenter.show(QR);

    expect(captured.text()).toBe('');
    expect(existsSync(pngPath)).toBe(true);
    expect(captured.logs).toEqual([
      expect.objectContaining({
        level: 'info',
        message: expect.stringContaining(pngPath) as string,
      }),
    ]);
    expect(JSON.stringify(captured.logs)).not.toContain(QR);
  });

  it('PNG того же QR пишется и создаёт для себя папку', async () => {
    const pngPath = join(dir, 'nested', 'qr.png');
    const presenter = createQrPresenter({ ...capture(true), pngPath });

    await presenter.show(QR);

    const png = await readFile(pngPath);
    expect(png.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
    expect(png).toEqual(await QRCode.toBuffer(QR, { type: 'png' }));
  });

  it('старый файл на месте картинки удаляется и пишется заново', async () => {
    const pngPath = join(dir, 'qr.png');
    await writeFile(pngPath, 'чужое содержимое');
    const presenter = createQrPresenter({ ...capture(false), pngPath });

    await presenter.show(QR);

    expect(await readFile(pngPath)).toEqual(await QRCode.toBuffer(QR, { type: 'png' }));
  });

  it('новый QR того же сеанса заменяет картинку и печатается снова', async () => {
    const captured = capture(true);
    const pngPath = join(dir, 'qr.png');
    const presenter = createQrPresenter({ ...captured, pngPath });

    await presenter.show(QR);
    await presenter.show(NEXT_QR);

    expect(await readFile(pngPath)).toEqual(await QRCode.toBuffer(NEXT_QR, { type: 'png' }));
    expect(captured.text().split(HINT)).toHaveLength(3);
  });

  it('clear удаляет картинку QR', async () => {
    const pngPath = join(dir, 'qr.png');
    const presenter = createQrPresenter({ ...capture(true), pngPath });
    await presenter.show(QR);

    await presenter.clear();

    expect(existsSync(pngPath)).toBe(false);
  });

  it('clear без картинки ничего не ломает', async () => {
    const presenter = createQrPresenter({
      ...capture(true),
      pngPath: join(dir, 'missing', 'qr.png'),
    });

    await expect(presenter.clear()).resolves.toBeUndefined();
  });

  it.each([true, false])(
    'пустой QR отклоняется (терминал: %s): ничего не печатается и не пишется',
    async (isTTY) => {
      const captured = capture(isTTY);
      const pngPath = join(dir, 'qr.png');
      const presenter = createQrPresenter({ ...captured, pngPath });

      await expect(presenter.show('')).rejects.toThrow();

      expect(captured.text()).toBe('');
      expect(captured.logs).toEqual([]);
      expect(existsSync(pngPath)).toBe(false);
    },
  );
});
