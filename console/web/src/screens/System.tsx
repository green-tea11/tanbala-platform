import { useState } from 'react';
import { Panel, Unavailable } from '../components/Bits';
import { ConfirmSheet, OutcomeLine, Pager, PageTitle, useAction, useQueryParams, type ConfirmRequest } from '../components/Ui';
import { apiPost } from '../lib/api';
import { clockTime, count, usd } from '../lib/format';
import { Link, useRouter } from '../lib/router';
import { POLL_MS, usePoll } from '../lib/usePoll';
import { isUnavailable, type BotStatus, type LeadsSummary, type Section, type SpendTotal } from '../lib/types';

interface SpendDays { readonly days: readonly ({ readonly day: string } & SpendTotal)[]; readonly total: SpendTotal }
interface SystemSpend { readonly from: string; readonly to: string; readonly pricesAsOf: string; readonly bot: Section<SpendDays>; readonly leads: Section<SpendDays> }
interface AuditRow { readonly id: number; readonly at: string; readonly actor: string; readonly action: string; readonly target: string | null; readonly outcome: string | null; readonly ip: string | null }
interface UserRow { readonly name: string; readonly role: string; readonly active: boolean; readonly createdAt: string; readonly sessions: number }
interface SessionRow { readonly id: number; readonly user: string; readonly device: string | null; readonly ip: string | null; readonly createdAt: string; readonly lastSeenAt: string; readonly current: boolean }

const WA_STATE: Readonly<Record<string, string>> = { open: 'подключён', connecting: 'подключается', closed: 'не подключён', disabled: 'выключен' };

function SpendTable({ spend }: { readonly spend: SystemSpend }) {
  const bot = isUnavailable(spend.bot) ? null : spend.bot;
  const leads = isUnavailable(spend.leads) ? null : spend.leads;
  const days = [...new Set([...(bot?.days ?? []), ...(leads?.days ?? [])].map((d) => d.day))].sort().reverse();
  const of = (section: SpendDays | null, day: string) => section?.days.find((d) => d.day === day);
  return (
    <table className="table">
      <thead><tr><th>День</th><th className="num-col">Бот</th><th className="num-col">Почта</th><th className="num-col">Всего</th></tr></thead>
      <tbody>
        <tr className="total-row"><td><b>{spend.from} — {spend.to}</b></td><td className="num-col"><b>{bot ? usd(bot.total.usd) : '—'}</b></td><td className="num-col"><b>{leads ? usd(leads.total.usd) : '—'}</b></td><td className="num-col"><b>{bot && leads ? usd(Math.round((bot.total.usd ?? 0) * 100) / 100 + Math.round((leads.total.usd ?? 0) * 100) / 100) : '—'}</b></td></tr>
        {days.map((day) => {
          const b = of(bot, day); const l = of(leads, day);
          const sum = Math.round((b?.usd ?? 0) * 100) / 100 + Math.round((l?.usd ?? 0) * 100) / 100;
          return <tr key={day}><td className="num">{day.split('-').reverse().slice(0, 2).join('.')}</td><td className="num-col">{b ? usd(b.usd) : '—'}<div className="cell-sub">{b ? `${count(b.calls)} вызовов` : ''}</div></td><td className="num-col">{l ? usd(l.usd) : '—'}<div className="cell-sub">{l ? `${count(l.calls)} вызовов` : ''}</div></td><td className="num-col">{usd(sum)}</td></tr>;
        })}
      </tbody>
    </table>
  );
}

export function SystemScreen() {
  const { params, set } = useQueryParams();
  const status = usePoll<{ botStatus: Section<BotStatus & { pairingAttempts24h?: number; linkedAt?: string | null; research24h?: { count: number; limit: number } }>; leadsSummary: Section<LeadsSummary> }>('/api/system', POLL_MS.background);
  const spend = usePoll<SystemSpend>('/api/system/spend', POLL_MS.rare);
  const audit = usePoll<{ items: readonly AuditRow[]; total: number; page: number; pages: number; pageSize: number }>(`/api/system/audit?page=${params.get('page') ?? '1'}`, POLL_MS.rare);
  const users = usePoll<{ items: readonly UserRow[] }>('/api/system/users', POLL_MS.rare);
  const sessions = usePoll<{ items: readonly SessionRow[] }>('/api/system/sessions', POLL_MS.rare);
  const action = useAction();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const now = status.updatedAt ?? Date.now();
  const bot = status.data && !isUnavailable(status.data.botStatus) ? status.data.botStatus : null;
  const leads = status.data && !isUnavailable(status.data.leadsSummary) ? status.data.leadsSummary : null;

  const revokeAll = (): void => setConfirm({
    title: 'Выйти на всех устройствах?',
    body: <p>Закроются все сессии всех пользователей, кроме этой. Понадобится войти заново.</p>,
    confirmLabel: 'Выйти везде',
    danger: true,
    run: async () => { await action.run('/api/system/sessions/revoke-all'); sessions.refresh(); },
  });
  const revoke = (row: SessionRow): void => setConfirm({
    title: 'Закрыть сессию?',
    body: <p>{row.user}, {row.device ?? 'устройство неизвестно'}, последний раз {clockTime(row.lastSeenAt, now)}.</p>,
    confirmLabel: 'Закрыть',
    danger: true,
    run: async () => { await action.run(`/api/system/sessions/${row.id}/revoke`); sessions.refresh(); },
  });

  return (
    <div className="sheet-inner">
      <PageTitle title="Система" sub="Состояние бота и почты, лимиты, расход, журнал действий и входы." />
      <OutcomeLine outcome={action.outcome} />
      <div className="grid-2">
        <Panel id="sys-bot" title="Бот WhatsApp">
          {status.data && isUnavailable(status.data.botStatus) ? <Unavailable source="wa" /> : bot ? (
            <dl className="kv-rows">
              <div><dt>WhatsApp</dt><dd><span className={`pill ${bot.whatsapp.state === 'open' ? 'ok' : 'bad'}`}>{WA_STATE[bot.whatsapp.state] ?? bot.whatsapp.state}</span>{bot.whatsapp.since ? <span className="muted"> с {clockTime(bot.whatsapp.since, now)}</span> : null}</dd></div>
              <div><dt>Режим</dt><dd>{bot.testMode ? `закрытый: отвечает только номерам из списка (${bot.allowlistSize})` : 'рабочий: отвечает всем'}</dd></div>
              <div><dt>Номер менеджера</dt><dd>{bot.managerConfigured ? 'задан' : <span className="bad-text">не задан: уведомления только в панели</span>}</dd></div>
              <div><dt>Вызовов API за сутки</dt><dd className="num">{count(bot.apiCalls.today)} из {count(bot.apiCalls.dailyLimit)}</dd></div>
              {bot.research24h ? <div><dt>Проверок компаний</dt><dd className="num">{bot.research24h.count} из {bot.research24h.limit} за 24 часа</dd></div> : null}
              {bot.pairingAttempts24h !== undefined ? <div><dt>Привязок по QR</dt><dd className="num">{bot.pairingAttempts24h} из 2 за 24 часа</dd></div> : null}
            </dl>
          ) : null}
        </Panel>
        <Panel id="sys-leads" title="Почта">
          {status.data && isUnavailable(status.data.leadsSummary) ? <Unavailable source="leads" /> : leads ? (
            <dl className="kv-rows">
              <div><dt>Тестовая отправка</dt><dd>{leads.testMode.testAddress ? `только на ${leads.testMode.testAddress}` : <span className="bad-text">выключена</span>}</dd></div>
              <div><dt>Бюджет Claude API</dt><dd className="num">{usd(leads.budget.spentTodayUsd)} из {usd(leads.budget.dailyUsd)} сегодня{leads.budget.over ? ' — исчерпан' : ''}</dd></div>
              <div><dt>Проверки из WhatsApp</dt><dd className="num">{leads.research.today} из {leads.research.perDay} сегодня</dd></div>
              <div><dt>Тестовые письма</dt><dd className="num">{leads.testSends.today} из {leads.testSends.perDay} сегодня</dd></div>
              <div><dt>Компании</dt><dd className="num">{count(leads.overview.companiesFound)} найдено, {leads.overview.companiesFit} подходят, {leads.overview.whatsappCompanies} из WhatsApp</dd></div>
            </dl>
          ) : null}
        </Panel>
      </div>

      <div className="grid-2" style={{ marginTop: 24 }}>
        <Panel id="sys-spend" title="Расход Claude API по дням" aside={spend.data ? <span>цены на {spend.data.pricesAsOf}</span> : null} className="flush">
          {spend.data ? <SpendTable spend={spend.data} /> : null}
        </Panel>
        <div className="stack">
          <Panel id="sys-sessions" title="Входы" aside={<button type="button" className="btn small danger" onClick={revokeAll}>Выйти везде</button>} className="flush">
            <table className="table">
              <thead><tr><th>Кто и где</th><th className="num-col">Был</th><th /></tr></thead>
              <tbody>{sessions.data?.items.map((row) => (
                <tr key={row.id}>
                  <td><b>{row.user}</b>{row.current ? <span className="pill info">эта</span> : null}<div className="cell-sub">{row.device ?? 'устройство неизвестно'} · {row.ip ?? '—'}</div></td>
                  <td className="num-col">{clockTime(row.lastSeenAt, now)}</td>
                  <td className="num-col">{row.current ? null : <button type="button" className="btn small ghost" onClick={() => revoke(row)}>Закрыть</button>}</td>
                </tr>
              ))}</tbody>
            </table>
          </Panel>
          <Panel id="sys-users" title="Пользователи" aside={<span>заводятся командой на сервере</span>} className="flush">
            <table className="table">
              <tbody>{users.data?.items.map((u) => (
                <tr key={u.name}><td><b>{u.name}</b><div className="cell-sub">{u.role === 'owner' ? 'владелец' : 'менеджер'}{u.active ? '' : ', отключён'}</div></td><td className="num-col">входов: {u.sessions}</td></tr>
              ))}</tbody>
            </table>
          </Panel>
        </div>
      </div>

      <Panel id="sys-audit" title="Журнал действий" aside={<span>хранится 180 дней</span>} className="flush audit">
        <table className="table">
          <thead><tr><th>Когда</th><th>Кто</th><th>Что</th><th>Над чем</th><th>Итог</th></tr></thead>
          <tbody>{audit.data?.items.map((row) => (
            <tr key={row.id}>
              <td className="num">{clockTime(row.at, now)}</td>
              <td>{row.actor}<div className="cell-sub">{row.ip ?? ''}</div></td>
              <td>{row.action}</td>
              <td>{row.target?.startsWith('chat:') ? <Link to={`/chats/${row.target.slice(5)}`} className="text-link">{row.target}</Link> : row.target ?? '—'}</td>
              <td className={row.outcome && /fail|denied|refused|error/.test(row.outcome) ? 'bad-text' : undefined}>{row.outcome ?? '—'}</td>
            </tr>
          ))}</tbody>
        </table>
      </Panel>
      {audit.data ? <Pager page={audit.data.page} pages={audit.data.pages} total={audit.data.total} pageSize={audit.data.pageSize} noun="записей" onPage={(page) => set({ page: String(page) })} /> : null}
      <ConfirmSheet request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

export function LoginScreen({ onLogin }: { readonly onLogin: () => void }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await apiPost<{ user: { name: string } }>('/api/login', { name: name.trim(), password });
    setBusy(false);
    if (result.ok) onLogin();
    else setError(result.failure.message);
  };
  return (
    <main className="login">
      <form className="login-card form-grid" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h1>Вход в панель Tanbala</h1>
        <label><span>Имя</span><input type="text" name="username" autoComplete="username" autoCapitalize="none" value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label><span>Пароль</span><input type="password" name="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error ? <p className="notice bad" role="alert">{error}</p> : null}
        <button type="submit" className="btn primary" disabled={busy || !name || !password}>Войти</button>
      </form>
    </main>
  );
}

export function MoreScreen({ owner, onLogout }: { readonly owner: boolean; readonly onLogout: () => void }) {
  const { navigate } = useRouter();
  const items = [
    { to: '/search', label: 'Поиск компаний' },
    { to: '/history', label: 'Кому писали' },
    { to: '/notifications', label: 'Уведомления менеджеру' },
    ...(owner ? [{ to: '/system', label: 'Система' }] : []),
  ];
  return (
    <div className="sheet-inner">
      <PageTitle title="Ещё" />
      <section className="panel flush">
        <ul>{items.map((item) => <li key={item.to}><Link to={item.to} className="list-item more-item">{item.label}</Link></li>)}</ul>
      </section>
      <button type="button" className="btn" style={{ marginTop: 24 }} onClick={() => { void apiPost('/api/logout').then(() => { onLogout(); navigate('/'); }); }}>Выйти</button>
    </div>
  );
}
