import type { ManagerNotification } from '../domain/types.js';
import { NOTIFICATION_KIND_LABELS, NOTIFICATION_STATUS_LABELS } from './format.js';
import { cleanText, markup, type SafeHtml } from './html.js';
import { renderLayout } from './layout.js';
import { renderPager, timeTag } from './view-parts.js';

export interface NotificationsPageModel {
  readonly items: readonly ManagerNotification[];
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
  readonly csrf: string;
}

/** Сбой отправки показывает число попыток: по нему видно, повторит ли бот. */
function statusText(item: ManagerNotification): string {
  const label = NOTIFICATION_STATUS_LABELS[item.status];
  return item.status === 'failed' ? `${label}, попыток: ${item.attempts}` : label;
}

function renderRow(item: ManagerNotification): SafeHtml {
  const chat =
    item.chatId === null ? 'нет' : markup`<a href="/chats/${item.chatId}">Чат ${item.chatId}</a>`;
  return markup`<tr>
<td>${timeTag(item.createdAtMs)}</td>
<td>${NOTIFICATION_KIND_LABELS[item.kind]}</td>
<td>${statusText(item)}</td>
<td>${chat}</td>
<td><pre class="note">${cleanText(item.text)}</pre></td>
</tr>`;
}

function renderTable(items: readonly ManagerNotification[]): SafeHtml {
  return markup`<table>
<thead><tr>
<th scope="col">Время</th>
<th scope="col">Вид</th>
<th scope="col">Статус</th>
<th scope="col">Чат</th>
<th scope="col">Текст</th>
</tr></thead>
<tbody>${items.map(renderRow)}</tbody>
</table>`;
}

/**
 * Уведомления менеджеру со статусами: видны и при пустом MANAGER_WHATSAPP, когда на телефон ничего не уходит.
 * Текст уведомления содержит имя клиента и выжимку: выводится экранированным.
 */
export function renderNotificationsPage(model: NotificationsPageModel): string {
  const { items, page, pageCount, total, csrf } = model;
  const emptyText = total === 0 ? 'Уведомлений пока нет' : 'На этой странице уведомлений нет';
  return renderLayout({
    title: 'Уведомления менеджеру',
    nav: { active: 'notifications', csrf },
    body: markup`<h1>Уведомления менеджеру</h1>
${total > 0 ? markup`<p class="muted">Всего уведомлений: ${total}</p>` : null}
${items.length === 0 ? markup`<p class="empty">${emptyText}</p>` : renderTable(items)}
${renderPager({ path: '/notifications', params: {}, page, pageCount })}`,
  });
}
