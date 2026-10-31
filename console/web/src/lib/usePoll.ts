import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, type ApiError } from './api';

// Данные экрана с опросом: только пока вкладка видна; сбой сети — растущая пауза; 403/404 — опрос стоп.

/** Как часто экраны перечитывают данные. Всё, что меняется, обновляется само, без перезагрузки страницы. */
export const POLL_MS = {
  /** Ход идущего поиска: этапы и счётчики. */
  progress: 2_000,
  /** Рабочие экраны: компании, письма, чаты, проверки из WhatsApp, главная. */
  live: 5_000,
  /** Фон: значки меню, уведомления, «Кому писали», состояние системы. */
  background: 15_000,
  /** Меняется редко: расход, журнал действий, пользователи и сессии. */
  rare: 60_000,
} as const;

/** Человек снова вошёл (слой входа поверх экрана): остановленные опросы идут дальше. Шлёт App. */
export const SESSION_RESTORED_EVENT = 'tanbala:session-restored';

export interface PollState<T> {
  readonly data: T | null;
  readonly error: ApiError | null;
  readonly loading: boolean;
  readonly updatedAt: number | null;
  refresh(): void;
}

export interface PollOptions {
  /** Адрес меняется сам, без действия человека (следующее письмо, закончившийся запуск): сессию не продлевать. */
  readonly background?: boolean;
}

const STOP_ERRORS = new Set(['no_session', 'forbidden', 'not_found', 'backend_auth']);
const MAX_BACKOFF_MS = 60_000;
const STALE: ApiError = { status: 200, error: 'unavailable', message: 'Почта или бот не ответили: показаны прежние данные.' };

/**
 * Весь ответ — «почта или бот не ответили» (консоль отдаёт 200 с unavailable): экран целиком заменился бы на «не
 * отвечает», пропали бы набранный текст и прокрутка. Раздел ответа (бот на главной, чаты в карточке компании) так не
 * держится: сбой одной службы виден сразу, а данные другой обновляются как обычно.
 */
function unavailable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { unavailable?: unknown }).unavailable === true;
}

/** path null — читать нечего (данные null). intervalMs 0 — прочитать один раз. */
export function usePoll<T>(path: string | null, intervalMs: number, options: PollOptions = {}): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const timer = useRef<number | null>(null);
  const failures = useRef(0);
  const stopped = useRef(false);
  const generation = useRef(0);
  // Номер последнего запроса: ответ более раннего, пришедший позже, отбрасывается и не ставит свой таймер.
  const request = useRef(0);
  // Последний показанный ответ: тот же ответ данные не подменяет, экран не перерисовывается зря. Прежние данные
  // вместо «не отвечает» — только того же адреса: карточка другой компании под новым адресом не показывается.
  const last = useRef<{ readonly path: string; readonly text: string; readonly value: unknown } | null>(null);
  const shownPath = useRef<string | null>(null);
  const background = useRef(options.background === true);
  background.current = options.background === true;

  const load = useCallback(
    async (poll: boolean) => {
      if (path === null) return;
      const mine = generation.current;
      const seq = ++request.current;
      if (timer.current !== null) window.clearTimeout(timer.current);
      const result = await apiGet<T>(path, poll);
      if (mine !== generation.current || seq !== request.current) return;
      let stale = false;
      if (result.ok) {
        // Прежние данные вместо «не отвечает» — только если прежний ответ того же адреса был настоящим.
        const previous = last.current?.path === path ? last.current : null;
        stale = previous !== null && unavailable(result.data) && !unavailable(previous.value);
        const value = stale && previous !== null ? previous.value : result.data;
        const text = JSON.stringify(value);
        if (text !== last.current?.text) setData(value as T);
        last.current = { path, text, value };
        if (stale) {
          failures.current += 1;
          setError(STALE);
        } else {
          failures.current = 0;
          setError(null);
          setUpdatedAt(Date.now());
        }
      } else {
        failures.current += 1;
        setError(result.failure);
        // Любой 401/403 (в том числе пароль Caddy) — стоп: повторы набрали бы бан fail2ban на весь адрес офиса.
        if (STOP_ERRORS.has(result.failure.error) || result.failure.status === 401 || result.failure.status === 403) stopped.current = true;
      }
      setLoading(false);
      if (stopped.current || intervalMs <= 0 || document.visibilityState !== 'visible') return;
      const delay = result.ok && !stale ? intervalMs : Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** failures.current);
      timer.current = window.setTimeout(() => {
        if (mine === generation.current) void load(true);
      }, delay);
    },
    [path, intervalMs],
  );

  useEffect(() => {
    generation.current += 1;
    stopped.current = false;
    failures.current = 0;
    // Сессию продлевает только первое чтение адреса по действию человека; смена частоты опроса — фоновое чтение.
    const newPath = shownPath.current !== path;
    shownPath.current = path;
    if (newPath) setError(null);
    setLoading(path !== null);
    void load(!newPath || background.current);
    // Вкладку открыли снова или вернулась связь: сразу свежие данные, не дожидаясь паузы.
    const wake = (): void => {
      if (document.visibilityState === 'visible' && !stopped.current && intervalMs > 0) void load(true);
      else if (timer.current !== null) window.clearTimeout(timer.current);
    };
    const restored = (): void => {
      stopped.current = false;
      failures.current = 0;
      void load(false);
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener(SESSION_RESTORED_EVENT, restored);
    return () => {
      generation.current += 1;
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener(SESSION_RESTORED_EVENT, restored);
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [load]);

  const refresh = useCallback(() => {
    stopped.current = false;
    void load(false);
  }, [load]);

  return { data: path === null ? null : data, error, loading, updatedAt, refresh };
}
