import { Component, useCallback, useEffect, useState, type ReactNode } from 'react';
import { ModeBanner } from './components/Bits';
import { apiPost } from './lib/api';
import { Shell, type NavCounts } from './components/Shell';
import { loadSession } from './lib/api';
import { matchPath, useRouter } from './lib/router';
import { usePoll, type PollState } from './lib/usePoll';
import { isUnavailable, type Home, type Session } from './lib/types';
import { ChatsScreen, NotificationsScreen } from './screens/Chats';
import { ClientScreen } from './screens/Client';
import { CompaniesScreen, CompanyScreen } from './screens/Companies';
import { HistoryScreen } from './screens/History';
import { HomeScreen } from './screens/Home';
import { LettersScreen } from './screens/Letters';
import { SearchScreen } from './screens/Search';
import { LoginScreen, MoreScreen, SystemScreen } from './screens/System';

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

interface Route {
  readonly title: string;
  readonly back?: { readonly to: string; readonly label: string };
  /** Детальный экран на телефоне: без нижней панели, со стрелкой назад. */
  readonly detail: boolean;
  readonly element: ReactNode;
}

/** Сбой одного экрана не роняет всю панель: остальное меню и данные работают. */
class ScreenBoundary extends Component<{ readonly children: ReactNode; readonly path: string }, { readonly failed: boolean; readonly path: string }> {
  override state = { failed: false, path: this.props.path };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  static getDerivedStateFromProps(props: { path: string }, state: { failed: boolean; path: string }) {
    return props.path === state.path ? null : { failed: false, path: props.path };
  }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <div className="sheet-inner"><div className="title-row"><div><h1>Экран не открылся</h1><p className="finding muted">Обновите страницу. Остальные разделы работают.</p></div></div></div>;
  }
}

function NotFound({ text }: { readonly text: string }) {
  return <div className="sheet-inner"><div className="title-row"><div><h1>{text}</h1></div></div></div>;
}

function routeFor(path: string, session: Session, home: PollState<Home>, onLogout: () => void): Route {
  const owner = session.user.role === 'owner';
  const chat = matchPath('/chats/:id', path);
  if (chat) return { title: 'Клиент', back: { to: '/chats', label: 'Чаты' }, detail: true, element: <ClientScreen key={chat['id']} chatId={Number(chat['id'])} home={home.data} /> };
  const company = matchPath('/companies/:id', path);
  if (company) return { title: 'Компания', back: { to: '/companies', label: 'Компании' }, detail: true, element: <CompanyScreen id={Number(company['id'])} owner={owner} /> };
  const letter = matchPath('/letters/:id', path);
  if (letter) return { title: 'Письмо', back: { to: '/letters', label: 'Письма' }, detail: false, element: <LettersScreen selectedId={Number(letter['id'])} owner={owner} /> };
  const title = TITLES[path] ?? 'Нет такой страницы';
  switch (path) {
    case '/': return { title, detail: false, element: <HomeScreen poll={home} /> };
    case '/chats': return { title, detail: false, element: <ChatsScreen /> };
    case '/companies': return { title, detail: false, element: <CompaniesScreen /> };
    case '/letters': return { title, detail: false, element: <LettersScreen selectedId={null} owner={owner} /> };
    case '/search': return { title, detail: false, element: <SearchScreen owner={owner} /> };
    case '/history': return { title, detail: false, element: <HistoryScreen owner={owner} /> };
    case '/notifications': return { title, detail: false, element: <NotificationsScreen /> };
    case '/system': return { title, detail: false, element: owner ? <SystemScreen /> : <NotFound text="Этот раздел только для владельца." /> };
    case '/more': return { title, detail: false, element: <MoreScreen owner={owner} onLogout={onLogout} /> };
    default: return { title, detail: false, element: <NotFound text="Такой страницы нет." /> };
  }
}

function Workspace({ session, onLogout, onExpired }: { readonly session: Session; readonly onLogout: () => void; readonly onExpired: () => void }) {
  const { path } = useRouter();
  const onHome = path === '/';
  const home = usePoll<Home>('/api/home', onHome ? HOME_POLL_MS : BACKGROUND_POLL_MS);
  const route = routeFor(path, session, home, onLogout);

  useEffect(() => {
    document.title = `${route.title}: Tanbala`;
  }, [route.title]);

  useEffect(() => {
    if (home.error?.error === 'no_session') onExpired();
  }, [home.error, onExpired]);

  const logout = useCallback(() => {
    void apiPost('/api/logout').then(onLogout);
  }, [onLogout]);

  return (
    <Shell session={session} counts={countsOf(home.data)} phoneTitle={onHome ? 'Tanbala' : route.title} back={route.back} hideTabbar={route.detail} onLogout={logout}>
      {home.data ? <div className={`mode-wrap${route.detail ? ' on-detail' : ''}`}><ModeBanner mode={home.data.mode} /></div> : null}
      <ScreenBoundary path={path}>{route.element}</ScreenBoundary>
    </Shell>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<'loading' | 'login' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void loadSession().then((result) => {
      if (result.ok) {
        setSession(result.data);
        setState('ready');
      } else if (result.failure.error === 'no_session') {
        setSession(null);
        setState('login');
      } else {
        setMessage(result.failure.message);
        setState('error');
      }
    });
  }, []);

  useEffect(refresh, [refresh]);

  const logout = useCallback(() => {
    setSession(null);
    setState('login');
  }, []);
  // Сессия кончилась посреди работы: вход слоем поверх, экран под ним не размонтируется — набранный текст цел.
  const expired = useCallback(() => setState('login'), []);

  if (state === 'error') return <p className="boot">{message} <button type="button" className="btn small" onClick={refresh}>Повторить</button></p>;
  if (session === null) return state === 'login' ? <LoginScreen onLogin={refresh} /> : <p className="boot muted">Загрузка…</p>;
  return (
    <>
      <div inert={state === 'login'}><Workspace session={session} onLogout={logout} onExpired={expired} /></div>
      {state === 'login' ? <div className="login-overlay"><LoginScreen onLogin={refresh} /></div> : null}
    </>
  );
}
