import type { BackendResult } from '../backends/result.js';
import type { LeadsSummary, WaStatus } from '../backends/schemas.js';

export type BotModeCode = 'unavailable' | 'disabled' | 'disconnected' | 'test' | 'working';
export type LeadsModeCode = 'unavailable' | 'test_address' | 'test_off';

/** Полоса режима сверху каждого экрана: собирается из состояния бота и почты. */
export interface ModeBanner {
  readonly bot: { readonly code: BotModeCode; readonly text: string };
  readonly leads: {
    readonly code: LeadsModeCode;
    readonly text: string;
    readonly testAddress: string | null;
  };
  /** Всегда: настоящей отправки писем компаниям нет. */
  readonly lettersNote: string;
}

const LETTERS_NOTE = 'Компаниям письма не отправляются.';

function botMode(status: BackendResult<WaStatus>): ModeBanner['bot'] {
  if (!status.ok) return { code: 'unavailable', text: 'Бот не запущен или недоступен' };
  const { whatsapp, testMode, allowlistSize } = status.data;
  if (!whatsapp.enabled) return { code: 'disabled', text: 'WhatsApp выключен в настройках бота' };
  if (whatsapp.state !== 'open') return { code: 'disconnected', text: 'WhatsApp не подключён' };
  if (testMode) {
    const size = allowlistSize === undefined ? '' : ` (${allowlistSize})`;
    return { code: 'test', text: `Закрытый режим: бот отвечает только номерам из списка${size}` };
  }
  return { code: 'working', text: 'Рабочий режим: бот отвечает всем клиентам' };
}

function leadsMode(summary: BackendResult<LeadsSummary>): ModeBanner['leads'] {
  if (!summary.ok) {
    return { code: 'unavailable', text: 'Почта недоступна', testAddress: null };
  }
  const address = summary.data.testMode.testAddress;
  return address === null
    ? { code: 'test_off', text: 'Тестовая отправка выключена', testAddress: null }
    : { code: 'test_address', text: `Тестовые письма только на ${address}`, testAddress: address };
}

export function modeBanner(
  status: BackendResult<WaStatus>,
  summary: BackendResult<LeadsSummary>,
): ModeBanner {
  return { bot: botMode(status), leads: leadsMode(summary), lettersNote: LETTERS_NOTE };
}
