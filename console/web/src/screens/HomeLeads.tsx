import { Panel, Unavailable } from '../components/Bits';
import { count, waitDuration, minutesSince } from '../lib/format';
import { Link } from '../lib/router';
import { isUnavailable, type LeadsSummary, type Run, type Unavailable as Down } from '../lib/types';

/** Ход поиска: пять этапов одной полосой, идущий — цветом данных, с его счётчиком. */
function RunProgress({ run, now }: { readonly run: Run; readonly now: number }) {
  const current = run.stages.find((stage) => stage.state === 'running');
  const counter = current?.counters?.[0];
  return (
    <div className="run">
      <div className="row-line1">
        <span className="who">Поиск №{run.id}, {run.cityName}</span>
      </div>
      <p className="row-line2 wrap">{run.industries.join(', ')}</p>
      <ol className="stages" aria-label="Этапы поиска">
        {run.stages.map((stage) => (
          <li key={stage.code} className={`stage ${stage.state}`} title={`${stage.label}: ${stage.stateLabel}`}>
            <span className="visually-hidden">{stage.label}: {stage.stateLabel}</span>
          </li>
        ))}
      </ol>
      <p className="row-line2 wrap">
        {current ? `${current.label}: ${run.stageDetail ?? (counter ? `${counter.label} ${counter.value}` : current.stateLabel)}` : run.statusLabel}
        {run.startedAt ? ` · идёт ${waitDuration(minutesSince(run.startedAt, now))}` : null}
      </p>
    </div>
  );
}

export function LeadsNow({ summary, now }: { readonly summary: LeadsSummary | Down; readonly now: number }) {
  if (isUnavailable(summary)) {
    return (
      <Panel id="leads-now" title="Почта: в работе">
        <Unavailable source="leads" />
      </Panel>
    );
  }
  const { activeRun, research, overview, testSends } = summary;
  return (
    <Panel
      id="leads-now"
      title="Почта: в работе"
      foot={
        <span>
          Найдено {count(overview.companiesFound)}, подходят {count(overview.companiesFit)}
          {overview.avgScoreFit !== null ? ` (в среднем ${overview.avgScoreFit} из 100)` : ''}, одобрено писем {overview.lettersApproved}
        </span>
      }
    >
      <ul className="facts">
        <li>
          {activeRun ? (
            <RunProgress run={activeRun} now={now} />
          ) : (
            <span className="muted">Поиск сейчас не идёт. <Link to="/search" className="text-link">Начать поиск</Link></span>
          )}
        </li>
        <li className="fact">
          <span>Письма ждут проверки</span>
          <Link to="/letters" className={`num fact-value${overview.lettersPending > 0 ? ' text-link' : ''}`}>{overview.lettersPending}</Link>
        </li>
        <li className="fact">
          <span>Проверки из WhatsApp</span>
          <span className="num fact-value">{research.today} <span className="muted">из {research.perDay}</span></span>
        </li>
        {research.active.map((job) => (
          <li key={job.id} className="fact sub">
            <span className="muted ellipsis">{job.name}</span>
            <span className="muted nowrap">{job.status === 'running' ? 'идёт' : 'ждёт'} {waitDuration(minutesSince(job.createdAt, now))}</span>
          </li>
        ))}
        <li className="fact">
          <span>Тестовые письма за день</span>
          <span className="num fact-value">{testSends.today} <span className="muted">из {testSends.perDay}</span></span>
        </li>
      </ul>
    </Panel>
  );
}
