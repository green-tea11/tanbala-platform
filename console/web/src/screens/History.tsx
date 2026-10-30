import { useState } from 'react';
import { Panel, Unavailable } from '../components/Bits';
import { OutcomeLine, Pager, PageTitle, useAction, useQueryParams } from '../components/Ui';
import { clockTime } from '../lib/format';
import { Link } from '../lib/router';
import { usePoll } from '../lib/usePoll';
import { isUnavailable, type Section } from '../lib/types';

interface Page<T> { readonly items: readonly T[]; readonly total: number; readonly page: number; readonly pages: number; readonly pageSize: number }
interface HistoryRow { readonly id: number; readonly occurredAt: string; readonly email: string; readonly whatLabel: string; readonly sourceLabel: string; readonly subject: string | null; readonly note: string | null; readonly companyId: number | null; readonly companyName: string | null }
interface BlockedRow { readonly id: number; readonly email: string | null; readonly domain: string | null; readonly companyId: number | null; readonly companyName: string | null; readonly reasonLabel: string; readonly note: string | null; readonly createdAt: string }
interface ImportResult { readonly added: number; readonly existing: number; readonly invalid: readonly string[]; readonly invalidMore: number; readonly message?: string }

const FILE_MAX = 1024 * 1024;

/** Файл читается в браузере как байты и уходит base64: почта сама проверит UTF-8 («Файл не в кодировке UTF-8»). */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function ImportForm({ kind, title, hint, onDone }: { readonly kind: 'written' | 'refused'; readonly title: string; readonly hint: string; readonly onDone: () => void }) {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const action = useAction();
  const submit = async (): Promise<void> => {
    if (file && file.size > FILE_MAX) { action.setOutcome({ tone: 'bad', text: 'Файл больше 1 МБ.' }); return; }
    setBusy(true);
    const body: Record<string, unknown> = { kind };
    if (text.trim()) body['text'] = text;
    if (file) body['fileBase64'] = await fileToBase64(file);
    const response = await action.run<ImportResult>('/api/history/import', body);
    setBusy(false);
    if (response.ok) { setResult(response.data); setText(''); setFile(null); onDone(); }
  };
  return (
    <Panel id={`import-${kind}`} title={title}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label><span>Адреса{kind === 'refused' ? ' или домены' : ''}, по одному в строке</span><textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === 'refused' ? 'sales@example.kz\nexample.kz' : 'director@example.kz'} /></label>
        <label><span>Или файл .txt / .csv (до 1 МБ, UTF-8)</span><input type="file" accept=".txt,.csv,text/plain,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        <p className="hint">{hint}</p>
        <div><button type="submit" className="btn primary" disabled={busy || (!text.trim() && !file)}>Добавить</button></div>
      </form>
      <div style={{ marginTop: 12 }}><OutcomeLine outcome={action.outcome} /></div>
      {result ? (
        <p className="hint">
          Добавлено {result.added}, уже были {result.existing} (в том числе адреса из «не писать»)
          {result.invalid.length ? `, не распознано: ${result.invalid.join(', ')}${result.invalidMore ? ` и ещё ${result.invalidMore}` : ''}` : ''}.
        </p>
      ) : null}
    </Panel>
  );
}

export function HistoryScreen({ owner }: { readonly owner: boolean }) {
  const { params, set } = useQueryParams();
  const history = usePoll<Section<Page<HistoryRow>>>(`/api/history?page=${params.get('hpage') ?? '1'}`, 0);
  const blocked = usePoll<Section<Page<BlockedRow>>>(`/api/blocked?page=${params.get('bpage') ?? '1'}`, 0);
  const now = history.updatedAt ?? Date.now();
  const refresh = (): void => { history.refresh(); blocked.refresh(); };
  return (
    <div className="sheet-inner">
      <PageTitle title="Кому писали" sub="История писем и список «не писать»: первое письмо этим адресам и компаниям не уйдёт." />
      {owner ? (
        <div className="grid-2" style={{ marginBottom: 24 }}>
          <ImportForm kind="written" title="Уже писали раньше" hint="Первое письмо на эти адреса и их компаниям не уйдёт." onDone={refresh} />
          <ImportForm kind="refused" title="Не писать" hint="Адреса или домены: sales@example.kz, example.kz. Адрес бесплатной почты закрывает только сам адрес." onDone={refresh} />
        </div>
      ) : null}
      <div className="grid-2">
        <div>
          <Panel id="history-list" title="История писем" count={history.data && !isUnavailable(history.data) ? history.data.total : undefined} className="flush">
            {history.data && isUnavailable(history.data) ? <Unavailable source="leads" /> : history.data && history.data.items.length === 0 ? <p className="empty" style={{ margin: 16 }}>Писем ещё не было.</p> : (
              <table className="table">
                <thead><tr><th>Когда</th><th>Кому</th><th>Что</th></tr></thead>
                <tbody>{history.data?.items.map((h) => (
                  <tr key={h.id}>
                    <td className="num">{clockTime(h.occurredAt, now)}</td>
                    <td><div className="ellipsis">{h.email}</div>{h.companyId ? <Link to={`/companies/${h.companyId}`} className="cell-sub text-link">{h.companyName}</Link> : null}</td>
                    <td><div>{h.whatLabel}</div><div className="cell-sub">{h.sourceLabel}{h.subject ? ` · ${h.subject}` : ''}{h.note ? ` · ${h.note}` : ''}</div></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </Panel>
          {history.data && !isUnavailable(history.data) ? <Pager page={history.data.page} pages={history.data.pages} total={history.data.total} pageSize={history.data.pageSize} noun="записей" onPage={(page) => set({ hpage: String(page) })} /> : null}
        </div>
        <div>
          <Panel id="blocked-list" title="Не писать" count={blocked.data && !isUnavailable(blocked.data) ? blocked.data.total : undefined} className="flush">
            {blocked.data && isUnavailable(blocked.data) ? <Unavailable source="leads" /> : blocked.data && blocked.data.items.length === 0 ? <p className="empty" style={{ margin: 16 }}>Список пуст.</p> : (
              <table className="table">
                <thead><tr><th>Кого</th><th>Почему</th><th className="num-col">Когда</th></tr></thead>
                <tbody>{blocked.data?.items.map((b) => (
                  <tr key={b.id}>
                    <td>{b.companyId ? <Link to={`/companies/${b.companyId}`} className="text-link">{b.companyName}</Link> : <span className="ellipsis">{b.email ?? b.domain}</span>}<div className="cell-sub">{b.companyId ? 'компания' : b.email ? 'адрес' : 'домен'}</div></td>
                    <td><div>{b.reasonLabel}</div>{b.note ? <div className="cell-sub">{b.note}</div> : null}</td>
                    <td className="num-col">{clockTime(b.createdAt, now)}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </Panel>
          {blocked.data && !isUnavailable(blocked.data) ? <Pager page={blocked.data.page} pages={blocked.data.pages} total={blocked.data.total} pageSize={blocked.data.pageSize} noun="записей" onPage={(page) => set({ bpage: String(page) })} /> : null}
        </div>
      </div>
    </div>
  );
}
