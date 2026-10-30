import { useMemo, useState } from 'react';
import { Panel, Unavailable } from '../components/Bits';
import { Chips, ConfirmSheet, OutcomeLine, Pager, PageTitle, useAction, useQueryParams, type ConfirmRequest } from '../components/Ui';
import { clockTime, minutesSince, usd, waitDuration } from '../lib/format';
import { Link } from '../lib/router';
import { usePoll } from '../lib/usePoll';
import { isUnavailable, type Run, type Section } from '../lib/types';

interface SearchOptions {
  readonly cities: readonly { readonly code: string; readonly name: string }[];
  readonly quickQueries: readonly string[];
  readonly limits: { readonly maxPerIndustry: number; readonly maxQueries: number; readonly maxTotal: number; readonly maxQueryTextLength: number };
  readonly defaults: { readonly city: string; readonly count: number };
  readonly usdPerCompany: number;
  readonly usdFirstRun: number;
}

interface RunRow extends Run {
  readonly createdAt: string;
  readonly finished: boolean;
  readonly lettersPending: number;
  readonly cost: { readonly usd: number | null; readonly text: string };
  readonly error: string | null;
}

interface Page<T> { readonly items: readonly T[]; readonly total: number; readonly page: number; readonly pages: number; readonly pageSize: number }

interface ResearchRow { readonly id: string; readonly name: string; readonly cityName: string | null; readonly status: string; readonly statusLabel: string; readonly reasonLabel: string | null; readonly companyId: number | null; readonly createdAt: string; readonly finishedAt: string | null }

function splitIndustries(text: string): string[] {
  return text.split(/[,;\n]/).map((part) => part.trim()).filter(Boolean);
}

function RunCard({ run, now }: { readonly run: RunRow; readonly now: number }) {
  return (
    <div className="run-card">
      <div className="row-line1"><span className="who">Поиск №{run.id}, {run.cityName}</span><span className={`pill ${run.status === 'failed' ? 'bad' : run.finished ? 'ok' : 'info'}`}>{run.statusLabel}</span></div>
      <p className="row-line2 wrap">{run.industries.join(', ')} · до {run.maxCompanies} на отрасль · {run.startedAt ? `идёт ${waitDuration(minutesSince(run.startedAt, now))}` : clockTime(run.createdAt, now)}</p>
      <ol className="stage-list">
        {run.stages.map((stage) => (
          <li key={stage.code} className={stage.state}>
            <span className="stage-bar" aria-hidden="true" />
            <b>{stage.label}</b>
            <span className="muted">{stage.stateLabel}{stage.counters?.length ? ` · ${stage.counters.map((c) => `${c.label} ${c.value}`).join(', ')}` : ''}</span>
          </li>
        ))}
      </ol>
      {run.error ? <p className="notice bad">{run.error}</p> : null}
      <p className="hint">Расход запуска {run.cost.text}{run.errors ? ` · ошибок по компаниям ${run.errors}` : ''}</p>
      <div className="actions" style={{ marginTop: 8 }}>
        <Link to={`/companies?run=${run.id}`} className="btn small">Компании запуска</Link>
        {run.lettersPending ? <Link to={`/letters?run=${run.id}`} className="btn small primary">Проверить письма ({run.lettersPending})</Link> : null}
      </div>
    </div>
  );
}

export function SearchScreen({ owner }: { readonly owner: boolean }) {
  const { params, set } = useQueryParams();
  const tab = params.get('tab') === 'research' ? 'research' : 'runs';
  const options = usePoll<Section<SearchOptions>>('/api/search/options', 0);
  const active = usePoll<Section<RunRow | null>>('/api/runs/active', 2_000);
  const selectedRunId = Number(params.get('run') ?? '0') || null;
  const selected = usePoll<Section<RunRow>>(selectedRunId ? `/api/runs/${selectedRunId}` : '/api/runs/active', selectedRunId ? 0 : -1);
  const runs = usePoll<Section<Page<RunRow>>>(`/api/runs?page=${params.get('page') ?? '1'}`, 30_000);
  const research = usePoll<Section<Page<ResearchRow>>>(`/api/research-jobs?page=${params.get('page') ?? '1'}`, tab === 'research' ? 15_000 : 0);
  const action = useAction();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const opts = options.data && !isUnavailable(options.data) ? options.data : null;
  const [queryText, setQueryText] = useState('');
  const [city, setCity] = useState('');
  const [perQuery, setPerQuery] = useState(5);
  const industries = useMemo(() => splitIndustries(queryText), [queryText]);
  const total = industries.length * perQuery;
  const activeRun = active.data && !isUnavailable(active.data) ? active.data : null;
  const now = active.updatedAt ?? Date.now();
  const tooMany = opts ? industries.length > opts.limits.maxQueries || total > opts.limits.maxTotal : false;

  const toggleChip = (chip: string): void => {
    const has = industries.includes(chip);
    setQueryText((has ? industries.filter((i) => i !== chip) : [...industries, chip]).join(', '));
  };
  const start = (): void => {
    if (!opts) return;
    const estimate = total * opts.usdPerCompany;
    setConfirm({
      title: 'Начать поиск?',
      body: <><p>{industries.join(', ')}: до {total} компаний в городе {opts.cities.find((c) => c.code === (city || opts.defaults.city))?.name}.</p><p>Примерно {usd(estimate)} за компании плюс {opts.usdFirstRun < 0.005 ? 'меньше цента' : `около ${usd(opts.usdFirstRun)}`} на первый запуск за 5 минут. Бюджет проверяется только при старте.</p></>,
      confirmLabel: 'Начать поиск',
      run: async () => { const result = await action.run('/api/runs', { query: industries.join(', '), city: city || opts.defaults.city, count: perQuery }); if (result.ok) { active.refresh(); runs.refresh(); } },
    });
  };

  return (
    <div className="sheet-inner">
      <PageTitle title="Поиск компаний" sub="2ГИС → сайты → оценка Claude → проверка почт → черновики писем." />
      <OutcomeLine outcome={action.outcome} />
      <div className="grid-2 search-grid">
        <Panel id="new-run" title="Новый поиск">
          {opts === null ? (options.data ? <Unavailable source="leads" /> : <p className="muted">Загрузка…</p>) : (
            <form className="form-grid" onSubmit={(e) => { e.preventDefault(); start(); }}>
              <label><span>Что ищем в 2ГИС</span><input type="text" value={queryText} maxLength={opts.limits.maxQueryTextLength} placeholder="склад, логистика" onChange={(e) => setQueryText(e.target.value)} /></label>
              <div className="chips">{opts.quickQueries.map((chip) => <button key={chip} type="button" className="chip" aria-pressed={industries.includes(chip)} onClick={() => toggleChip(chip)}>{chip}</button>)}</div>
              <div className="grid-2 tight">
                <label><span>Город</span><select value={city || opts.defaults.city} onChange={(e) => setCity(e.target.value)}>{opts.cities.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
                <label><span>Компаний на отрасль</span><input type="number" min={1} max={opts.limits.maxPerIndustry} value={perQuery} onChange={(e) => setPerQuery(Math.max(1, Math.min(opts.limits.maxPerIndustry, Number(e.target.value) || 1)))} /></label>
              </div>
              <p className={`estimate ${tooMany ? 'bad-text' : ''}`} aria-live="polite">
                {industries.length ? `${industries.length} ${industries.length === 1 ? 'отрасль' : 'отрасли'} × ${perQuery} = до ${total} компаний · примерно ${usd(total * opts.usdPerCompany)}` : 'Выберите отрасли.'}
                {tooMany ? ` Больше ${opts.limits.maxQueries} отраслей или ${opts.limits.maxTotal} компаний за запуск нельзя.` : ''}
              </p>
              {owner ? (
                <button type="submit" className="btn primary" disabled={!industries.length || tooMany || activeRun !== null}>
                  {activeRun ? `Идёт запуск №${activeRun.id}` : 'Найти компании'}
                </button>
              ) : <p className="hint">Запускать поиск может только владелец.</p>}
            </form>
          )}
        </Panel>
        <Panel id="active-run" title={selectedRunId ? `Запуск №${selectedRunId}` : 'Сейчас'} aside={selectedRunId ? <button type="button" className="btn small ghost" onClick={() => set({ run: null })}>К идущему</button> : null}>
          {selectedRunId && selected.error ? <p className="empty">Запуск №{selectedRunId} не найден.</p> : selectedRunId && selected.data && !isUnavailable(selected.data) && selected.data !== null ? <RunCard run={selected.data} now={now} /> : active.data && isUnavailable(active.data) ? <Unavailable source="leads" /> : activeRun ? <RunCard run={activeRun} now={now} /> : <p className="empty">Поиск сейчас не идёт.</p>}
          {active.error && active.error.error === 'network' ? <p className="hint">{active.error.message}</p> : null}
        </Panel>
      </div>

      <div className="toolbar" style={{ marginTop: 24 }}>
        <Chips label="История" value={tab} onChange={(code) => set({ tab: code === 'runs' ? null : code })} options={[{ code: 'runs', label: 'Прошлые запуски' }, { code: 'research', label: 'Проверки из WhatsApp' }]} />
      </div>
      {tab === 'runs' ? (
        runs.data && !isUnavailable(runs.data) ? (
          <>
            <section className="panel flush" aria-label="Прошлые запуски">
              {runs.data.items.length === 0 ? <div className="panel-body" style={{ paddingTop: 16 }}><p className="empty">Запусков ещё не было.</p></div> : (
                <table className="table">
                  <thead><tr><th>Запуск</th><th>Отрасли</th><th className="num-col">Найдено</th><th className="num-col">Подходят</th><th className="num-col">Писем</th><th>Статус</th><th className="num-col">Расход</th></tr></thead>
                  <tbody>{runs.data.items.map((r) => (
                    <tr key={r.id}>
                      <td><button type="button" className="link-button" onClick={() => { set({ run: String(r.id) }); window.scrollTo(0, 0); }}><b>№{r.id}</b> ход</button><div className="cell-sub">{clockTime(r.createdAt, now)} · {r.cityName}</div></td>
                      <td data-label="Отрасли"><Link to={`/companies?run=${r.id}`} className="text-link">{r.industries.join(', ')}</Link><div className="cell-sub">до {r.maxCompanies} на отрасль</div></td>
                      <td className="num-col" data-label="Найдено">{r.found}<div className="cell-sub">новых {r.newCompanies}</div></td>
                      <td className="num-col" data-label="Подходят">{r.qualified}</td>
                      <td className="num-col" data-label="Писем"><Link to={`/letters?run=${r.id}&status=all`} className="text-link">{r.drafted}</Link></td>
                      <td data-label="Статус"><span className={`pill ${r.status === 'failed' ? 'bad' : r.finished ? 'ok' : 'info'}`}>{r.statusLabel}</span></td>
                      <td className="num-col" data-label="Расход">{r.cost.text}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </section>
            <Pager page={runs.data.page} pages={runs.data.pages} total={runs.data.total} pageSize={runs.data.pageSize} noun="запусков" onPage={(page) => set({ page: String(page) })} />
          </>
        ) : runs.data ? <Unavailable source="leads" /> : null
      ) : research.data && !isUnavailable(research.data) ? (
        <>
          <section className="panel flush" aria-label="Проверки из WhatsApp">
            {research.data.items.length === 0 ? <div className="panel-body" style={{ paddingTop: 16 }}><p className="empty">Бот ещё не просил проверить компанию.</p></div> : (
              <table className="table">
                <thead><tr><th>Компания со слов клиента</th><th>Статус</th><th>Итог</th><th className="num-col">Когда</th></tr></thead>
                <tbody>{research.data.items.map((j) => (
                  <tr key={j.id}>
                    <td><b>{j.name}</b><div className="cell-sub">{j.cityName ?? 'город не указан'}</div></td>
                    <td data-label="Статус"><span className={`pill ${j.status === 'failed' ? 'bad' : j.status === 'done' ? 'ok' : 'info'}`}>{j.statusLabel}</span></td>
                    <td data-label="Итог">{j.companyId ? <Link to={`/companies/${j.companyId}`} className="text-link">карточка компании</Link> : <span className="muted">{j.reasonLabel ?? '—'}</span>}</td>
                    <td className="num-col" data-label="Когда">{clockTime(j.createdAt, now)}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>
          <Pager page={research.data.page} pages={research.data.pages} total={research.data.total} pageSize={research.data.pageSize} noun="проверок" onPage={(page) => set({ page: String(page) })} />
        </>
      ) : research.data ? <Unavailable source="leads" /> : null}
      <ConfirmSheet request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
