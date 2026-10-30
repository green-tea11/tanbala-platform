import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, type ApiError } from './api';

// Данные экрана с опросом: только пока вкладка видна; сбой сети — растущая пауза; 403/404 — опрос стоп.

export interface PollState<T> {
  readonly data: T | null;
  readonly error: ApiError | null;
  readonly loading: boolean;
  readonly updatedAt: number | null;
  refresh(): void;
}

const STOP_ERRORS = new Set(['no_session', 'forbidden', 'not_found', 'backend_auth']);
const MAX_BACKOFF_MS = 60_000;

export function usePoll<T>(path: string, intervalMs: number): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const timer = useRef<number | null>(null);
  const failures = useRef(0);
  const stopped = useRef(false);
  const generation = useRef(0);

  const load = useCallback(
    async (poll: boolean) => {
      const mine = generation.current;
      if (timer.current !== null) window.clearTimeout(timer.current);
      const result = await apiGet<T>(path, poll);
      if (mine !== generation.current) return;
      if (result.ok) {
        failures.current = 0;
        setData(result.data);
        setError(null);
        setUpdatedAt(Date.now());
      } else {
        failures.current += 1;
        setError(result.failure);
        if (STOP_ERRORS.has(result.failure.error)) stopped.current = true;
      }
      setLoading(false);
      if (stopped.current || document.visibilityState !== 'visible') return;
      const delay = result.ok ? intervalMs : Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** failures.current);
      timer.current = window.setTimeout(() => void load(true), delay);
    },
    [path, intervalMs],
  );

  useEffect(() => {
    generation.current += 1;
    stopped.current = false;
    failures.current = 0;
    setLoading(true);
    void load(false);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible' && !stopped.current) void load(true);
      else if (timer.current !== null) window.clearTimeout(timer.current);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      generation.current += 1;
      document.removeEventListener('visibilitychange', onVisible);
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [load]);

  const refresh = useCallback(() => {
    stopped.current = false;
    void load(false);
  }, [load]);

  return { data, error, loading, updatedAt, refresh };
}
