import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { apiPost, type ApiError } from '../lib/api';
import { useRouter } from '../lib/router';

// Общие части рабочих экранов: фильтры в адресе, страницы, подтверждение листом, итог действия.

/** Параметры фильтров живут в адресе: ссылкой можно поделиться, «назад» возвращает фильтр. */
export function useQueryParams(): { readonly params: URLSearchParams; set(changes: Readonly<Record<string, string | null>>): void } {
  const { path, search, navigate } = useRouter();
  const set = useCallback(
    (changes: Readonly<Record<string, string | null>>) => {
      const next = new URLSearchParams(search);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      if (!('page' in changes)) next.delete('page');
      const query = next.toString();
      navigate(query ? `${path}?${query}` : path);
    },
    [path, search, navigate],
  );
  return { params: search, set };
}

export interface ChipOption {
  readonly code: string;
  readonly label: string;
  readonly count?: number;
}

/** Быстрые фильтры: чипы с числами; выбранный — синий. */
export function Chips({ options, value, onChange, label }: { readonly options: readonly ChipOption[]; readonly value: string; readonly onChange: (code: string) => void; readonly label: string }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.code} type="button" className="chip" aria-pressed={option.code === value} onClick={() => onChange(option.code)}>
          {option.label}
          {option.count !== undefined ? <span className="num">{option.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Select({ label, value, options, onChange }: { readonly label: string; readonly value: string; readonly options: readonly { readonly value: string; readonly label: string }[]; readonly onChange: (value: string) => void }) {
  return (
    <label className="select">
      <span className="visually-hidden">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

/** Строка поиска: применяется по Enter или кнопке, а не на каждую букву (меньше запросов к почте и боту). */
export function SearchBox({ value, placeholder, onSubmit, maxLength }: { readonly value: string; readonly placeholder: string; readonly onSubmit: (value: string) => void; readonly maxLength: number }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <form
      className="searchbox"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(text.trim());
      }}
    >
      <input type="search" value={text} maxLength={maxLength} placeholder={placeholder} aria-label={placeholder} onChange={(event) => setText(event.target.value)} />
      <button type="submit" className="btn">Найти</button>
    </form>
  );
}

export function Pager({ page, pages, total, pageSize, onPage, noun }: { readonly page: number; readonly pages: number; readonly total: number; readonly pageSize: number; readonly onPage: (page: number) => void; readonly noun: string }) {
  if (total === 0) return null;
  const first = Math.min(total, (page - 1) * pageSize + 1);
  const last = Math.min(total, page * pageSize);
  return (
    <nav className="pager" aria-label="Страницы">
      <span className="muted num">{page > pages ? `страница ${page} пуста, всего ${total} ${noun}` : `${first}–${last} из ${total} ${noun}`}</span>
      <div className="pager-buttons">
        <button type="button" className="btn small" disabled={page <= 1} onClick={() => onPage(page - 1)}>Назад</button>
        <span className="num muted">{Math.min(page, Math.max(pages, 1))} / {Math.max(pages, 1)}</span>
        <button type="button" className="btn small" disabled={page >= pages} onClick={() => onPage(page + 1)}>Дальше</button>
      </div>
    </nav>
  );
}

export interface ConfirmRequest {
  readonly title: string;
  readonly body: ReactNode;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly run: () => Promise<void>;
}

/** Подтверждение листом снизу (на ноутбуке — окно по центру). Esc и фон закрывают; фокус на кнопке отмены. */
export function ConfirmSheet({ request, onClose }: { readonly request: ConfirmRequest | null; readonly onClose: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [busy, setBusy] = useState(false);
  // Фокус ставится один раз на открытие листа, а не на каждый опрос родителя.
  useEffect(() => {
    if (request === null) return;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request]);
  if (request === null) return null;
  const confirm = async (): Promise<void> => {
    setBusy(true);
    await request.run();
    setBusy(false);
    onClose();
  };
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="confirm-sheet" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="confirm-title">{request.title}</h2>
        <div className="confirm-body">{request.body}</div>
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="btn" onClick={onClose} disabled={busy}>Отмена</button>
          <button type="button" className={`btn ${request.danger ? 'danger-fill' : 'primary'}`} onClick={() => void confirm()} disabled={busy}>
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface Outcome {
  readonly tone: 'ok' | 'bad';
  readonly text: string;
}

export function OutcomeLine({ outcome }: { readonly outcome: Outcome | null }) {
  if (outcome === null) return null;
  return (
    <p className={`outcome-line ${outcome.tone}`} role={outcome.tone === 'bad' ? 'alert' : 'status'}>
      {outcome.text}
    </p>
  );
}

/** Действие: POST, итог текстом сервера; «итог неизвестен» не повторяется сам. */
export function useAction(): {
  readonly outcome: Outcome | null;
  readonly setOutcome: (outcome: Outcome | null) => void;
  run<T extends { message?: string }>(path: string, body?: Readonly<Record<string, unknown>>): Promise<{ ok: true; data: T } | { ok: false; failure: ApiError }>;
} {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const run = useCallback(async <T extends { message?: string }>(path: string, body: Readonly<Record<string, unknown>> = {}) => {
    const result = await apiPost<T>(path, body);
    if (result.ok) setOutcome({ tone: 'ok', text: result.data.message ?? 'Готово.' });
    else setOutcome({ tone: 'bad', text: result.failure.message });
    return result;
  }, []);
  return { outcome, setOutcome, run };
}

export function PageTitle({ title, sub, actions }: { readonly title: string; readonly sub?: ReactNode; readonly actions?: ReactNode }) {
  return (
    <div className="title-row">
      <div className="title-main">
        <h1>{title}</h1>
        {sub ? <p className="finding">{sub}</p> : null}
      </div>
      {actions ? <div className="title-actions">{actions}</div> : null}
    </div>
  );
}
