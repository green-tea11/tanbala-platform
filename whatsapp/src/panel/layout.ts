import { markup, raw, type SafeHtml } from './html.js';

/** Раздел верхнего меню, который сейчас открыт. */
export type NavSection = 'chats' | 'notifications';

export interface LayoutOptions {
  readonly title: string;
  readonly body: SafeHtml;
  /** Меню и кнопка выхода; только после входа. csrf нужен форме выхода. */
  readonly nav?: { readonly active: NavSection | null; readonly csrf: string };
}

const NAV_LINKS: readonly {
  readonly section: NavSection;
  readonly href: string;
  readonly label: string;
}[] = [
  { section: 'chats', href: '/chats', label: 'Чаты' },
  { section: 'notifications', href: '/notifications', label: 'Уведомления менеджеру' },
];

function renderNav(nav: NonNullable<LayoutOptions['nav']>): SafeHtml {
  const links = NAV_LINKS.map(
    ({ section, href, label }) =>
      markup`<a href="${href}"${nav.active === section ? raw(' aria-current="page"') : null}>${label}</a>`,
  );
  return markup`<header class="top">
<span class="brand">Tanbala</span>
<nav aria-label="Разделы">${links}</nav>
<form method="post" action="/logout"><input type="hidden" name="csrf" value="${nav.csrf}"><button type="submit" class="link">Выйти</button></form>
</header>`;
}

/**
 * Каркас страницы: русский язык, один внешний файл стилей (CSP не пускает inline-стили и скрипты),
 * на клиенте нет JavaScript. Все подстановки экранирует markup``.
 */
export function renderLayout(options: LayoutOptions): string {
  const { title, body, nav } = options;
  return markup`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}: Tanbala</title>
<link rel="stylesheet" href="/panel.css">
</head>
<body>
${nav === undefined ? null : renderNav(nav)}
<main>${body}</main>
</body>
</html>
`.value;
}

/** Страница с одним сообщением (ошибка, отказ) и ссылкой на список чатов. */
export function renderMessagePage(title: string, message: string): string {
  return renderLayout({
    title,
    body: markup`<h1>${title}</h1>
<p>${message}</p>
<p><a href="/chats">К списку чатов</a></p>`,
  });
}
