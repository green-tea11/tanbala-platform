import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import QRCode from 'qrcode';
import type { Logger } from '../domain/ports.js';

/** Куда печатать QR: поток терминала (process.stdout) или поддельный поток в тестах. */
export interface QrOutput {
  write(text: string): unknown;
  /** Поток подключён к терминалу: только тогда QR печатается текстом (в журнал службы он не попадёт). */
  readonly isTTY?: boolean | undefined;
}

/** Показ QR привязки номера владельцу: в терминале (если это терминал) и картинкой PNG. */
export interface QrPresenter {
  /** Пишет PNG и печатает QR с подсказкой. Новый QR того же сеанса заменяет прежний. */
  show(qr: string): Promise<void>;
  /** Удаляет PNG: после привязки или остановки QR больше не нужен. Нет картинки: ничего не делает. */
  clear(): Promise<void>;
}

/** Настройки показа QR. */
export interface QrPresenterOptions {
  readonly output: QrOutput;
  /** Путь картинки PNG: внутри data/ или с именем qr*.png, чтобы она не попала в git. */
  readonly pngPath: string;
  /** Для строки «QR сохранён», когда вывод не терминал. Сам QR в лог не пишется никогда. */
  readonly logger: Logger;
}

/** QR даёт право привязать номер, пока не истёк: картинку читает только владелец файла. */
const PNG_FILE_MODE = 0o600;
const PAIRING_PATH = 'WhatsApp => Связанные устройства => Привязка устройства';

/**
 * Показывает QR привязки. Терминал (isTTY): QR текстом (qrcode, вид terminal, small) с короткой подсказкой и PNG.
 * Не терминал (служба, вывод в файл): только PNG и строка в лог с путём к картинке, сам QR в лог не попадает.
 * PNG: прежний файл удаляется, новый создаётся с флагом wx и правами 600, поэтому подложенный на его место файл
 * или ссылку не перезаписать.
 */
export function createQrPresenter(options: QrPresenterOptions): QrPresenter {
  const { output, pngPath, logger } = options;
  return {
    async show(qr: string): Promise<void> {
      const png = await QRCode.toBuffer(qr, { type: 'png' });
      if (output.isTTY === true) {
        const terminalQr = await QRCode.toString(qr, { type: 'terminal', small: true });
        output.write(`${pairingHint(pngPath)}\n${terminalQr}\n`);
      }
      await mkdir(dirname(pngPath), { recursive: true });
      await rm(pngPath, { force: true });
      await writeFile(pngPath, png, { flag: 'wx', mode: PNG_FILE_MODE });
      if (output.isTTY !== true) logger.info({}, `QR сохранён в ${pngPath}: ${PAIRING_PATH}`);
    },
    async clear(): Promise<void> {
      await rm(pngPath, { force: true });
    },
  };
}

function pairingHint(pngPath: string): string {
  return [
    `Привязка номера: ${PAIRING_PATH}, затем отсканируйте QR.`,
    `Тот же QR картинкой: ${pngPath}`,
  ].join('\n');
}
