import { useEffect, useState } from 'react';
import { Shell, type NavCounts } from './components/Shell';
import { loadSession } from './lib/api';
import { matchPath, useRouter } from './lib/router';
import { usePoll } from './lib/usePoll';
import { isUnavailable, type Home, type Session } from './lib/types';
import { ClientScreen } from './screens/Client';
import { HomeScreen } from './screens/Home';

const HOME_POLL_MS = 15_000;
const BACKGROUND_POLL_MS = 60_000;

const TITLES: Readonly<Record<string, string>> = {
  '/': 'Требует внимания',
  '/chats': 'Чаты',
  '/companies': 'Компании',
  '/letters': 'Письма',
  '/search': 'Поиск компаний',
  '/history': 'Кому писали',
  '/notifications': 'Уведомления',
  '/system': 'Система',
  '/more': 'Ещё',
};

function countsOf(home: Home | null): NavCounts {
  if (home === null) return { waiting: 0, letters: 0 };
  const waiting = isUnavailable(home.attention) ? 0 : (home.attention.counts?.waiting.total ?? home.attention.waiting.length);
  const letters = isUnavailable(home.leadsSummary) ? 0 : home.leadsSummary.overview.lettersPending;
  return { waiting, letters };
}

function NotYet({ title }: { readonly title: string }) {
  return (
    <div className="sheet-inner">
      <div className="title-row"><div><h1>{title}</h1><p className="finding muted">Этот экран собирается следующим, в том же виде.</p></div></div>
    </div>
  );
}

export function App() {
  const { path } = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const onHome = path === '/';
  const home = usePoll<Home>('/api/home', onHome ? HOME_POLL_MS : BACKGROUND_POLL_MS);

  useEffect(() => {
    void loadSession().then((result) => {
      if (result.ok) setSession(result.data);
      else setSessionError(result.failure.message);
    });
  }, []);

  const client = matchPath('/chats/:id', path);
  const title = client ? 'Клиент' : (TITLES[path] ?? 'Tanbala');

  useEffect(() => {
    document.title = `${title}: Tanbala`;
  }, [title]);

  if (session === null) {
    return <p className="boot muted">{sessionError ?? 'Загрузка…'}</p>;
  }

  return (
    <Shell
      session={session}
      counts={countsOf(home.data)}
      phoneTitle={onHome ? 'Tanbala' : title}
      back={client ? { to: '/chats', label: 'Чаты' } : undefined}
      hideTabbar={client !== null}
      stamp={null}
    >
      {onHome ? <HomeScreen poll={home} /> : client ? <ClientScreen chatId={Number(client['id'])} home={home.data} /> : <NotYet title={title} />}
    </Shell>
  );
}
