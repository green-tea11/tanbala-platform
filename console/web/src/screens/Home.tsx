import { useState } from 'react';
import { Initial, LevelPill, ModeBanner, Panel, Skeleton, Unavailable } from '../components/Bits';
import { IconRefresh } from '../components/Icons';
import { apiPost } from '../lib/api';
import { clockTime, minutesSince, nameOf, relativeTime, waitDuration } from '../lib/format';
import { Link } from '../lib/router';
import type { PollState } from '../lib/usePoll';
import { isUnavailable, type Attention, type AttentionHandoff, type AttentionWaiting, type Home, type LeadsSummary } from '../lib/types';
import { LeadsNow } from './HomeLeads';
import { SpendPanel } from './HomeSpend';

/** Обещание ответа клиенту: метка на шкале ожидания. */
const REPLY_TARGET_MIN = 15;
const SCALE_MIN = 60;

function waitingRows(attention: Attention): AttentionWaiting[] {
  return [...attention.waiting].sort((a, b) => Date.parse(a.waitingSince) - Date.parse(b.waitingSince));
}

function handoffOf(attention: Attention, chatId: number): AttentionHandoff | undefined {
  return attention.handoffs.find((h) => h.chatId === chatId);
}

/** Главный факт экрана: кто ждёт дольше всех и что мешает (не дошло уведомление). */
function finding(home: Home, now: number): React.ReactNode {
  const attention = home.attention;
  if (isUnavailable(attention)) return <span className="muted">Бот не отвечает: очередь клиентов не видна.</span>;
  const first = waitingRows(attention)[0];
  if (!first) return <span className="muted">Никто не ждёт ответа человека.</span>;
  const minutes = minutesSince(first.waitingSince, now);
  const handoff = handoffOf(attention, first.chatId);
  const failed = handoff?.notification && !['sent', 'pending'].includes(handoff.notification.status);
  const why = first.group === 'bot' ? ': бот не ответил' : handoff ? `: ${handoff.reasonLabel}` : ': написал после ответа человека';
  return (
    <>
      {nameOf(first.name)} ждёт {waitDuration(minutes)}{why}
      {failed ? <span className="muted">, а уведомление менеджеру не дошло ({handoff?.notification?.attempts} попыток)</span> : null}.
    </>
  );
}

function WaitStrip({ minutes }: { readonly minutes: number }) {
  const share = Math.min(1, minutes / SCALE_MIN);
  const over = minutes > REPLY_TARGET_MIN;
  return (
    <span className="wait-strip" aria-hidden="true">
      <span className="wait-track" />
      <span className={`wait-fill${over ? ' over' : ''}`} style={{ width: `${share * 100}%` }} />
      <span className="wait-target" style={{ left: `${(REPLY_TARGET_MIN / SCALE_MIN) * 100}%` }} />
    </span>
  );
}

function WaitingPanel({ attention, now }: { readonly attention: Attention; readonly now: number }) {
  const rows = waitingRows(attention);
  const total = attention.counts?.waiting.total ?? rows.length;
  const longest = rows[0] ? minutesSince(rows[0].waitingSince, now) : 0;
  return (
    <Panel
      id="waiting"
      title="Ждут человека"
      count={total}
      className="waiting"
      aside={<span>шкала на час, черта: {REPLY_TARGET_MIN} мин</span>}
      foot={
        <>
          <span className="foot-note">{attention.counts?.waiting.staleExcluded ? `Старше 30 дней скрыто: ${attention.counts.waiting.staleExcluded}` : 'Последним написал клиент'}</span>
          <Link to="/chats?waiting=1" className="text-link">Все ждущие</Link>
        </>
      }
    >
      {rows.length === 0 ? (
        <p className="empty">Никто не ждёт ответа. Новые передачи от бота появятся здесь сами.</p>
      ) : (
        <>
          <div className="lead-figure">
            <span className={`num${longest > REPLY_TARGET_MIN ? ' over' : ''}`}>{waitDuration(longest)}</span>
            <span className="muted">дольше всех ждёт {nameOf(rows[0]?.name)}</span>
          </div>
          <ul className="rows">
            {rows.map((row) => {
              const minutes = minutesSince(row.waitingSince, now);
              const handoff = handoffOf(attention, row.chatId);
              return (
                <li key={row.chatId}>
                  <Link to={`/chats/${row.chatId}`} className="row-link">
                    <div className="row wait-row">
                      <Initial id={row.chatId} name={row.name} />
                      <div className="row-main">
                        <div className="row-line1">
                          <span className="who">{nameOf(row.name)}</span>
                          {row.companyName ? <span className="org">{row.companyName}</span> : null}
                        </div>
                        <div className="row-line2">
                          {row.group === 'bot' ? <span className="pill bad">бот молчит</span> : handoff ? <span className="why">{handoff.reasonLabel}</span> : null}
                          {row.lastText ? <span className="quote">«{row.lastText}»</span> : null}
                        </div>
                      </div>
                      <WaitStrip minutes={minutes} />
                      <span className={`wait-time num${minutes > REPLY_TARGET_MIN ? ' over' : ''}`}>{waitDuration(minutes)}</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Panel>
  );
}

function HandoffsPanel({ attention, now, onSeen }: { readonly attention: Attention; readonly now: number; readonly onSeen: () => void }) {
  const [busy, setBusy] = useState(false);
  const rows = attention.handoffs;
  const unseen = rows.filter((h) => h.seen === false);
  const notDelivered = rows.filter((h) => h.notification && !['sent', 'pending'].includes(h.notification.status)).length;
  const markSeen = async (): Promise<void> => {
    setBusy(true);
    await apiPost('/api/seen', { kind: 'handoff', ids: unseen.map((h) => h.id) });
    setBusy(false);
    onSeen();
  };
  return (
    <Panel
      id="handoffs"
      title="Передачи от бота"
      count={attention.counts?.handoffs.total ?? rows.length}
      aside={<span>открытые</span>}
      foot={
        <>
          {unseen.length > 0 ? (
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => void markSeen()}>
              Отметить просмотренными
            </button>
          ) : (
            <span>Закрывает передачу «Вернуть боту»</span>
          )}
          <Link to="/notifications" className="text-link">Уведомления</Link>
        </>
      }
    >
      {rows.length === 0 ? (
        <p className="empty">Открытых передач нет.</p>
      ) : (
        <>
        <p className="lead-line">
          <span className="num">{unseen.length}</span> {unseen.length === 1 ? 'новая' : 'новых'}
          {notDelivered > 0 ? <span className="bad-text"> · {notDelivered} {notDelivered === 1 ? 'не дошла' : 'не дошли'} до менеджера</span> : <span className="muted"> · уведомления дошли</span>}
        </p>
        <ul className="rows">
          {rows.map((h) => {
            const failed = h.notification && !['sent', 'pending'].includes(h.notification.status);
            return (
              <li key={h.id}>
                <Link to={`/chats/${h.chatId}`} className="row-link">
                  <div className="row handoff-row">
                    <Initial id={h.chatId} name={h.name} />
                    <div className="row-main">
                      <div className="row-line1">
                        <span className="who">{nameOf(h.name)}</span>
                        {h.seen === false ? <span className="dot-new" title="новая" /> : null}
                      </div>
                      <div className="row-line2">
                        {h.reasonLabel} · {relativeTime(h.openedAt, now)}
                      </div>
                    </div>
                    {failed ? (
                      <span className="pill bad" title={h.notification?.statusLabel}>
                        не дошло · {h.notification?.attempts}
                      </span>
                    ) : (
                      <LevelPill level={h.level} />
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
        </>
      )}
    </Panel>
  );
}

function HotPanel({ attention, now }: { readonly attention: Attention; readonly now: number }) {
  const rows = attention.hot.slice(0, 4);
  return (
    <Panel id="hot" title="Горячие" count={attention.counts?.hot.total ?? attention.hot.length} aside={<Link to="/chats?level=hot" className="text-link">Все</Link>}>
      {rows.length === 0 ? (
        <p className="empty">Горячих клиентов сейчас нет.</p>
      ) : (
        <ul className="rows">
          {rows.map((h) => (
            <li key={h.chatId}>
              <Link to={`/chats/${h.chatId}`} className="row-link">
                <div className="row compact-row">
                  <div className="row-main">
                    <div className="row-line1">
                      <span className="who">{nameOf(h.name)}</span>
                      <span className="org">{h.status === 'manager' ? 'у менеджера' : 'у бота'}</span>
                    </div>
                    <div className="row-line2 wrap">{h.levelReason ?? 'Причина оценки не записана'}</div>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function AfterLetterPanel({ home, now }: { readonly home: Home; readonly now: number }) {
  const data = home.afterLetter;
  if (isUnavailable(data)) {
    return (
      <Panel id="after" title="Писали после письма">
        <Unavailable source={data.source ?? 'wa'} />
      </Panel>
    );
  }
  return (
    <Panel id="after" title="Писали после письма" count={data.total}>
      {data.items.length === 0 ? (
        <p className="empty">Пока никто из тех, кому писали, не написал в WhatsApp.</p>
      ) : (
        <ul className="rows">
          {data.items.slice(0, 3).map((item) => (
            <li key={item.chatId}>
              <Link to={`/chats/${item.chatId}`} className="row-link">
                <div className="row compact-row">
                  <div className="row-main">
                    <div className="row-line1">
                      <span className="who">{nameOf(item.chatName)}</span>
                      {item.seen ? null : <span className="dot-new" title="новое" />}
                    </div>
                    <div className="row-line2">{item.companyName ?? 'компания'}</div>
                    <div className="row-line2">
                      через {item.daysAfter} дн. после письма {clockTime(item.firstLetterAt, now).split(' ')[0]}
                    </div>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="panel-note">{data.note}</p>
    </Panel>
  );
}

function HomeSkeleton() {
  return (
    <div className="home-grid" aria-busy="true">
      <section className="panel waiting"><div className="panel-head"><h2>Ждут человека</h2></div><div className="panel-body skeleton-rows"><Skeleton width={120} height={28} /><Skeleton width="80%" /><Skeleton width="70%" /><Skeleton width="75%" /></div></section>
      <section className="panel"><div className="panel-head"><h2>Передачи от бота</h2></div><div className="panel-body skeleton-rows"><Skeleton width="80%" /><Skeleton width="60%" /></div></section>
    </div>
  );
}

export function HomeScreen({ poll }: { readonly poll: PollState<Home> }) {
  const home = poll.data;
  const now = poll.updatedAt ?? Date.now();
  return (
    <div className="sheet-inner">
      {home ? <ModeBanner mode={home.mode} /> : null}
      <div className="title-row">
        <div className="title-main">
          <h1>Требует внимания</h1>
          <p className="finding" aria-live="polite">
            {home ? finding(home, now) : poll.error ? <span className="muted">{poll.error.message}</span> : <Skeleton width={300} />}
          </p>
        </div>
        <div className="title-actions">
          <span className="muted stamp">{poll.updatedAt ? `Обновлено ${clockTime(new Date(poll.updatedAt).toISOString())}` : null}</span>
          <button type="button" className="btn icon-btn" onClick={poll.refresh} aria-label="Обновить">
            <IconRefresh />
          </button>
        </div>
      </div>

      {home === null ? (
        <HomeSkeleton />
      ) : (
        <>
          <div className="home-grid">
            {isUnavailable(home.attention) ? (
              <Panel id="waiting" title="Ждут человека" className="waiting"><Unavailable source="wa" /></Panel>
            ) : (
              <WaitingPanel attention={home.attention} now={now} />
            )}
            {isUnavailable(home.attention) ? (
              <Panel id="handoffs" title="Передачи от бота"><Unavailable source="wa" /></Panel>
            ) : (
              <HandoffsPanel attention={home.attention} now={now} onSeen={poll.refresh} />
            )}
          </div>
          <div className="home-grid four">
            {isUnavailable(home.attention) ? <Panel id="hot" title="Горячие"><Unavailable source="wa" /></Panel> : <HotPanel attention={home.attention} now={now} />}
            <AfterLetterPanel home={home} now={now} />
            <LeadsNow summary={home.leadsSummary as LeadsSummary | { unavailable: true }} now={now} />
            <SpendPanel spend={home.spend} />
          </div>
        </>
      )}
    </div>
  );
}
