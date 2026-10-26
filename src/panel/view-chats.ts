import type { ChatStatus, PanelChatRow } from '../domain/types.js';
import { HANDOFF_REASON_LABELS, LEVEL_LABELS, nameLabel, phoneLabel } from './format.js';
import { markup, raw, type SafeHtml } from './html.js';
import { renderLayout } from './layout.js';
import { listUrl, renderPager, timeTag } from './view-parts.js';

export interface ChatsPageModel {
  readonly rows: readonly PanelChatRow[];
  readonly status: ChatStatus | undefined;
  readonly page: number;
  readonly pageCount: number;
  /** Сколько чатов в списке с этим фильтром. */
  readonly total: number;
  readonly csrf: string;
}

const FILTERS: readonly { readonly status: ChatStatus | undefined; readonly label: string }[] = [
  { status: undefined, label: 'Все' },
  { status: 'bot', label: 'Ведёт бот' },
  { status: 'manager', label: 'Ведёт менеджер' },
];

const STATUS_BADGES: Readonly<Record<ChatStatus, string>> = { bot: 'Бот', manager: 'Менеджер' };

function filterParams(status: ChatStatus | undefined): Readonly<Record<string, string>> {
  return status === undefined ? {} : { status };
}

function renderFilters(current: ChatStatus | undefined): SafeHtml {
  const links = FILTERS.map(
    ({ status, label }) =>
      markup`<a href="${listUrl('/chats', filterParams(status), 1)}"${status === current ? raw(' aria-current="page"') : null}>${label}</a>`,
  );
  return markup`<nav class="filters" aria-label="Фильтр по статусу">${links}</nav>`;
}

function renderRow({ chat, lastMessageAtMs, openHandoff }: PanelChatRow): SafeHtml {
  return markup`<tr>
<td><a href="/chats/${chat.id}">${nameLabel(chat.pushName)}</a><div class="muted">${phoneLabel(chat.identity)}</div></td>
<td><span class="badge status-${chat.control.status}">${STATUS_BADGES[chat.control.status]}</span></td>
<td><span class="badge level-${chat.level}">${LEVEL_LABELS[chat.level]}</span></td>
<td>${lastMessageAtMs === null ? 'нет сообщений' : timeTag(lastMessageAtMs)}</td>
<td>${openHandoff === null ? null : HANDOFF_REASON_LABELS[openHandoff.reason]}</td>
</tr>`;
}

function renderTable(rows: readonly PanelChatRow[]): SafeHtml {
  return markup`<table>
<thead><tr>
<th scope="col">Клиент</th>
<th scope="col">Статус</th>
<th scope="col">Уровень</th>
<th scope="col">Последнее сообщение</th>
<th scope="col">Передача менеджеру</th>
</tr></thead>
<tbody>${rows.map(renderRow)}</tbody>
</table>`;
}

/** Список чатов: фильтр по статусу, таблица, страницы. Имена из WhatsApp экранирует markup``. */
export function renderChatsPage(model: ChatsPageModel): string {
  const { rows, status, page, pageCount, total, csrf } = model;
  const emptyText = total === 0 ? 'Чатов пока нет' : 'На этой странице чатов нет';
  return renderLayout({
    title: 'Чаты',
    nav: { active: 'chats', csrf },
    body: markup`<h1>Чаты</h1>
${renderFilters(status)}
${total > 0 ? markup`<p class="muted">Всего чатов: ${total}</p>` : null}
${rows.length === 0 ? markup`<p class="empty">${emptyText}</p>` : renderTable(rows)}
${renderPager({ path: '/chats', params: filterParams(status), page, pageCount })}`,
  });
}
