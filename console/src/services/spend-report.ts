import type { LeadsApi } from '../backends/leads.js';
import { sectionOf } from '../backends/result.js';
import type { WaApi } from '../backends/wa.js';
import { spendByDay, sumSpend, type TokenRow } from '../domain/spend.js';

export interface SpendReportDeps {
  readonly leads: LeadsApi;
  readonly wa: WaApi;
}

/**
 * «Система → расход по дням»: токены и доллары бота и почты по дням за from..to (не больше 62 дней) по одной
 * таблице цен почты. Почта недоступна — у бота доллары null (цен нет), токены видны.
 */
export async function buildSpendReport(deps: SpendReportDeps, from: string, to: string) {
  const [leadsSpend, waSpend] = await Promise.all([
    deps.leads.spend(from, to),
    deps.wa.spend(from, to),
  ]);
  const prices = leadsSpend.ok ? leadsSpend.data.prices : null;
  const side = (rows: readonly TokenRow[]) => ({
    days: spendByDay(rows, prices),
    total: sumSpend(rows, prices),
  });
  return {
    from,
    to,
    pricesAsOf: leadsSpend.ok ? (leadsSpend.data.pricesAsOf ?? null) : null,
    prices,
    bot: sectionOf(waSpend, (data) => side(data.rows)),
    leads: sectionOf(leadsSpend, (data) => side(data.rows)),
  };
}

/** Есть ли связь с приложениями: да/нет, без данных (для /healthz и health.sh). */
export async function checkBackends(deps: SpendReportDeps) {
  const [leads, wa] = await Promise.all([deps.leads.activeRun(), deps.wa.status()]);
  return { leads: leads.ok, wa: wa.ok };
}
