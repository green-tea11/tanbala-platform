// Ответы /api консоли, которые читает страница (console/docs/API.md; поля бота и почты — contract/CONSOLE_API.md).
// Только то, что использует интерфейс: лишние поля сервер может прислать, страница их не трогает.

export interface Unavailable {
  readonly unavailable: true;
  readonly reason?: string;
  readonly source?: 'wa' | 'leads';
  readonly message?: string;
}

export type Section<T> = T | Unavailable;

export function isUnavailable<T>(value: Section<T> | null | undefined): value is Unavailable {
  return typeof value === 'object' && value !== null && 'unavailable' in value && value.unavailable === true;
}

export type Level = 'cold' | 'warm' | 'hot';
export type ChatStatus = 'bot' | 'manager';

export interface Session {
  readonly user: { readonly name: string; readonly role: 'owner' | 'manager' };
  readonly csrfToken: string;
}

export interface ModeLine {
  readonly code: string;
  readonly text: string;
  readonly testAddress?: string;
}

export interface BotStatus {
  readonly whatsapp: { readonly enabled: boolean; readonly state: 'open' | 'connecting' | 'closed' | 'disabled'; readonly since: string | null };
  readonly testMode: boolean;
  readonly allowlistSize: number;
  readonly managerConfigured: boolean;
  readonly apiCalls: { readonly today: number; readonly dailyLimit: number };
}

export interface NotificationMark {
  readonly status: string;
  readonly statusLabel: string;
  readonly attempts: number;
}

export interface AttentionHandoff {
  readonly id: number;
  readonly chatId: number;
  readonly name: string | null;
  readonly phone: string | null;
  readonly reason: string;
  readonly reasonLabel: string;
  readonly level: Level | null;
  readonly levelLabel?: string;
  readonly openedAt: string;
  readonly notification: NotificationMark | null;
  readonly seen?: boolean;
}

export interface AttentionHot {
  readonly chatId: number;
  readonly name: string | null;
  readonly phone: string | null;
  readonly status: ChatStatus;
  readonly levelReason: string | null;
  readonly levelUpdatedAt: string | null;
  readonly lastMessageAt: string | null;
}

export interface AttentionWaiting {
  readonly chatId: number;
  readonly name: string | null;
  readonly phone: string | null;
  readonly status: ChatStatus;
  readonly group: 'manager' | 'bot';
  readonly waitingSince: string;
  readonly lastClientAt: string;
  readonly complaint: boolean;
  /** Добавляет заглушка/консоль для строки: компания и последнее сообщение (если есть). */
  readonly companyName?: string | null;
  readonly lastText?: string | null;
}

export interface Attention {
  readonly handoffs: readonly AttentionHandoff[];
  readonly hot: readonly AttentionHot[];
  readonly waiting: readonly AttentionWaiting[];
  readonly backlog: { readonly pending: number };
  readonly newHandoffs?: number;
  readonly counts?: {
    readonly handoffs: { readonly total: number; readonly truncated: boolean };
    readonly hot: { readonly total: number; readonly truncated: boolean };
    readonly waiting: { readonly total: number; readonly truncated: boolean; readonly staleExcluded: number };
  };
}

export interface RunStage {
  readonly code: string;
  readonly label: string;
  /** Как у почты (web/views.py stage_states): current — идёт сейчас, failed — запуск упал на нём. */
  readonly state: 'done' | 'current' | 'failed' | 'pending';
  readonly stateLabel: string;
  readonly hint?: string;
  readonly counters?: readonly { readonly field: string; readonly label: string; readonly value: number }[];
}

export interface Run {
  readonly id: number;
  readonly cityName: string;
  readonly query: string;
  readonly industries: readonly string[];
  readonly maxCompanies: number;
  readonly status: string;
  readonly statusLabel: string;
  readonly stageLabel: string;
  readonly stageDetail: string | null;
  readonly found: number;
  readonly newCompanies: number;
  readonly crawled: number;
  readonly qualified: number;
  readonly drafted: number;
  readonly errors: number;
  readonly startedAt: string | null;
  readonly stages: readonly RunStage[];
}

export interface ResearchJob {
  readonly id: string;
  readonly name: string;
  readonly cityName?: string;
  readonly status: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
}

export interface LeadsSummary {
  readonly testMode: { readonly testAddress: string | null };
  readonly budget: { readonly dailyUsd: number | null; readonly spentTodayUsd: number; readonly over: boolean };
  readonly overview: {
    readonly companiesFound: number;
    readonly companiesFit: number;
    readonly avgScoreFit: number | null;
    readonly lettersPending: number;
    readonly lettersApproved: number;
    readonly whatsappCompanies: number;
  };
  readonly activeRun: Run | null;
  readonly research: { readonly today: number; readonly perDay: number; readonly active: readonly ResearchJob[] };
  readonly testSends: { readonly today: number; readonly perDay: number };
}

export interface SpendTotal {
  readonly usd: number | null;
  readonly tokens: number;
  readonly unpricedTokens: number;
  readonly calls: number;
  readonly notCountedCalls: number;
}

export interface HomeSpend {
  readonly day: string;
  readonly monthFrom: string;
  readonly bot: Section<{ readonly today: SpendTotal; readonly month: SpendTotal }>;
  readonly leads: Section<{ readonly today: SpendTotal; readonly month: SpendTotal }>;
  readonly leadsBudget: Section<{ readonly dailyUsd: number | null; readonly spentTodayUsd: number; readonly leftUsd: number | null; readonly over: boolean }>;
  readonly botCalls: Section<{ readonly today: number; readonly dailyLimit: number; readonly left: number }>;
}

export interface AfterLetterItem {
  readonly chatId: number;
  readonly companyId: number;
  readonly chatName: string | null;
  readonly companyName: string | null;
  readonly firstLetterAt: string;
  readonly firstClientMessageAt: string;
  readonly daysAfter: number;
  readonly seen: boolean;
}

export interface Home {
  readonly generatedAt: string;
  readonly mode: { readonly bot: ModeLine; readonly leads: ModeLine; readonly lettersNote: string };
  readonly botStatus: Section<BotStatus>;
  readonly attention: Section<Attention>;
  readonly leadsSummary: Section<LeadsSummary>;
  readonly spend: HomeSpend;
  readonly afterLetter: Section<{
    readonly items: readonly AfterLetterItem[];
    readonly total: number;
    readonly newCount: number;
    readonly linksTruncated: boolean;
    readonly note: string;
  }>;
}

// ---- карточка клиента ----

export interface ProfileField {
  readonly key: string;
  readonly label: string;
  readonly value: string | null;
  readonly inferred: boolean;
}

export interface Message {
  readonly id: number;
  readonly author: 'client' | 'bot' | 'human_phone' | 'human_panel';
  readonly authorLabel: string;
  readonly kind: 'text' | 'voice' | 'other';
  readonly text: string | null;
  readonly at: string;
}

export interface Handoff {
  readonly id: number;
  readonly reason: string;
  readonly reasonLabel: string;
  readonly level: Level | null;
  readonly levelLabel?: string;
  readonly openedAt: string;
  readonly resolvedAt: string | null;
}

export interface Pain {
  readonly pain: string;
  readonly evidence: string;
  readonly source: string;
  readonly sourceLabel: string;
  readonly verified?: boolean;
}

export interface BotCompany {
  readonly state: 'confirmed' | 'candidate' | 'unknown' | 'off' | 'not_read';
  readonly stateLabel: string;
  readonly candidate: { readonly id: number; readonly name: string; readonly city: string | null; readonly sourceLabel: string } | null;
  readonly confirmed: {
    readonly id: number;
    readonly name: string;
    readonly city: string | null;
    readonly rubric: string | null;
    readonly emailed: boolean;
    readonly pains: readonly Pain[];
  } | null;
  readonly research: { readonly status: string; readonly label: string } | null;
  readonly confirmedPains: readonly string[];
  readonly statedName: string | null;
}

/** Сильная сторона Tanbala, уже рассказанная клиенту: номер F1…F10 и короткое название. */
export interface ToldFact {
  readonly id: string;
  readonly label: string;
}

/** Что для расчёта известно (inferred: вывод из слов клиента) и чего не хватает, по порядку разговора. */
export interface CalcState {
  readonly known: readonly { readonly key: string; readonly label: string; readonly inferred: boolean }[];
  readonly missing: readonly { readonly key: string; readonly label: string }[];
}

export interface ChatCard {
  readonly chat: {
    readonly id: number;
    readonly name: string | null;
    readonly phone: string | null;
    readonly phoneHidden: boolean;
    readonly status: ChatStatus;
    readonly statusBy: string;
    readonly statusLabel: string;
    readonly statusChangedAt: string | null;
    readonly level: Level | null;
    readonly levelLabel: string | null;
    readonly createdAt: string;
    readonly priceAsks: number;
    /** Сильные стороны, уже рассказанные клиенту (бот с 31.10.2026); у бота старше поля нет. */
    readonly toldFacts?: readonly ToldFact[];
  };
  readonly profile: {
    readonly fields: readonly ProfileField[];
    /** Что для расчёта известно и чего не хватает (бот с 31.10.2026); у бота старше поля нет. */
    readonly calc?: CalcState;
    readonly problemAgreed: boolean;
    /** Причина оценки; при передаче чата ботом причина передачи своими словами с цитатой клиента. */
    readonly levelReason: string | null;
    readonly updatedAt: string | null;
  };
  readonly note: { readonly text: string; readonly at: string } | null;
  readonly openHandoff: Omit<Handoff, 'id' | 'resolvedAt'> | null;
  readonly handoffs: readonly Handoff[];
  readonly lastNotification: (NotificationMark & { readonly kindLabel: string; readonly at: string; readonly text: string }) | null;
  readonly company: BotCompany;
  readonly rejected: {
    readonly items: readonly { readonly at: string; readonly attempt: number; readonly sourceLabel: string; readonly draft: string; readonly remarks: readonly string[] }[];
    readonly total: number;
  };
  readonly messages: { readonly items: readonly Message[]; readonly earlierBefore: number | null };
}

export interface LeadsCompanyCard {
  readonly company: {
    readonly id: number;
    readonly name: string;
    readonly rubric: string | null;
    readonly cityName: string | null;
    readonly address: string | null;
    readonly phones: readonly string[];
    readonly website: string | null;
    readonly sourceUrl: string | null;
    readonly branchesCount: number | null;
    readonly statusLabel: string;
    readonly requestedVia: string | null;
    readonly whatsappContactedAt: string | null;
  };
  readonly qualification: { readonly fitLabel: string | null; readonly score: number | null; readonly segment: string | null; readonly reason: string | null } | null;
  readonly pains: readonly Pain[];
  readonly draft: { readonly id: number; readonly subject: string; readonly reviewLabel: string; readonly approvedBy: string | null; readonly approvedAt: string | null } | null;
  readonly history: readonly { readonly id: number; readonly occurredAt: string; readonly whatLabel: string; readonly sourceLabel: string; readonly subject: string | null; readonly email: string }[];
  readonly blocked: boolean;
}

export interface ClientCard {
  readonly chat: ChatCard;
  readonly company: null | {
    readonly id: number;
    readonly confirmed: boolean;
    readonly label: string;
    readonly leads: Section<LeadsCompanyCard> | { readonly notFound: true; readonly message: string };
  };
}
