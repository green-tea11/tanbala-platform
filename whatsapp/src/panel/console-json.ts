import { profileEntries } from '../agent/profile.js';
import type { CompanyPain, CompanySummary, ResearchState } from '../domain/company.js';
import type { ConsoleChatRow, HandoffHistoryRow } from '../domain/console.js';
import type {
  BotNote,
  ChatControl,
  ClientProfile,
  Jid,
  ManagerNotification,
  OpenHandoff,
  ProfileFact,
  RejectionSource,
  StoredMessage,
  StoredRejectedDraft,
} from '../domain/types.js';
import { companyCardHref } from '../handoff/card-link.js';
import { jidToPhone } from '../whatsapp/jid.js';
import {
  AUTHOR_LABELS,
  controlLabel,
  HANDOFF_REASON_LABELS,
  LEVEL_LABELS,
  NOTIFICATION_KIND_LABELS,
  NOTIFICATION_STATUS_LABELS,
} from './format.js';
import { cleanText } from './html.js';
import {
  FAIL_LABELS,
  PAIN_SOURCE_LABELS,
  SOURCE_LABELS,
  STATUS_LABELS as COMPANY_STATUS_LABELS,
} from './view-company.js';

// Данные бота в JSON для консоли. Всё, что пришло из WhatsApp, от модели и из почтового проекта, проходит cleanText
// старой панели (без управляющих символов и символов смены направления) и отдаётся строкой как данные.

/** Весь Казахстан с 01.03.2024 живёт по UTC+5 без летнего времени: сутки Алматы начинаются в 19:00 UTC. */
const ALMATY_OFFSET_MS = 5 * 60 * 60_000;
/** Длина текста последнего сообщения в строке списка чатов, в символах. */
export const LAST_MESSAGE_MAX_LENGTH = 140;
const ELLIPSIS = '…';
const NOT_READ_LABEL = 'данные не прочитаны';
const NO_REMARKS = 'причина не названа';

const REJECTION_SOURCE_LABELS: Readonly<Record<RejectionSource, string>> = {
  code: 'проверка кодом',
  review: 'проверка вторым вызовом',
};

/** Время ISO 8601 UTC; нет или не время => null. */
export function isoOrNull(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Сутки ГГГГ-ММ-ДД по Алматы. */
export function almatyDayOf(ms: number): string {
  return new Date(ms + ALMATY_OFFSET_MS).toISOString().slice(0, 10);
}

/** Недоверенный текст: без скрытых символов; пусто после чистки => null. */
export function cleanOrNull(value: string | null): string | null {
  if (value === null) return null;
  const text = cleanText(value);
  return text.trim() === '' ? null : text;
}

/** Имя из профиля WhatsApp без скрытых символов и пробелов по краям; нет => null (консоль пишет «без имени»). */
export function nameOf(pushName: string | null): string | null {
  return pushName === null ? null : (cleanOrNull(pushName)?.trim() ?? null);
}

/** Номер цифрами из адреса с номером; у чата только с @lid номера нет => null. */
export function phoneOf(pnJid: Jid | null): string | null {
  return pnJid === null ? null : jidToPhone(pnJid);
}

/** Кто ведёт чат: статус, кто решил и подпись старой панели. */
export function controlJson(control: ChatControl): Record<string, unknown> {
  return { status: control.status, statusBy: control.by, statusLabel: controlLabel(control) };
}

/** Открытая передача: причина, уровень на момент передачи и время. */
export function openHandoffJson(handoff: OpenHandoff | null): Record<string, unknown> | null {
  if (handoff === null) return null;
  return {
    reason: handoff.reason,
    reasonLabel: HANDOFF_REASON_LABELS[handoff.reason],
    level: handoff.level,
    levelLabel: LEVEL_LABELS[handoff.level],
    openedAt: isoOrNull(handoff.openedAtMs),
  };
}

/** Текст строки списка: без скрытых символов, до LAST_MESSAGE_MAX_LENGTH символов с многоточием. */
function shortText(text: string | null): string | null {
  const clean = cleanOrNull(text);
  if (clean === null) return null;
  const chars = [...clean];
  return chars.length <= LAST_MESSAGE_MAX_LENGTH
    ? clean
    : `${chars.slice(0, LAST_MESSAGE_MAX_LENGTH - 1).join('')}${ELLIPSIS}`;
}

/** Строка списка чатов консоли. */
export function chatRowJson(row: ConsoleChatRow): Record<string, unknown> {
  const phone = phoneOf(row.pnJid);
  const { lastMessage, company } = row;
  return {
    id: row.id,
    name: nameOf(row.pushName),
    phone,
    phoneHidden: phone === null,
    ...controlJson(row.control),
    level: row.level,
    levelLabel: LEVEL_LABELS[row.level],
    lastMessageAt: isoOrNull(row.lastMessageAtMs),
    lastMessage:
      lastMessage === null
        ? null
        : { author: lastMessage.author, kind: lastMessage.kind, text: shortText(lastMessage.text) },
    openHandoff: openHandoffJson(row.openHandoff),
    company:
      company === null
        ? null
        : { state: company.state, id: company.id, name: cleanOrNull(company.name)?.trim() ?? null },
    waitingSince: isoOrNull(row.waitingSinceMs),
  };
}

/** Сообщение переписки: голосовое без расшифровки и «другого вида» приходят с text null и своим kind. */
export function messageJson(message: StoredMessage): Record<string, unknown> {
  return {
    id: message.id,
    author: message.author,
    authorLabel: AUTHOR_LABELS[message.author],
    kind: message.kind,
    text: cleanOrNull(message.text),
    at: isoOrNull(message.tsMs),
  };
}

/** Ключи 14 полей выжимки по порядку agent/profile.profileEntries (подписи берутся оттуда же). */
const PROFILE_KEYS = [
  'business',
  'items',
  'packaging',
  'material',
  'city',
  'premises',
  'area',
  'itemCount',
  'turnover',
  'scope',
  'currentTracking',
  'problem',
  'oneC',
  'specifics',
] as const;

type ProfileKey = (typeof PROFILE_KEYS)[number];

/** 1С словами без пометки «вероятно»: «есть, <какая>», «есть, конфигурация не выяснена», «нет» или название. */
function oneCValue(profile: ClientProfile): string | null {
  if (profile.has1C === null) return profile.oneCName;
  if (!profile.has1C) return 'нет';
  return `есть, ${profile.oneCName ?? 'конфигурация не выяснена'}`;
}

function rawValue(profile: ClientProfile, key: ProfileKey): string | null {
  return key === 'oneC' ? oneCValue(profile) : profile[key];
}

function isInferred(profile: ClientProfile, key: ProfileKey): boolean {
  const facts: readonly ProfileFact[] = key === 'oneC' ? ['has1C', 'oneCName'] : [key];
  return facts.some((fact) => profile.inferred.includes(fact));
}

/**
 * Поля выжимки: ключ, подпись старой панели, значение со слов клиента без пометки «вероятно» (null: не выяснили) и
 * inferred — значение выведено из слов клиента, консоль пишет перед ним «вероятно».
 */
export function profileFieldsJson(profile: ClientProfile): readonly Record<string, unknown>[] {
  const labels = profileEntries(profile).map((entry) => entry.label);
  return PROFILE_KEYS.map((key, index) => ({
    key,
    label: labels[index] ?? key,
    value: cleanOrNull(rawValue(profile, key))?.trim() ?? null,
    inferred: isInferred(profile, key),
  }));
}

export function noteJson(note: BotNote | null): Record<string, unknown> | null {
  if (note === null) return null;
  return { text: cleanText(note.text), at: isoOrNull(note.atMs) };
}

export function handoffHistoryJson(row: HandoffHistoryRow): Record<string, unknown> {
  return {
    id: row.id,
    reason: row.reason,
    reasonLabel: HANDOFF_REASON_LABELS[row.reason],
    level: row.level,
    levelLabel: LEVEL_LABELS[row.level],
    openedAt: isoOrNull(row.openedAtMs),
    resolvedAt: isoOrNull(row.resolvedAtMs),
  };
}

/** Уведомление менеджеру: вид, статус и попытки, время создания и последней попытки, полный текст. */
export function notificationJson(item: ManagerNotification): Record<string, unknown> {
  return {
    id: item.id,
    at: isoOrNull(item.createdAtMs),
    updatedAt: isoOrNull(item.updatedAtMs),
    kind: item.kind,
    kindLabel: NOTIFICATION_KIND_LABELS[item.kind],
    status: item.status,
    statusLabel: NOTIFICATION_STATUS_LABELS[item.status],
    attempts: item.attempts,
    chatId: item.chatId,
    text: cleanText(item.text),
  };
}

export function rejectedJson(item: StoredRejectedDraft): Record<string, unknown> {
  const remarks = item.remarks.map((remark) => cleanText(remark).trim()).filter((r) => r !== '');
  return {
    at: isoOrNull(item.atMs),
    attempt: item.attempt,
    source: item.source,
    sourceLabel: REJECTION_SOURCE_LABELS[item.source],
    draft: cleanText(item.draft),
    remarks: remarks.length === 0 ? [NO_REMARKS] : remarks,
  };
}

function painJson(pain: CompanyPain): Record<string, unknown> {
  return {
    pain: cleanOrNull(pain.pain)?.trim() ?? 'без названия',
    evidence: cleanOrNull(pain.evidence)?.trim() ?? null,
    source: pain.source,
    sourceLabel: pain.source === null ? null : PAIN_SOURCE_LABELS[pain.source],
  };
}

/** Проверка новой компании: состояние, подпись старой панели и время. */
function researchJson(research: ResearchState | null): Record<string, unknown> | null {
  if (research === null) return null;
  if (research.status === 'done') {
    return {
      status: 'done',
      label: 'завершена, компания найдена',
      startedAt: null,
      finishedAt: isoOrNull(research.finishedAtMs),
    };
  }
  if (research.status === 'failed') {
    return {
      status: 'failed',
      reason: research.reason,
      label: FAIL_LABELS[research.reason ?? 'error'],
      startedAt: null,
      finishedAt: isoOrNull(research.finishedAtMs),
    };
  }
  return {
    status: research.status,
    label: 'идёт',
    startedAt: isoOrNull(research.startedAtMs),
    finishedAt: null,
  };
}

/** Текст сводки о компании: без скрытых символов и пробелов по краям; пусто => null. */
function textOf(value: string | null): string | null {
  return cleanOrNull(value)?.trim() ?? null;
}

/**
 * Сводка бота о компании целиком: состояние с подписью, кандидат (не подтверждён), подтверждённая компания со справкой,
 * проверка новой компании, боли со слов клиента, название со слов клиента и ссылка на карточку почтового проекта
 * (только http и https). summary null: сводку прочитать не удалось.
 */
export function companyJson(summary: CompanySummary | null): Record<string, unknown> {
  if (summary === null) {
    return {
      state: 'not_read',
      stateLabel: NOT_READ_LABEL,
      candidate: null,
      confirmed: null,
      research: null,
      confirmedPains: [],
      statedName: null,
      cardUrl: null,
    };
  }
  const { status, companyId: id, candidateSource: source } = summary;
  const name = textOf(summary.name);
  const city = textOf(summary.city);
  return {
    state: status,
    stateLabel: COMPANY_STATUS_LABELS[status],
    candidate:
      status === 'candidate' && id !== null
        ? { id, name, city, source, sourceLabel: source === null ? null : SOURCE_LABELS[source] }
        : null,
    confirmed:
      status === 'confirmed' && id !== null
        ? {
            id,
            name,
            city,
            rubric: textOf(summary.rubric),
            emailed: summary.emailed,
            pains: summary.briefPains.map(painJson),
          }
        : null,
    research: researchJson(summary.research),
    confirmedPains: summary.confirmedPains.map(textOf).filter((pain) => pain !== null),
    statedName: textOf(summary.statedName),
    cardUrl: companyCardHref(summary.cardUrl),
  };
}
