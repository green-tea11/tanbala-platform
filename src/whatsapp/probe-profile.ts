import type { PhoneDigits } from '../domain/types.js';
import type { WaSocket } from './connection-types.js';
import { phoneToJid } from './jid.js';

// Запросы бизнес-профиля для пробы (whatsapp/probe.ts): только признаки полей, без значений, номеров и JID.

/** Признаки одного профиля: есть ли поле, без значений. website: сколько сайтов. */
export interface ProfileFlags {
  readonly business: boolean;
  readonly website: number;
  readonly email: boolean;
  readonly category: boolean;
  readonly description: boolean;
  readonly address: boolean;
}

/** Итог запроса: признаки или имя ошибки (status: код ответа WhatsApp, если он числовой). */
export type ProfileSummary = ProfileFlags | { readonly error: string; readonly status?: number };

/** Ответы по номеру и по LID. */
export interface ProfileReport {
  readonly number: ProfileSummary;
  readonly lid: ProfileSummary;
}

/** Части сокета для запросов: чтение бизнес-профиля и сопоставление LID. */
export type ProfileSocket = Pick<WaSocket, 'signalRepository' | 'getBusinessProfile'>;

function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Числовой код ответа WhatsApp из ошибки Baileys (Boom: output.statusCode); нет: undefined. */
export function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const output = (error as { readonly output?: { readonly statusCode?: unknown } }).output;
  return typeof output?.statusCode === 'number' ? output.statusCode : undefined;
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function websiteCount(value: unknown): number {
  return Array.isArray(value) ? (value as readonly unknown[]).filter(hasText).length : 0;
}

/** Признаки ответа getBusinessProfile: нет профиля (обычный аккаунт) business false и нули. */
function flagsOf(raw: unknown): ProfileSummary {
  if (raw === undefined || raw === null) {
    return {
      business: false,
      website: 0,
      email: false,
      category: false,
      description: false,
      address: false,
    };
  }
  if (typeof raw !== 'object') return { error: 'UnexpectedResponse' };
  const profile = raw as Readonly<Record<string, unknown>>;
  return {
    business: true,
    website: websiteCount(profile['website']),
    email: hasText(profile['email']),
    category: hasText(profile['category']),
    description: hasText(profile['description']),
    address: hasText(profile['address']),
  };
}

function failureOf(error: unknown): ProfileSummary {
  const status = statusOf(error);
  return status === undefined
    ? { error: errorNameOf(error) }
    : { error: errorNameOf(error), status };
}

async function summarize(query: () => Promise<unknown>): Promise<ProfileSummary> {
  try {
    return flagsOf(await query());
  } catch (error: unknown) {
    return failureOf(error);
  }
}

async function lidSummary(sock: ProfileSocket, pnJid: string): Promise<ProfileSummary> {
  let lidJid: string | null;
  try {
    lidJid = await sock.signalRepository.lidMapping.getLIDForPN(pnJid);
  } catch (error: unknown) {
    return failureOf(error);
  }
  if (lidJid === null) return { error: 'LID неизвестен' };
  return summarize(() => sock.getBusinessProfile(lidJid));
}

/** Два запроса по очереди: по номеру, затем по LID (если WhatsApp его сообщил). Сбои не бросаются, а идут в итог. */
export async function queryProfiles(
  sock: ProfileSocket,
  phone: PhoneDigits,
): Promise<ProfileReport> {
  const pnJid = phoneToJid(phone);
  const number = await summarize(() => sock.getBusinessProfile(pnJid));
  return { number, lid: await lidSummary(sock, pnJid) };
}
