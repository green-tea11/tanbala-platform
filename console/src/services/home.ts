import { DIGEST_MAX_IDS, type LeadsApi } from '../backends/leads.js';
import {
  sectionOf,
  unavailableSection,
  type BackendResult,
  type Section,
} from '../backends/result.js';
import type {
  CompanyLinks,
  LeadsSpend,
  LeadsSummary,
  WaAttention,
  WaSpend,
  WaStatus,
} from '../backends/schemas.js';
import type { WaApi } from '../backends/wa.js';
import type { SeenRepo } from '../db/seen.js';
import {
  AFTER_LETTER_NOTE,
  wroteAfterLetter,
  type AfterLetterItem,
} from '../domain/after-letter.js';
import { modeBanner } from '../domain/mode.js';
import { rowsBetween, sumSpend, type PriceTable, type SpendTotal } from '../domain/spend.js';
import { almatyDay, almatyMonthStart } from '../domain/time.js';
import type { Clock } from '../shared/clock.js';

export interface HomeDeps {
  readonly leads: LeadsApi;
  readonly wa: WaApi;
  readonly seen: SeenRepo;
  readonly clock: Clock;
}

interface Period {
  readonly today: string;
  readonly monthFrom: string;
}

interface SideSpend {
  readonly today: SpendTotal;
  readonly month: SpendTotal;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
}

function sideSpend(
  rows: LeadsSpend['rows'] | WaSpend['rows'],
  prices: PriceTable | null,
  period: Period,
): SideSpend {
  return {
    today: sumSpend(rowsBetween(rows, period.today, period.today), prices),
    month: sumSpend(rowsBetween(rows, period.monthFrom, period.today), prices),
  };
}

/**
 * Расход API за сегодня и месяц для бота и почты по одной таблице цен почты; плюс остаток дневного бюджета почты
 * (её же расчёт spent_today_usd) и вызовов бота.
 */
function spendSection(
  results: {
    readonly leadsSpend: BackendResult<LeadsSpend>;
    readonly waSpend: BackendResult<WaSpend>;
    readonly summary: BackendResult<LeadsSummary>;
    readonly status: BackendResult<WaStatus>;
  },
  period: Period,
) {
  const { leadsSpend, waSpend, summary, status } = results;
  const prices = leadsSpend.ok ? leadsSpend.data.prices : null;
  return {
    day: period.today,
    monthFrom: period.monthFrom,
    pricesAsOf: leadsSpend.ok ? (leadsSpend.data.pricesAsOf ?? null) : null,
    bot: sectionOf(waSpend, (data) => sideSpend(data.rows, prices, period)),
    leads: sectionOf(leadsSpend, (data) => sideSpend(data.rows, prices, period)),
    leadsBudget: sectionOf(summary, ({ budget }) => ({
      dailyUsd: budget.dailyUsd,
      spentTodayUsd: budget.spentTodayUsd,
      leftUsd:
        budget.dailyUsd === null ? null : Math.max(0, budget.dailyUsd - budget.spentTodayUsd),
      over: budget.over,
    })),
    botCalls: sectionOf(status, ({ apiCalls }) => ({
      today: apiCalls.today,
      dailyLimit: apiCalls.dailyLimit,
      left: Math.max(0, apiCalls.dailyLimit - apiCalls.today),
    })),
  };
}

function attentionWithSeen(data: WaAttention, seen: ReadonlySet<number>) {
  const handoffs = data.handoffs.map((handoff) => ({ ...handoff, seen: seen.has(handoff.id) }));
  return { ...data, handoffs, newHandoffs: handoffs.filter((handoff) => !handoff.seen).length };
}

interface AfterLetterSection {
  readonly items: readonly (AfterLetterItem & { readonly seen: boolean })[];
  readonly total: number;
  readonly newCount: number;
  readonly note: string;
  /** Бот отдаёт не больше 1000 связей: true — часть могла не попасть. */
  readonly linksTruncated: boolean;
}

/** Предел связей чат → компания в одном ответе бота (контракт: до 1000). */
const LINKS_LIMIT = 1000;

/** «Писали после письма»: связи чат → компания от бота × digest почты (по 100 id за запрос). */
async function afterLetterSection(
  deps: HomeDeps,
  links: BackendResult<CompanyLinks>,
  userId: number,
): Promise<Section<AfterLetterSection>> {
  if (!links.ok) return unavailableSection(links.failure);
  const ids = [...new Set(links.data.items.map((link) => link.companyId))];
  const digests = await Promise.all(
    chunks(ids, DIGEST_MAX_IDS).map((part) => deps.leads.digest(part)),
  );
  const failed = digests.find((result) => !result.ok);
  if (failed !== undefined && !failed.ok) return unavailableSection(failed.failure);
  const companies = digests.flatMap((result) => (result.ok ? result.data.items : []));
  const items = wroteAfterLetter(
    links.data.items,
    new Map(companies.map((item) => [item.id, item])),
  );
  const seen = deps.seen.seenAmong(
    userId,
    'after_letter',
    items.map((item) => item.chatId),
  );
  const marked = items.map((item) => ({ ...item, seen: seen.has(item.chatId) }));
  return {
    items: marked,
    total: marked.length,
    newCount: marked.filter((item) => !item.seen).length,
    note: AFTER_LETTER_NOTE,
    linksTruncated: links.data.items.length >= LINKS_LIMIT,
  };
}

/**
 * Главная «Требует внимания»: полоса режима, состояние бота, передачи (с отметкой «видел» этого пользователя),
 * сводка почты, расход за сегодня и месяц, «писали после письма». Недоступное приложение — свой раздел
 * {unavailable: true}, остальное работает. Только чтение: в базу консоли ничего не пишется.
 */
export async function buildHome(deps: HomeDeps, userId: number) {
  const nowMs = deps.clock.now();
  const period: Period = { today: almatyDay(nowMs), monthFrom: almatyMonthStart(nowMs) };
  const [status, attention, summary, leadsSpend, waSpend, links] = await Promise.all([
    deps.wa.status(),
    deps.wa.attention(),
    deps.leads.summary(),
    deps.leads.spend(period.monthFrom, period.today),
    deps.wa.spend(period.monthFrom, period.today),
    deps.wa.companyLinks(),
  ]);
  const handoffIds = attention.ok ? attention.data.handoffs.map((handoff) => handoff.id) : [];
  const seenHandoffs = deps.seen.seenAmong(userId, 'handoff', handoffIds);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    mode: modeBanner(status, summary),
    botStatus: sectionOf(status, (data) => data),
    attention: sectionOf(attention, (data) => attentionWithSeen(data, seenHandoffs)),
    leadsSummary: sectionOf(summary, (data) => data),
    spend: spendSection({ leadsSpend, waSpend, summary, status }, period),
    afterLetter: await afterLetterSection(deps, links, userId),
  };
}
