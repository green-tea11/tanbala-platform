import { Initial, LevelPill, Unavailable } from '../components/Bits';
import { Chips, Pager, PageTitle, SearchBox, Select, useQueryParams } from '../components/Ui';
import { clockTime, minutesSince, nameOf, phoneLabel, waitDuration } from '../lib/format';
import { Link, useRouter } from '../lib/router';
import { usePoll } from '../lib/usePoll';
import { isUnavailable, type ChatStatus, type Level, type Section } from '../lib/types';

const REPLY_TARGET_MIN = 15;

interface ChatRow {
  readonly id: number;
  readonly name: string | null;
  readonly phone: string | null;
  readonly status: ChatStatus;
  readonly statusLabel: string;
  readonly level: Level | null;
  readonly lastMessageAt: string | null;
  readonly lastMessage: { readonly author: string; readonly kind: string; readonly text: string | null } | null;
  readonly openHandoff: { readonly reasonLabel: string } | null;
  readonly company: { readonly state: string; readonly id: number | null; readonly name: string | null } | null;
  readonly waitingSince: string | null;
}

interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pages: number;
  readonly pageSize: number;
}

type ChatList = Page<ChatRow>;

function preview(row: ChatRow): string {
  const m = row.lastMessage;
  if (!m) return 'сообщений нет';
  const who = m.author === 'client' ? '' : m.author === 'bot' ? 'Бот: ' : 'Менеджер: ';
  if (m.kind === 'voice' && !m.text) return `${who}голосовое`;
  if (m.kind === 'other') return `${who}фото, файл или стикер`;
  return `${who}${m.text ?? ''}`;
}

export function ChatsScreen() {
  const { params, set } = useQueryParams();
  const { navigate } = useRouter();
  const query = params.toString();
  const poll = usePoll<Section<ChatList>>(`/api/chats${query ? `?${query}` : ''}`, 15_000);
  const data = poll.data;
  const status = params.get('status') ?? '';
  const now = poll.updatedAt ?? Date.now();

  return (
    <div className="sheet-inner">
      <PageTitle title="Чаты" sub={data && !isUnavailable(data) ? `${data.total} ${params.size ? 'по фильтру' : 'всего'}` : null} />
      <div className="toolbar">
        <Chips
          label="Кто ведёт"
          value={params.get('waiting') === '1' ? 'waiting' : status}
          onChange={(code) => set(code === 'waiting' ? { waiting: '1', status: null } : { status: code || null, waiting: null })}
          options={[
            { code: '', label: 'Все' },
            { code: 'waiting', label: 'Ждут ответа' },
            { code: 'manager', label: 'Ведёт менеджер' },
            { code: 'bot', label: 'Ведёт бот' },
          ]}
        />
        <Select
          label="Уровень интереса"
          value={params.get('level') ?? ''}
          onChange={(value) => set({ level: value || null })}
          options={[{ value: '', label: 'Любой интерес' }, { value: 'hot', label: 'Горячие' }, { value: 'warm', label: 'Тёплые' }, { value: 'cold', label: 'Холодные' }]}
        />
        <Select
          label="Компания"
          value={params.get('company') ?? ''}
          onChange={(value) => set({ company: value || null })}
          options={[{ value: '', label: 'Любая компания' }, { value: 'confirmed', label: 'Подтверждена' }, { value: 'candidate', label: 'Кандидат' }, { value: 'none', label: 'Не определена' }]}
        />
        <SearchBox value={params.get('q') ?? ''} placeholder="Имя или номер" maxLength={64} onSubmit={(q) => set({ q })} />
      </div>

      {data && isUnavailable(data) ? (
        <section className="panel"><div className="panel-body"><Unavailable source="wa" /></div></section>
      ) : (
        <section className="panel flush" aria-label="Список чатов">
          {data === null ? (
            <p className="unavail" style={{ padding: 20 }}>Загрузка…</p>
          ) : data.items.length === 0 ? (
            <div className="panel-body" style={{ paddingTop: 16 }}><p className="empty">По этим условиям чатов нет. <Link to="/chats" className="text-link">Сбросить фильтры</Link></p></div>
          ) : (
            <table className="table chats-table">
              <thead>
                <tr><th>Клиент</th><th>Кто ведёт</th><th>Компания</th><th>Последнее сообщение</th><th className="num-col">Ждёт</th></tr>
              </thead>
              <tbody>
                {data.items.map((row) => {
                  const waiting = row.waitingSince ? minutesSince(row.waitingSince, now) : null;
                  return (
                    <tr key={row.id} className="clickable" onClick={() => navigate(`/chats/${row.id}`)}>
                      <td>
                        <div className="row-line1">
                          <Initial id={row.id} name={row.name} />
                          <div className="row-main">
                            <Link to={`/chats/${row.id}`} className="cell-main">{nameOf(row.name)}</Link>
                            <div className="cell-sub">{row.phone ? <span className="mono">{phoneLabel(row.phone)}</span> : 'номер скрыт'}</div>
                          </div>
                        </div>
                      </td>
                      <td data-label="Ведёт">
                        <div>{row.status === 'manager' ? 'менеджер' : 'бот'} <LevelPill level={row.level} /></div>
                        {row.openHandoff ? <div className="cell-sub">передан: {row.openHandoff.reasonLabel}</div> : null}
                      </td>
                      <td data-label="Компания">
                        {row.company?.name ? (
                          <>
                            <div>{row.company.name}</div>
                            <div className="cell-sub">{row.company.state === 'confirmed' ? 'подтверждена' : 'кандидат'}</div>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <div className="cell-sub clamp" style={{ marginTop: 0, color: 'var(--text)' }}>{preview(row)}</div>
                        <div className="cell-sub">{clockTime(row.lastMessageAt, now)}</div>
                      </td>
                      <td className="num-col" data-label="Ждёт">
                        {waiting === null ? <span className="muted">—</span> : <span className={waiting > REPLY_TARGET_MIN ? 'bad-text' : undefined}>{waitDuration(waiting)}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}
      {data && !isUnavailable(data) ? (
        <Pager page={data.page} pages={data.pages} total={data.total} pageSize={data.pageSize} noun="чатов" onPage={(page) => set({ page: String(page) })} />
      ) : null}
    </div>
  );
}

interface NotificationRow {
  readonly id: number;
  readonly at: string;
  readonly kindLabel: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly attempts: number;
  readonly chatId: number | null;
  readonly chatName: string | null;
  readonly text: string;
}

const BAD_STATUSES = new Set(['failed', 'no_manager', 'skipped_limit']);

export function NotificationsScreen() {
  const { params, set } = useQueryParams();
  const query = params.toString();
  const poll = usePoll<Section<Page<NotificationRow>>>(`/api/notifications${query ? `?${query}` : ''}`, 30_000);
  const data = poll.data;
  const now = poll.updatedAt ?? Date.now();
  return (
    <div className="sheet-inner">
      <PageTitle title="Уведомления менеджеру" sub="Что бот отправил менеджеру в WhatsApp: передачи чатов, лимиты, простой." />
      <div className="toolbar">
        <Chips
          label="Статус"
          value={params.get('status') ?? ''}
          onChange={(code) => set({ status: code || null })}
          options={[
            { code: '', label: 'Все' },
            { code: 'failed', label: 'Сбой отправки' },
            { code: 'no_manager', label: 'Номер не задан' },
            { code: 'skipped_limit', label: 'Лимит' },
            { code: 'pending', label: 'Ждут' },
            { code: 'sent', label: 'Отправлены' },
          ]}
        />
      </div>
      {data && isUnavailable(data) ? (
        <section className="panel"><div className="panel-body"><Unavailable source="wa" /></div></section>
      ) : (
        <section className="panel flush" aria-label="Уведомления">
          {data === null ? null : data.items.length === 0 ? (
            <div className="panel-body" style={{ paddingTop: 16 }}><p className="empty">Уведомлений с таким статусом нет.</p></div>
          ) : (
            <table className="table">
              <thead><tr><th>Время</th><th>Чат</th><th>Вид</th><th>Статус</th><th>Текст</th></tr></thead>
              <tbody>
                {data.items.map((row) => (
                  <tr key={row.id}>
                    <td className="num" data-label="Время">{clockTime(row.at, now)}</td>
                    <td>{row.chatId ? <Link to={`/chats/${row.chatId}`} className="text-link">{nameOf(row.chatName)}</Link> : <span className="muted">чаты простоя</span>}</td>
                    <td data-label="Вид">{row.kindLabel}</td>
                    <td><span className={`pill ${BAD_STATUSES.has(row.status) ? 'bad' : row.status === 'pending' ? 'note' : 'ok'}`}>{row.statusLabel}{row.attempts > 1 ? ` · ${row.attempts}` : ''}</span></td>
                    <td><details className="note-text"><summary className="cell-sub clamp" style={{ marginTop: 0 }}>{row.text}</summary><p>{row.text}</p></details></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      {data && !isUnavailable(data) ? <Pager page={data.page} pages={data.pages} total={data.total} pageSize={data.pageSize} noun="уведомлений" onPage={(page) => set({ page: String(page) })} /> : null}
    </div>
  );
}
