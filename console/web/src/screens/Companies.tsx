import { useState } from 'react';
import { Panel, Unavailable } from '../components/Bits';
import { IconExternal } from '../components/Icons';
import { Chips, ConfirmSheet, OutcomeLine, Pager, PageTitle, SearchBox, Select, useAction, useQueryParams, type ConfirmRequest } from '../components/Ui';
import { clockTime, count, nameOf, safeExternalUrl, usd } from '../lib/format';
import { Link, useRouter } from '../lib/router';
import { usePoll } from '../lib/usePoll';
import { isUnavailable, type Pain, type Section } from '../lib/types';

interface CompanyRow {
  readonly id: number;
  readonly name: string;
  readonly rubric: string | null;
  readonly cityName: string | null;
  readonly searchQuery: string | null;
  readonly statusLabel: string;
  readonly hadError: boolean;
  readonly fitLabel: string | null;
  readonly score: number | null;
  readonly contact: { readonly email: string; readonly verifyLabel: string; readonly isCatchAll: boolean | null; readonly isRole: boolean | null } | null;
  readonly draft: { readonly id: number; readonly subject: string; readonly reviewLabel: string; readonly checksTotal: number; readonly checksFailed: number } | null;
  readonly requestedVia: string | null;
  readonly whatsappContactedAt: string | null;
  readonly blocked: boolean;
}

interface CompanyList {
  readonly items: readonly CompanyRow[];
  readonly total: number;
  readonly page: number;
  readonly pages: number;
  readonly pageSize: number;
  readonly facets: {
    readonly cards: readonly { readonly code: string; readonly label: string; readonly count: number }[];
    readonly statuses: readonly { readonly code: string; readonly label: string; readonly count: number }[];
    readonly industries: readonly { readonly query: string; readonly count: number }[];
    readonly runs: readonly { readonly id: number; readonly cityName: string; readonly query: string }[];
  };
}

export function CompaniesScreen() {
  const { params, set } = useQueryParams();
  const { navigate } = useRouter();
  const query = params.toString();
  const poll = usePoll<Section<CompanyList>>(`/api/companies${query ? `?${query}` : ''}`, 0);
  const data = poll.data;
  const list = data && !isUnavailable(data) ? data : null;
  const cardCode = ['drafted', 'approved', 'rejected'].includes(params.get('status') ?? '') ? (params.get('status') ?? '') : params.get('status') ? '' : 'all';

  return (
    <div className="sheet-inner">
      <PageTitle title="Компании" sub={list ? `${count(list.total)} по этим условиям` : null} />
      {list ? (
        <div className="toolbar">
          <Chips label="Быстрый фильтр" value={cardCode} onChange={(code) => set({ status: code === 'all' ? null : code })} options={list.facets.cards} />
        </div>
      ) : null}
      <div className="toolbar">
        {list ? (
          <>
            <Select label="Статус" value={params.get('status') ?? ''} onChange={(value) => set({ status: value || null })} options={[{ value: '', label: 'Все статусы' }, ...list.facets.statuses.map((s) => ({ value: s.code, label: `${s.label} · ${s.count}` }))]} />
            <Select label="Отрасль" value={params.get('query') ?? ''} onChange={(value) => set({ query: value || null })} options={[{ value: '', label: 'Все отрасли' }, ...list.facets.industries.map((i) => ({ value: i.query, label: `${i.query} · ${i.count}` }))]} />
            <Select label="Запуск" value={params.get('run') ?? ''} onChange={(value) => set({ run: value || null })} options={[{ value: '', label: 'Все запуски' }, ...list.facets.runs.map((r) => ({ value: String(r.id), label: `№${r.id} ${r.cityName}: ${r.query}` }))]} />
          </>
        ) : null}
        <Select label="Признак" value={params.get('via') === 'whatsapp' ? 'via' : params.get('wa') ? 'wa' : params.get('blocked') ? 'blocked' : params.get('letter') ? 'letter' : ''} onChange={(value) => set({ via: value === 'via' ? 'whatsapp' : null, wa: value === 'wa' ? '1' : null, blocked: value === 'blocked' ? '1' : null, letter: value === 'letter' ? '1' : null })} options={[{ value: '', label: 'Без признака' }, { value: 'letter', label: 'Есть письмо' }, { value: 'wa', label: 'Писали в WhatsApp' }, { value: 'via', label: 'Добавлены из WhatsApp' }, { value: 'blocked', label: 'В «не писать»' }]} />
        <Select label="Порядок" value={params.get('sort') ?? 'new'} onChange={(value) => set({ sort: value === 'new' ? null : value })} options={[{ value: 'new', label: 'Новые сверху' }, { value: 'score', label: 'По оценке' }, { value: 'letter', label: 'По письму' }]} />
        <SearchBox value={params.get('q') ?? ''} placeholder="Название или рубрика" maxLength={100} onSubmit={(q) => set({ q })} />
      </div>

      {data && isUnavailable(data) ? (
        <section className="panel"><div className="panel-body"><Unavailable source="leads" /></div></section>
      ) : (
        <section className="panel flush" aria-label="Список компаний">
          {list === null ? null : list.items.length === 0 ? (
            <div className="panel-body" style={{ paddingTop: 16 }}><p className="empty">По этим условиям компаний нет. <Link to="/companies" className="text-link">Сбросить фильтры</Link></p></div>
          ) : (
            <table className="table">
              <thead><tr><th>Компания</th><th className="num-col">Оценка</th><th>Почта</th><th>Письмо</th><th>Статус</th></tr></thead>
              <tbody>
                {list.items.map((row) => (
                  <tr key={row.id} className="clickable" onClick={() => navigate(`/companies/${row.id}`)}>
                    <td>
                      <Link to={`/companies/${row.id}`} className="cell-main">{row.name}</Link>
                      <div className="cell-sub">{[row.rubric, row.cityName, row.searchQuery].filter(Boolean).join(' · ')}</div>
                      {row.requestedVia === 'whatsapp' ? <span className="pill note">из WhatsApp</span> : row.whatsappContactedAt ? <span className="pill info">писал в WhatsApp</span> : null}
                      {row.blocked ? <span className="pill bad">не писать</span> : null}
                    </td>
                    <td className="num-col" data-label="Оценка">
                      {row.score !== null ? <b className={row.score >= 70 ? 'score-good' : undefined}>{row.score}</b> : <span className="muted">—</span>}
                      <div className="cell-sub">{row.fitLabel ?? 'не оценена'}</div>
                    </td>
                    <td data-label="Почта">
                      {row.contact ? (
                        <>
                          <div className="ellipsis">{row.contact.email}</div>
                          <div className="cell-sub">{row.contact.verifyLabel}{row.contact.isRole ? ', общий ящик' : ''}{row.contact.isCatchAll ? ', принимает любые' : ''}</div>
                        </>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td data-label="Письмо">
                      {row.draft ? (
                        <>
                          <Link to={`/letters/${row.draft.id}`} className="cell-sub clamp" >{row.draft.subject}</Link>
                          <div className="cell-sub">{row.draft.reviewLabel} · {row.draft.checksFailed > 0 ? <span className="bad-text">не прошло {row.draft.checksFailed} из {row.draft.checksTotal}</span> : `проверки ${row.draft.checksTotal} из ${row.draft.checksTotal}`}</div>
                        </>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td data-label="Статус">{row.statusLabel}{row.hadError ? <div className="cell-sub bad-text">была ошибка</div> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      {list ? <Pager page={list.page} pages={list.pages} total={list.total} pageSize={list.pageSize} noun="компаний" onPage={(page) => set({ page: String(page) })} /> : null}
    </div>
  );
}

interface CompanyCardData {
  readonly company: {
    readonly company: {
      readonly id: number; readonly name: string; readonly rubric: string | null; readonly cityName: string | null; readonly address: string | null;
      readonly phones: readonly string[]; readonly website: string | null; readonly sourceUrl: string | null; readonly branchesCount: number | null;
      readonly statusLabel: string; readonly lastError: string | null; readonly requestedVia: string | null; readonly whatsappContactedAt: string | null;
      readonly searchQuery: string | null; readonly runId: number | null; readonly createdAt: string;
    };
    readonly qualification: { readonly fitLabel: string | null; readonly score: number | null; readonly segment: string | null; readonly reason: string | null; readonly model: string | null; readonly createdAt: string } | null;
    readonly pains: readonly Pain[];
    readonly contacts: readonly { readonly id: number; readonly email: string; readonly sourcePage: string | null; readonly verifyLabel: string; readonly isCatchAll: boolean | null; readonly isRole: boolean | null }[];
    readonly draft: { readonly id: number; readonly subject: string; readonly reviewLabel: string; readonly approvedBy: string | null; readonly approvedAt: string | null } | null;
    readonly history: readonly { readonly id: number; readonly occurredAt: string; readonly whatLabel: string; readonly sourceLabel: string; readonly subject: string | null; readonly email: string }[];
    readonly blocked: boolean;
    readonly testSends: readonly { readonly id: number; readonly sentTo: string; readonly statusLabel: string; readonly ok: boolean; readonly error: string | null; readonly createdAt: string }[];
    readonly siteText: { readonly text: string; readonly length: number; readonly truncated: boolean };
    readonly cost: { readonly usd: number | null; readonly tokens: number };
  } | { readonly unavailable: true };
  readonly chats: { readonly items: readonly { readonly chatId: number; readonly name: string | null; readonly status: string; readonly lastMessageAt: string | null }[] } | { readonly unavailable: true };
}

export function CompanyScreen({ id, owner }: { readonly id: number; readonly owner: boolean }) {
  const poll = usePoll<CompanyCardData>(`/api/companies/${id}`, 0);
  const action = useAction();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const data = poll.data;
  const now = poll.updatedAt ?? Date.now();
  if (poll.error?.error === 'not_found') return <div className="sheet-inner"><PageTitle title="Компания не найдена" sub={<Link to="/companies" className="text-link">К списку компаний</Link>} /></div>;
  if (data === null) return <div className="sheet-inner"><PageTitle title="Компания" sub="Загрузка…" /></div>;
  if ((data as { unavailable?: boolean }).unavailable === true) return <div className="sheet-inner"><PageTitle title="Компания" /><Unavailable source="leads" /></div>;
  const section = data.company;
  if ('unavailable' in section) return <div className="sheet-inner"><PageTitle title="Компания" /><Unavailable source="leads" /></div>;
  const card = section;
  const chats = data.chats;
  const c = card.company;
  const twoGis = safeExternalUrl(c.sourceUrl);
  const site = safeExternalUrl(c.website);
  const marked = c.requestedVia === 'whatsapp' || c.whatsappContactedAt !== null;

  const block = (): void => setConfirm({
    title: 'Больше не писать этой компании?',
    body: <><p>Компания, её корпоративный домен и все её адреса попадут в список «не писать».</p><p><b>Это не отменяется:</b> снять из списка нельзя.</p></>,
    confirmLabel: 'Больше не писать',
    danger: true,
    run: async () => { await action.run(`/api/companies/${id}/block`); poll.refresh(); },
  });
  const clearWa = (): void => setConfirm({
    title: 'Снять отметку WhatsApp?',
    body: <p>Снять, если бот перепутал компанию. {c.requestedVia === 'whatsapp' ? 'Компания станет обычной и может попасть в рассылку.' : 'Пропадёт пометка «клиент писал в WhatsApp».'}</p>,
    confirmLabel: 'Снять отметку',
    run: async () => { await action.run(`/api/companies/${id}/whatsapp-clear`); poll.refresh(); },
  });

  return (
    <div className="sheet-inner">
      <nav className="crumbs" aria-label="Путь"><Link to="/companies">Компании</Link><span aria-hidden="true">/</span>{c.runId ? <Link to={`/companies?run=${c.runId}`}>запуск №{c.runId}</Link> : null}</nav>
      <PageTitle
        title={c.name}
        sub={<>{c.statusLabel}{card.qualification?.score != null ? ` · ${card.qualification.fitLabel}, ${card.qualification.score} из 100` : ''}{card.qualification?.segment ? ` · ${card.qualification.segment}` : ''} · найдена {clockTime(c.createdAt, now)} · расход {usd(card.cost.usd)}</>}
        actions={owner ? (
          <div className="actions">
            {marked ? <button type="button" className="btn" onClick={clearWa}>Снять отметку WhatsApp</button> : null}
            {card.blocked ? null : <button type="button" className="btn danger" onClick={block}>Больше не писать</button>}
          </div>
        ) : null}
      />
      <OutcomeLine outcome={action.outcome} />
      {c.requestedVia === 'whatsapp' ? <p className="notice warn" style={{ marginBottom: 16 }}>Компанию добавила проверка из WhatsApp: в рассылку она не попадает.</p> : null}
      {c.whatsappContactedAt ? <p className="notice info" style={{ marginBottom: 16 }}>Клиент уже писал в WhatsApp ({clockTime(c.whatsappContactedAt, now)}). Проверьте, нужно ли письмо.</p> : null}
      {card.blocked ? <p className="notice bad" style={{ marginBottom: 16 }}>В списке «не писать»: письма этой компании одобрить нельзя.</p> : null}
      {c.lastError ? <p className="notice warn" style={{ marginBottom: 16 }}>Причина или ошибка на последнем шаге: {c.lastError}</p> : null}

      <div className="grid-2">
        <div className="stack">
          <Panel id="why" title="Почему подходит">
            {card.qualification ? (
              <>
                <div className="fit"><span className="num fit-score">{card.qualification.score ?? '—'}</span><span className="fit-of">из 100</span><div className="fit-text"><b>{card.qualification.fitLabel}</b>{card.qualification.segment ? <span className="muted"> · {card.qualification.segment}</span> : null}<p>{card.qualification.reason}</p></div></div>
                <p className="hint">{card.qualification.model} · {clockTime(card.qualification.createdAt, now)}</p>
              </>
            ) : <p className="empty">Ещё не оценена.</p>}
          </Panel>
          <Panel id="pains" title="Боли" count={card.pains.length}>
            {card.pains.length === 0 ? <p className="empty">Явных болей не найдено.</p> : (
              <ul className="pain-list">
                {card.pains.map((pain) => (
                  <li key={pain.pain}><b>{pain.pain}</b><span className="evidence"><q>{pain.evidence}</q> · {pain.sourceLabel} · {pain.verified ? 'цитата найдена в источнике' : <span className="bad-text">не подтверждено</span>}</span></li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel id="letter" title="Письмо" aside={card.draft ? <Link to={`/letters/${card.draft.id}`} className="text-link">Открыть в очереди</Link> : null}>
            {card.draft ? (
              <><p className="cell-main">{card.draft.subject}</p><p className="cell-sub">{card.draft.reviewLabel}{card.draft.approvedAt ? `, ${card.draft.approvedBy ?? ''} ${clockTime(card.draft.approvedAt, now)}` : ''}</p></>
            ) : <p className="empty">{card.qualification?.fitLabel === 'не подходит' || c.requestedVia === 'whatsapp' ? 'Письма не будет.' : 'Письма пока нет. Черновик появится после проверки почты.'}</p>}
            {card.testSends.length > 0 ? (
              <ul className="rows" style={{ marginTop: 12 }}>
                {card.testSends.map((t) => <li key={t.id} className="history-row"><span className="num">{clockTime(t.createdAt, now)}</span><span>{t.ok ? 'тест ушёл' : <span className="bad-text">тест не ушёл</span>} на {t.sentTo}</span>{t.error ? <span className="muted">{t.error}</span> : null}</li>)}
              </ul>
            ) : null}
          </Panel>
          <Panel id="history" title="История писем" count={card.history.length}>
            {card.history.length === 0 ? <p className="empty">Этой компании ещё не писали.</p> : (
              <ul className="rows">{card.history.map((h) => <li key={h.id} className="history-row"><span className="num">{clockTime(h.occurredAt, now)}</span><span>{h.whatLabel}{h.subject ? `: ${h.subject}` : ''}</span><span className="muted">{h.sourceLabel} · {h.email}</span></li>)}</ul>
            )}
          </Panel>
        </div>
        <div className="stack">
          <Panel id="2gis" title="Карточка 2ГИС">
            <dl className="kv-rows">
              <div><dt>Рубрика</dt><dd>{c.rubric ?? '—'}</dd></div>
              <div><dt>Город</dt><dd>{c.cityName ?? '—'}</dd></div>
              <div><dt>Адрес</dt><dd>{c.address ?? '—'}</dd></div>
              <div><dt>Телефоны</dt><dd className="phones">{c.phones.length ? c.phones.map((p) => <a key={p} className="text-link" href={`tel:${p.replace(/[^\d+]/g, '')}`}>{p}</a>) : '—'}</dd></div>
              <div><dt>Сайт</dt><dd>{site ? <a className="text-link" href={site} target="_blank" rel="noopener noreferrer">{c.website} <IconExternal size={12} /></a> : '—'}</dd></div>
              <div><dt>Филиалов</dt><dd>{c.branchesCount ?? '—'}</dd></div>
              <div><dt>Отрасль поиска</dt><dd>{c.searchQuery ?? '—'}</dd></div>
            </dl>
            {twoGis ? <p style={{ marginTop: 12 }}><a className="text-link" href={twoGis} target="_blank" rel="noopener noreferrer">Открыть в 2ГИС <IconExternal size={12} /></a></p> : null}
          </Panel>
          <Panel id="chats" title="Чаты WhatsApp">
            {'unavailable' in chats ? <Unavailable source="wa" /> : chats.items.length === 0 ? <p className="empty">Клиенты этой компании в WhatsApp не писали.</p> : (
              <ul className="rows">{chats.items.map((ch) => <li key={ch.chatId}><Link to={`/chats/${ch.chatId}`} className="row-link"><div className="row compact-row"><div className="row-main"><div className="row-line1"><span className="who">{nameOf(ch.name)}</span><span className="org">{ch.status === 'manager' ? 'у менеджера' : 'у бота'} · {clockTime(ch.lastMessageAt, now)}</span></div></div></div></Link></li>)}</ul>
            )}
          </Panel>
          <Panel id="emails" title="Почты" count={card.contacts.length}>
            {card.contacts.length === 0 ? <p className="empty">Почта не найдена ни в 2ГИС, ни на сайте.</p> : (
              <ul className="rows">{card.contacts.map((ct) => { const src = safeExternalUrl(ct.sourcePage); return <li key={ct.id} className="history-row"><span className="ellipsis">{ct.email}</span><span>{ct.verifyLabel}{ct.isRole ? ', общий ящик' : ''}{ct.isCatchAll ? ', принимает любые' : ''}</span>{src ? <a className="muted" href={src} target="_blank" rel="noopener noreferrer">источник</a> : null}</li>; })}</ul>
            )}
          </Panel>
          <Panel id="site" title="Текст сайта">
            {card.siteText.length === 0 ? <p className="empty">Сайт не обойдён.</p> : <details><summary className="text-link">Показать текст, который прочитал Claude ({count(card.siteText.length)} символов)</summary><p className="site-text">{card.siteText.text}</p></details>}
          </Panel>
        </div>
      </div>
      <ConfirmSheet request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
