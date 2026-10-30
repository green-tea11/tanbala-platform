import { useEffect, useState } from 'react';
import { Panel, Unavailable } from '../components/Bits';
import { IconCheck, IconCross, IconExternal } from '../components/Icons';
import { Chips, ConfirmSheet, OutcomeLine, Pager, PageTitle, useAction, useQueryParams, type ConfirmRequest } from '../components/Ui';
import { apiGet } from '../lib/api';
import { clockTime, safeExternalUrl } from '../lib/format';
import { Link, useRouter } from '../lib/router';
import { usePoll } from '../lib/usePoll';
import { isUnavailable, type Pain, type Section } from '../lib/types';

interface LetterRow {
  readonly id: number;
  readonly companyName: string;
  readonly subject: string;
  readonly reviewLabel: string;
  readonly checksTotal: number;
  readonly checksFailed: number;
  readonly score: number | null;
  readonly searchQuery: string | null;
  readonly blocked: boolean;
  readonly createdAt: string;
}

interface LetterList {
  readonly items: readonly LetterRow[];
  readonly total: number; readonly page: number; readonly pages: number; readonly pageSize: number;
  readonly filters: readonly { readonly code: string; readonly label: string; readonly count: number }[];
  readonly run: { readonly id: number; readonly cityName: string; readonly query: string } | null;
}

interface Letter {
  readonly id: number;
  readonly subject: string;
  readonly body: string;
  readonly notes: readonly { readonly kind: string; readonly text: string }[];
  readonly textLines: readonly { readonly text: string; readonly note: boolean }[];
  readonly model: string | null;
  readonly createdAt: string;
  readonly reviewStatus: string;
  readonly reviewLabel: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly checks: readonly { readonly code: string; readonly label: string; readonly passed: boolean; readonly details: readonly string[] }[];
  readonly checksTotal: number;
  readonly checksFailed: number;
  readonly contact: { readonly email: string; readonly verifyLabel: string; readonly isCatchAll: boolean | null; readonly isRole: boolean | null } | null;
  readonly testAddress: string | null;
  readonly canApprove: boolean;
  readonly approveBlockedReason: string | null;
  readonly canReject: boolean;
  readonly canEdit: boolean;
  readonly canSendTest: boolean;
  readonly sendTestBlockedReason: string | null;
  readonly blocked: boolean;
  readonly testSends: readonly { readonly id: number; readonly sentTo: string; readonly ok: boolean; readonly error: string | null; readonly createdAt: string }[];
  readonly company: {
    readonly id: number; readonly name: string; readonly rubric: string | null; readonly cityName: string | null; readonly fitLabel: string | null;
    readonly score: number | null; readonly segment: string | null; readonly reason: string | null; readonly pains: readonly Pain[];
    readonly sourceUrl: string | null; readonly whatsappContactedAt: string | null; readonly requestedVia: string | null;
  };
}

function LetterQueue({ list, selected, query }: { readonly list: LetterList; readonly selected: number | null; readonly query: string }) {
  return (
    <section className="panel flush split-list" aria-label="Очередь писем">
      {list.items.length === 0 ? (
        <div className="panel-body" style={{ paddingTop: 16 }}><p className="empty">Здесь пусто. Новые письма появятся после поиска.</p></div>
      ) : (
        <ul>
          {list.items.map((row) => (
            <li key={row.id}>
              <Link to={`/letters/${row.id}${query ? `?${query}` : ''}`} className="list-item" aria-current={row.id === selected ? 'page' : undefined}>
                <div className="row-line1"><span className="who">{row.companyName}</span>{row.score !== null ? <span className="num score-chip">{row.score}</span> : null}</div>
                <div className="row-line2 wrap">{row.subject}</div>
                <div className="row-line2">
                  {row.checksFailed > 0 ? <span className="bad-text">не прошло {row.checksFailed} из {row.checksTotal}</span> : `проверки ${row.checksTotal} из ${row.checksTotal}`}
                  {row.blocked ? <span className="bad-text"> · не писать</span> : null} · {row.reviewLabel.toLowerCase()}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LetterView({ letter, owner, onDone }: { readonly letter: Letter; readonly owner: boolean; readonly onDone: (decided: boolean) => void }) {
  const action = useAction();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(letter.subject);
  const [body, setBody] = useState(letter.body);
  const now = Date.now();
  useEffect(() => { setEditing(false); setSubject(letter.subject); setBody(letter.body); action.setOutcome(null); }, [letter.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const c = letter.company;
  const twoGis = safeExternalUrl(c.sourceUrl);
  const text = letter.textLines.filter((line) => !line.note).map((line) => line.text).join('\n');

  const decide = (kind: 'approve' | 'reject'): void => setConfirm({
    title: kind === 'approve' ? 'Одобрить письмо?' : 'Отклонить письмо?',
    body: kind === 'approve' ? <p>Письмо уйдёт в «Одобренные». Компаниям письма пока не отправляются.</p> : <p>Компания вернётся к статусу «Почта проверена». Новое письмо этой компании само не появится.</p>,
    confirmLabel: kind === 'approve' ? 'Одобрить' : 'Отклонить',
    danger: kind === 'reject',
    run: async () => { const result = await action.run(`/api/letters/${letter.id}/${kind}`); if (result.ok) onDone(true); },
  });
  const sendTest = (): void => setConfirm({
    title: 'Отправить тест?',
    body: <p>Письмо уйдёт только на <b>{letter.testAddress}</b>. Компании оно не отправляется. Тестов в день — до 30.</p>,
    confirmLabel: 'Отправить тест',
    run: async () => { await action.run(`/api/letters/${letter.id}/send-test`); onDone(false); },
  });
  const save = async (): Promise<void> => {
    const result = await action.run(`/api/letters/${letter.id}/edit`, { subject, body });
    if (result.ok) { setEditing(false); onDone(false); }
  };
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(`${letter.subject}\n\n${text}`); action.setOutcome({ tone: 'ok', text: 'Тема и текст скопированы.' }); }
    catch { action.setOutcome({ tone: 'bad', text: 'Не вышло скопировать.' }); }
  };

  return (
    <div className="stack">
      <OutcomeLine outcome={action.outcome} />
      {c.whatsappContactedAt ? <p className="notice info">Клиент уже писал в WhatsApp ({clockTime(c.whatsappContactedAt, now)}). Проверьте, нужно ли письмо.</p> : null}
      {letter.blocked ? <p className="notice bad">Компания в списке «не писать»: одобрить нельзя.</p> : null}
      <Panel id="letter-company" title={c.name} aside={<Link to={`/companies/${c.id}`} className="text-link">Карточка компании</Link>}>
        <div className="fit"><span className="num fit-score">{c.score ?? '—'}</span><span className="fit-of">из 100</span><div className="fit-text"><b>{c.fitLabel ?? 'не оценена'}</b>{c.segment ? <span className="muted"> · {c.segment}</span> : null}<p>{c.reason}</p></div></div>
        {c.pains.length ? <ul className="pain-list" style={{ marginTop: 12 }}>{c.pains.map((p) => <li key={p.pain}><b>{p.pain}</b><span className="evidence"><q>{p.evidence}</q> · {p.sourceLabel}</span></li>)}</ul> : null}
        {twoGis ? <p className="hint"><a className="text-link" href={twoGis} target="_blank" rel="noopener noreferrer">Открыть в 2ГИС <IconExternal size={12} /></a> · {[c.rubric, c.cityName].filter(Boolean).join(' · ')}</p> : null}
      </Panel>

      <Panel id="letter-text" title="Письмо" aside={<span className="pill info">{letter.reviewLabel}{letter.approvedAt ? ` · ${letter.approvedBy ?? ''} ${clockTime(letter.approvedAt, now)}` : ''}</span>}>
        {letter.notes.length ? <div className="notice warn" style={{ marginBottom: 12 }}><b>Заметки для вас</b> (клиенту не уходят){letter.notes.map((n) => <div key={n.text}>{n.kind}: {n.text}</div>)}</div> : null}
        <dl className="kv-rows">
          <div><dt>Адрес компании</dt><dd>{letter.contact ? <>{letter.contact.email} <span className="muted">(не отправляем) · {letter.contact.verifyLabel}{letter.contact.isRole ? ', общий ящик' : ''}</span></> : '—'}</dd></div>
          <div><dt>Тест уйдёт на</dt><dd>{letter.testAddress ?? <span className="bad-text">тестовая отправка не настроена</span>}</dd></div>
          {editing ? null : <div><dt>Тема</dt><dd><b>{letter.subject}</b></dd></div>}
        </dl>
        {editing ? (
          <div className="form-grid" style={{ marginTop: 12 }}>
            <label><span>Тема</span><input type="text" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} /></label>
            <label><span>Текст</span><textarea rows={14} value={body} maxLength={10000} onChange={(e) => setBody(e.target.value)} /></label>
            <p className="hint">Строки «[Проверить: …]» и «[Ответить лично: …]» в начале — заметки для вас, клиенту не уходят.{letter.reviewStatus === 'approved' ? ' Правка снимет одобрение.' : ''}</p>
            <div className="actions"><button type="button" className="btn primary" onClick={() => void save()}>Сохранить и проверить</button><button type="button" className="btn" onClick={() => setEditing(false)}>Отмена</button></div>
          </div>
        ) : (
          <div className="letter-body">{letter.textLines.map((line, i) => <p key={i} className={line.note ? 'note-line' : undefined}>{line.text || ' '}</p>)}</div>
        )}
        {owner && !editing ? (
          <div className="letter-actions">
            <div className="actions">
              <button type="button" className="btn primary" disabled={!letter.canApprove} title={letter.approveBlockedReason ?? undefined} onClick={() => decide('approve')}>Одобрить</button>
              <button type="button" className="btn" disabled={!letter.canEdit} onClick={() => setEditing(true)}>Изменить</button>
              <button type="button" className="btn" disabled={!letter.canSendTest} title={letter.sendTestBlockedReason ?? undefined} onClick={sendTest}>Отправить тест</button>
              <button type="button" className="btn ghost" onClick={() => void copy()}>Скопировать</button>
            </div>
            <button type="button" className="btn danger" disabled={!letter.canReject} onClick={() => decide('reject')}>Отклонить</button>
          </div>
        ) : null}
        {!letter.canApprove && letter.approveBlockedReason ? <p className="hint">{letter.approveBlockedReason}</p> : null}
        {!letter.canSendTest && letter.sendTestBlockedReason ? <p className="hint">{letter.sendTestBlockedReason}</p> : null}
        {letter.reviewStatus === 'rejected' ? <p className="hint">Письмо отклонено.</p> : null}
      </Panel>

      <Panel id="letter-checks" title={letter.checksFailed ? `Проверки: не прошло ${letter.checksFailed} из ${letter.checksTotal}` : `Проверки: все ${letter.checksTotal} пройдены`}>
        {letter.checks.length === 0 ? <p className="empty">Проверки ещё не запускались.</p> : (
          <ul className="checks">{letter.checks.map((check) => <li key={check.code} className={check.passed ? 'ok' : 'bad'}><span className="mark" aria-hidden="true">{check.passed ? <IconCheck /> : <IconCross />}</span><span>{check.label}<span className="visually-hidden">{check.passed ? ': пройдена' : ': не пройдена'}</span>{check.details.length ? <span className="muted"> · {check.details.join('; ')}</span> : null}</span></li>)}</ul>
        )}
        {letter.testSends.length ? (
          <ul className="rows" style={{ marginTop: 12 }}>{letter.testSends.map((t) => <li key={t.id} className="history-row"><span className="num">{clockTime(t.createdAt, now)}</span><span>{t.ok ? 'тест ушёл' : <span className="bad-text">тест не ушёл</span>} на {t.sentTo}</span>{t.error ? <span className="muted">{t.error}</span> : null}</li>)}</ul>
        ) : null}
      </Panel>
      <ConfirmSheet request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

export function LettersScreen({ selectedId, owner }: { readonly selectedId: number | null; readonly owner: boolean }) {
  const { params, set } = useQueryParams();
  const { navigate } = useRouter();
  const query = params.toString();
  const listPoll = usePoll<Section<LetterList>>(`/api/letters${query ? `?${query}` : ''}`, 30_000);
  const [letter, setLetter] = useState<Section<Letter> | null>(null);
  const list = listPoll.data && !isUnavailable(listPoll.data) ? listPoll.data : null;
  const firstId = list?.items[0]?.id ?? null;
  const shownId = selectedId ?? firstId;

  useEffect(() => {
    if (shownId === null) { setLetter(null); return; }
    let live = true;
    void apiGet<Section<Letter>>(`/api/letters/${shownId}`).then((result) => { if (live && result.ok) setLetter(result.data); });
    return () => { live = false; };
  }, [shownId]);

  const onDone = (decided: boolean): void => {
    listPoll.refresh();
    if (decided && list) {
      const next = list.items.find((row) => row.id !== shownId);
      if (next) navigate(`/letters/${next.id}${query ? `?${query}` : ''}`);
    } else if (shownId !== null) {
      void apiGet<Section<Letter>>(`/api/letters/${shownId}`).then((result) => { if (result.ok) setLetter(result.data); });
    }
  };

  return (
    <div className="sheet-inner letters" data-detail={selectedId !== null ? 'yes' : 'no'}>
      <PageTitle title="Письма" sub={list?.run ? <>Запуск №{list.run.id}: {list.run.cityName}, «{list.run.query}». <Link to="/letters" className="text-link">Все запуски</Link></> : 'Проверка и одобрение писем компаниям. Компаниям письма пока не отправляются.'} />
      {list ? <div className="toolbar"><Chips label="Статус писем" value={params.get('status') ?? 'pending'} onChange={(code) => set({ status: code === 'pending' ? null : code })} options={list.filters} /></div> : null}
      {listPoll.data && isUnavailable(listPoll.data) ? <section className="panel"><div className="panel-body"><Unavailable source="leads" /></div></section> : null}
      {list ? (
        <div className="split">
          <div className="letters-list">
            <LetterQueue list={list} selected={shownId} query={query} />
            <Pager page={list.page} pages={list.pages} total={list.total} pageSize={list.pageSize} noun="писем" onPage={(page) => set({ page: String(page) })} />
          </div>
          <div className="letters-detail">
            {letter && !isUnavailable(letter) ? <LetterView letter={letter} owner={owner} onDone={onDone} /> : letter ? <Unavailable source="leads" /> : list.items.length ? <p className="muted">Загрузка письма…</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
