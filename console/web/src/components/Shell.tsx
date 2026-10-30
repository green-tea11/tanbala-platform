import type { ReactNode } from 'react';
import { Link, useRouter } from '../lib/router';
import type { Session } from '../lib/types';
import {
  IconBack, IconBell, IconChats, IconCompanies, IconHistory, IconHome, IconLetters, IconMore, IconSearch, IconSystem,
} from './Icons';
import { Mark } from './Mark';

export interface NavCounts {
  /** Клиенты ждут человека — очередь, где нужен ответ. */
  readonly waiting: number;
  /** Письма ждут проверки. */
  readonly letters: number;
}

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly short: string;
  readonly icon: ReactNode;
  readonly count?: keyof NavCounts;
  readonly ownerOnly?: boolean;
}

const NAV: readonly NavItem[] = [
  { to: '/', label: 'Требует внимания', short: 'Главная', icon: <IconHome /> },
  { to: '/chats', label: 'Чаты', short: 'Чаты', icon: <IconChats />, count: 'waiting' },
  { to: '/companies', label: 'Компании', short: 'Компании', icon: <IconCompanies /> },
  { to: '/letters', label: 'Письма', short: 'Письма', icon: <IconLetters />, count: 'letters' },
  { to: '/search', label: 'Поиск компаний', short: 'Поиск', icon: <IconSearch /> },
  { to: '/history', label: 'Кому писали', short: 'История', icon: <IconHistory /> },
  { to: '/notifications', label: 'Уведомления', short: 'Уведомления', icon: <IconBell /> },
  { to: '/system', label: 'Система', short: 'Система', icon: <IconSystem />, ownerOnly: true },
];

const TABS: readonly string[] = ['/', '/chats', '/companies', '/letters'];

function isActive(path: string, to: string): boolean {
  return to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`);
}

interface ShellProps {
  readonly session: Session;
  readonly counts: NavCounts;
  /** Строка над листом на телефоне: заголовок экрана и, если есть, путь назад. */
  readonly phoneTitle: string;
  readonly back?: { readonly to: string; readonly label: string } | undefined;
  /** Детальные экраны на телефоне прячут нижнюю панель: внизу их собственное поле ответа. */
  readonly hideTabbar?: boolean;
  readonly stamp?: string | null;
  readonly children: ReactNode;
}

export function Shell({ session, counts, phoneTitle, back, hideTabbar, stamp, children }: ShellProps) {
  const { path } = useRouter();
  const items = NAV.filter((item) => !item.ownerOnly || session.user.role === 'owner');
  const roleLabel = session.user.role === 'owner' ? 'владелец' : 'менеджер';

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Разделы">
        <div className="brand">
          <Mark />
          <div>
            <div className="brand-name">Tanbala</div>
            <div className="brand-scope">RFID-учёт · панель</div>
          </div>
        </div>
        <nav className="nav">
          {items.map((item) => {
            const value = item.count ? counts[item.count] : 0;
            return (
              <Link key={item.to} to={item.to} aria-current={isActive(path, item.to) ? 'page' : undefined}>
                {item.icon}
                <span>{item.label}</span>
                {value > 0 ? <span className={`count${item.count === 'waiting' ? ' alert' : ''}`}>{value}</span> : null}
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <span className="initial" style={{ background: 'hsl(205 30% 90%)', color: 'hsl(205 40% 26%)' }} aria-hidden="true">
            {session.user.name.charAt(0).toUpperCase()}
          </span>
          <div className="who">
            <b>{session.user.name}</b>
            <span>{roleLabel}</span>
          </div>
        </div>
      </aside>

      <header className="topbar">
        <form className="search" role="search" action="/chats" method="get">
          <IconSearch />
          <label className="visually-hidden" htmlFor="global-search">Поиск клиента</label>
          <input id="global-search" name="q" type="search" placeholder="Клиент по имени или номеру" autoComplete="off" />
          <kbd>/</kbd>
        </form>
        {stamp ? <span className="topbar-stamp">{stamp}</span> : null}
      </header>

      <div className="phone-bar">
        {back ? (
          <Link to={back.to} className="back" aria-label={`Назад: ${back.label}`}>
            <IconBack size={18} />
            {back.label}
          </Link>
        ) : (
          <Mark size={22} />
        )}
        {back ? null : <span className="title">{phoneTitle}</span>}
        <div className="end">{stamp && !back ? <span className="topbar-stamp">{stamp}</span> : null}</div>
      </div>

      <main className="sheet" id="main">
        {children}
      </main>

      {hideTabbar ? null : (
        <nav className="tabbar" aria-label="Разделы">
          {TABS.map((to) => {
            const item = NAV.find((n) => n.to === to);
            if (!item) return null;
            const value = item.count ? counts[item.count] : 0;
            return (
              <Link key={to} to={to} aria-current={isActive(path, to) ? 'page' : undefined}>
                {item.icon}
                <span>{item.short}</span>
                {value > 0 && item.count === 'waiting' ? <span className="count">{value}</span> : null}
              </Link>
            );
          })}
          <Link to="/more" aria-current={path === '/more' ? 'page' : undefined}>
            <IconMore />
            <span>Ещё</span>
          </Link>
        </nav>
      )}
    </div>
  );
}
