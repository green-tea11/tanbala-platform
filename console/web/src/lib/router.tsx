import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode, type MouseEvent } from 'react';

// Маршруты панели по адресу (history API): сервер консоли отдаёт index.html на любой GET вне /api.

interface RouterState {
  readonly path: string;
  readonly search: URLSearchParams;
  navigate(to: string): void;
}

const RouterContext = createContext<RouterState | null>(null);

function current(): { path: string; search: URLSearchParams } {
  return { path: window.location.pathname, search: new URLSearchParams(window.location.search) };
}

export function RouterProvider({ children }: { readonly children: ReactNode }) {
  const [location, setLocation] = useState(current);

  useEffect(() => {
    const onPop = (): void => setLocation(current());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    if (to === window.location.pathname + window.location.search) return;
    window.history.pushState(null, '', to);
    setLocation(current());
    window.scrollTo(0, 0);
  }, []);

  const value = useMemo(() => ({ ...location, navigate }), [location, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterState {
  const state = useContext(RouterContext);
  if (state === null) throw new Error('useRouter вне RouterProvider');
  return state;
}

/** Совпадение пути с шаблоном вида /chats/:id; параметры — только цифры. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const names: string[] = [];
  const source = pattern.replace(/:([a-z]+)/g, (_, name: string) => {
    names.push(name);
    return '(\\d{1,12})';
  });
  const match = new RegExp(`^${source}/?$`).exec(path);
  if (!match) return null;
  return Object.fromEntries(names.map((name, index) => [name, match[index + 1] ?? '']));
}

interface LinkProps {
  readonly to: string;
  readonly className?: string;
  readonly children: ReactNode;
  readonly 'aria-current'?: 'page' | undefined;
  readonly 'aria-label'?: string;
}

/** Внутренняя ссылка: обычный <a>, клик без модификаторов — без перезагрузки. */
export function Link({ to, className, children, ...rest }: LinkProps) {
  const { navigate } = useRouter();
  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} className={className} onClick={onClick} {...rest}>
      {children}
    </a>
  );
}
