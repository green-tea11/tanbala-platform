import { Panel } from '../components/Bits';
import { count, usd } from '../lib/format';
import { isUnavailable, type HomeSpend, type SpendTotal } from '../lib/types';

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

/** Сумма из частей, как на экране: каждую часть округляем до цента и складываем. */
function sumShown(parts: readonly (number | null)[]): number | null {
  if (parts.some((p) => p === null)) return null;
  return parts.reduce<number>((acc, p) => acc + Math.round((p ?? 0) * 100) / 100, 0);
}

function part(section: HomeSpend['bot']): { today: SpendTotal; month: SpendTotal } | null {
  return isUnavailable(section) ? null : section;
}

export function SpendPanel({ spend, totalUsd }: { readonly spend: HomeSpend; readonly totalUsd?: number | null }) {
  const bot = part(spend.bot);
  const leads = part(spend.leads);
  const budget = isUnavailable(spend.leadsBudget) ? null : spend.leadsBudget;
  const calls = isUnavailable(spend.botCalls) ? null : spend.botCalls;
  const today = sumShown([bot?.today.usd ?? null, leads?.today.usd ?? null]);
  const month = sumShown([bot?.month.usd ?? null, leads?.month.usd ?? null]);
  const monthName = MONTHS[Number(spend.monthFrom.slice(5, 7)) - 1] ?? 'месяц';
  const notCounted = (bot?.today.notCountedCalls ?? 0) + (leads?.today.notCountedCalls ?? 0);
  const unpriced = (bot?.today.unpricedTokens ?? 0) + (leads?.today.unpricedTokens ?? 0);
  const share = budget?.dailyUsd ? Math.min(1, budget.spentTodayUsd / budget.dailyUsd) : null;

  return (
    <Panel
      id="spend"
      title="Расход Claude API"
      aside={<span>по Алматы</span>}
      foot={<span>{monthName.charAt(0).toUpperCase() + monthName.slice(1)}: {usd(month)}{bot && leads ? ` (бот ${usd(bot.month.usd)}, почта ${usd(leads.month.usd)})` : ''}{totalUsd != null ? `. Почта за всё время: ${usd(totalUsd)}` : ''}</span>}
    >
      <div className="spend-lead">
        <span className="num spend-figure">{usd(today)}</span>
        <span className="muted">сегодня{today === null ? ': часть данных недоступна' : ''}</span>
      </div>
      <ul className="facts">
        <li className="fact">
          <span>Бот</span>
          <span className="num fact-value">{bot ? usd(bot.today.usd) : '—'}</span>
        </li>
        <li className="fact sub">
          <span className="muted">вызовов за сутки</span>
          <span className="num muted">{calls ? `${count(calls.today)} из ${count(calls.dailyLimit)}` : '—'}</span>
        </li>
        <li className="fact">
          <span>Почта</span>
          <span className="num fact-value">{leads ? usd(leads.today.usd) : '—'}</span>
        </li>
        {budget && budget.dailyUsd !== null && share !== null ? (
          <li className="budget">
            <span className={`budget-track${budget.over ? ' over' : ''}`} aria-hidden="true">
              <span className="budget-fill" style={{ width: `${share * 100}%` }} />
            </span>
            <span className="budget-label muted num">
              {usd(budget.spentTodayUsd)} из {usd(budget.dailyUsd)} в день{budget.over ? '. Лимит исчерпан: новый поиск не начнётся' : ''}
            </span>
          </li>
        ) : null}
      </ul>
      {notCounted > 0 || unpriced > 0 ? (
        <p className="spend-note muted">
          {notCounted > 0 ? `Расшифровки голосовых не учтены: ${notCounted}.` : ''}
          {unpriced > 0 ? ` ${count(unpriced)} токенов без цены.` : ''}
        </p>
      ) : null}
    </Panel>
  );
}
