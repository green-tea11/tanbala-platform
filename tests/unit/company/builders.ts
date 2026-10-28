import { emptyCompanyState } from '../../../src/db/repos/chat-companies.js';
import type {
  ChatCandidate,
  ChatCompanyState,
  CompanyBrief,
  CompanyCandidate,
  CompanyId,
  ConfirmedCompany,
  ResearchJobId,
} from '../../../src/domain/company.js';
import type { ChatId } from '../../../src/domain/types.js';

// Строители данных компании для тестов: вымышленные компании и ID, без сети и базы.

/** 26.10.2026 07:30 UTC: общее «сейчас» тестов компании. */
export const NOW = Date.UTC(2026, 9, 26, 7, 30, 0);

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;

export function chatIdOf(value: number): ChatId {
  return value as ChatId;
}

export function companyIdOf(value: number): CompanyId {
  return value as CompanyId;
}

export function jobIdOf(value: string): ResearchJobId {
  return value as ResearchJobId;
}

export const CHAT_ID = chatIdOf(12);

/** Справка как в примере контракта: компания 8 с одной подтверждённой болью. */
export function makeBrief(overrides: Partial<CompanyBrief> = {}): CompanyBrief {
  return {
    id: companyIdOf(8),
    name: 'Платформа-А',
    city: 'Алматы',
    rubric: 'Складское хранение',
    segment: 'Склад, логистика, дистрибуция',
    fit: 'yes',
    fitScore: 80,
    reason: 'Ответственное хранение на нескольких складах, большой поток паллет',
    pains: [
      {
        pain: 'Инвентаризация занимает дни и отрывает людей',
        evidence: 'Складские помещения общей площадью более 11 000 м²',
        source: 'site',
      },
    ],
    emailed: false,
    emailedAt: null,
    emailSubject: null,
    ...overrides,
  };
}

/** Кандидат из lookup: по умолчанию совпадение по домену, оценка 1. */
export function makeCandidate(overrides: Partial<CompanyCandidate> = {}): CompanyCandidate {
  return {
    id: companyIdOf(8),
    name: 'Платформа-А',
    city: 'Алматы',
    rubric: 'Складское хранение',
    matchBy: 'domain',
    matchScore: 1,
    emailed: false,
    ...overrides,
  };
}

/** Кандидат в чате: найден, но не спрошен. */
export function makeChatCandidate(overrides: Partial<ChatCandidate> = {}): ChatCandidate {
  return {
    id: companyIdOf(8),
    name: 'Платформа-А',
    city: 'Алматы',
    source: 'profile_domain',
    askedAtMs: null,
    awaitingAnswer: false,
    ...overrides,
  };
}

/** Подтверждённая компания: по умолчанию без справки. */
export function makeConfirmed(overrides: Partial<ConfirmedCompany> = {}): ConfirmedCompany {
  return {
    id: companyIdOf(8),
    name: 'Платформа-А',
    city: 'Алматы',
    confirmedAtMs: NOW,
    brief: null,
    briefAtMs: null,
    ...overrides,
  };
}

/** Состояние чата: пустое, поверх него overrides. */
export function makeState(overrides: Partial<ChatCompanyState> = {}): ChatCompanyState {
  return { ...emptyCompanyState(CHAT_ID), ...overrides };
}

/**
 * Замораживает объект и всё, что в нём лежит: любая попытка изменить входные данные в тесте падает ошибкой
 * (модули ES работают в строгом режиме), так проверяется неизменяемость.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
