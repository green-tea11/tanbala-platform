import type { ReactNode } from 'react';
import { initialOf, personHue } from '../lib/format';
import type { Home, Level } from '../lib/types';

/** Инициал человека на бледной подложке его оттенка (подложка — личность, не данные). */
export function Initial({ id, name }: { readonly id: number; readonly name: string | null }) {
  const hue = personHue(id);
  return (
    <span className="initial" style={{ background: `hsl(${hue} 55% 92%)`, color: `hsl(${hue} 45% 28%)` }} aria-hidden="true">
      {initialOf(name)}
    </span>
  );
}

const LEVEL_TEXT: Readonly<Record<Level, string>> = { hot: 'горячий', warm: 'тёплый', cold: 'холодный' };

export function LevelPill({ level }: { readonly level: Level | null }) {
  if (level === null) return null;
  return <span className={`pill ${level}`}>{LEVEL_TEXT[level]}</span>;
}

/** Полоса режима: бот и почта, всегда с фразой, что компаниям письма не уходят. */
export function ModeBanner({ mode }: { readonly mode: Home['mode'] }) {
  const alert = ['unavailable', 'disconnected', 'disabled'].includes(mode.bot.code) || mode.leads.code === 'unavailable';
  return (
    <p className={`mode${alert ? ' alert' : ''}`} role="status">
      <span>{mode.bot.text}.</span>
      <span>{mode.leads.text}.</span>
      <span>{mode.lettersNote}</span>
    </p>
  );
}

interface PanelProps {
  readonly title: string;
  readonly count?: number | undefined;
  readonly aside?: ReactNode;
  readonly foot?: ReactNode;
  readonly className?: string;
  readonly id?: string;
  readonly children: ReactNode;
}

export function Panel({ title, count, aside, foot, className, id, children }: PanelProps) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className={`panel${className ? ` ${className}` : ''}`} aria-labelledby={headingId}>
      <header className="panel-head">
        <h2 id={headingId}>
          {title}
          {count !== undefined ? <span className="num">{count}</span> : null}
        </h2>
        {aside ? <div className="aside">{aside}</div> : null}
      </header>
      <div className="panel-body">{children}</div>
      {foot ? <footer className="panel-foot">{foot}</footer> : null}
    </section>
  );
}

/** Раздел недоступен: почта или бот не отвечают — одна фраза в рамке блока. */
export function Unavailable({ source }: { readonly source: 'wa' | 'leads' }) {
  return (
    <p className="unavail">
      <b>{source === 'wa' ? 'Бот не отвечает.' : 'Почта не отвечает.'}</b>{' '}
      {source === 'wa' ? 'До привязки WhatsApp на сервере это обычное состояние.' : 'Данные появятся, когда служба почты снова ответит.'}
    </p>
  );
}

export function Skeleton({ width, height = 14 }: { readonly width: number | string; readonly height?: number }) {
  return <span className="skeleton" style={{ width, height }} />;
}
