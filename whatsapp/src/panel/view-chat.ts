import { has1CText } from '../agent/profile.js';
import type { CompanySummary } from '../domain/company.js';
import { PANEL_TEXT_MAX_LENGTH } from '../messaging/outbox.js';
import type {
  Chat,
  ClientProfile,
  ManagerNotification,
  MessageKind,
  OpenHandoff,
  StoredMessage,
} from '../domain/types.js';
import {
  AUTHOR_LABELS,
  controlLabel,
  HANDOFF_REASON_LABELS,
  LEVEL_LABELS,
  NOTIFICATION_KIND_LABELS,
  NOTIFICATION_STATUS_LABELS,
  nameLabel,
  phoneLabel,
} from './format.js';
import { cleanText, markup, type SafeHtml } from './html.js';
import { renderLayout } from './layout.js';
import type { NoticeKey } from './params.js';
import { renderCompanySection } from './view-company.js';
import { timeTag } from './view-parts.js';

export interface ChatPageModel {
  readonly chat: Chat;
  /** Показанные сообщения по возрастанию времени. */
  readonly messages: readonly StoredMessage[];
  /** ID первого показанного сообщения, если раньше есть ещё (ссылка «Показать раньше»); иначе null. */
  readonly earlierBefore: number | null;
  /** Открыт срез «раньше»: нужна ссылка к последним сообщениям. */
  readonly isEarlierSlice: boolean;
  readonly openHandoff: OpenHandoff | null;
  readonly lastNotification: ManagerNotification | null;
  /** Что известно о компании клиента; null: сводку прочитать не удалось. */
  readonly company: CompanySummary | null;
  readonly csrf: string;
  readonly notice: NoticeKey | null;
  /** Причина отказа действия над формой ответа; null, если ошибки нет. */
  readonly error: string | null;
  /** Текст, который менеджер набрал в форме ответа: после сбоя он остаётся на месте. */
  readonly draft: string;
}

const NOT_KNOWN = 'не выяснили';

const NOTICE_TEXTS: Readonly<Record<NoticeKey, string>> = {
  sent: 'Сообщение отправлено клиенту',
  returned: 'Чат возвращён боту',
  already_bot: 'Чат уже ведёт бот',
  duplicate: 'Это сообщение уже отправлено',
};

/** Что показать вместо текста, которого нет (голосовое до расшифровки, вложение). */
const PLACEHOLDERS: Readonly<Record<MessageKind, string>> = {
  text: '[пустое сообщение]',
  voice: '[голосовое сообщение, расшифровки нет]',
  other: '[сообщение другого вида]',
};

interface ProfileField {
  readonly label: string;
  readonly value: (profile: ClientProfile) => string | null;
}

const PROFILE_FIELDS: readonly ProfileField[] = [
  { label: 'Бизнес', value: (profile) => profile.business },
  { label: 'Площадь', value: (profile) => profile.area },
  { label: 'Что учитывать', value: (profile) => profile.scope },
  { label: 'Число вещей', value: (profile) => profile.itemCount },
  { label: '1С', value: (profile) => has1CText(profile.has1C, profile.oneCName) },
  { label: 'Задача', value: (profile) => profile.problem },
  { label: 'Особенности', value: (profile) => profile.specifics },
  {
    label: 'Согласие, что трудность есть',
    value: (profile) => (profile.problemAgreed ? 'да' : null),
  },
];

function profileRow(field: ProfileField, profile: ClientProfile): SafeHtml {
  const value = field.value(profile);
  const text = value === null ? '' : cleanText(value).trim();
  return markup`<dt>${field.label}</dt><dd>${text === '' ? NOT_KNOWN : text}</dd>`;
}

function renderHandoff(handoff: OpenHandoff | null): SafeHtml {
  if (handoff === null) return markup`нет`;
  return markup`${HANDOFF_REASON_LABELS[handoff.reason]}, уровень ${LEVEL_LABELS[handoff.level]}, с ${timeTag(handoff.openedAtMs)}`;
}

function renderLastNotification(item: ManagerNotification | null): SafeHtml {
  if (item === null) return markup`нет`;
  return markup`${NOTIFICATION_KIND_LABELS[item.kind]}, ${NOTIFICATION_STATUS_LABELS[item.status]}, ${timeTag(item.createdAtMs)}
<pre class="note">${cleanText(item.text)}</pre>`;
}

function renderCard(model: ChatPageModel): SafeHtml {
  const { chat } = model;
  return markup`<section class="card" aria-labelledby="card-title">
<h2 id="card-title">Карточка клиента</h2>
<dl class="facts">
<dt>Статус</dt><dd>${controlLabel(chat.control)}</dd>
<dt>Уровень интереса</dt><dd><span class="badge level-${chat.level}">${LEVEL_LABELS[chat.level]}</span></dd>
${PROFILE_FIELDS.map((field) => profileRow(field, chat.profile))}
<dt>Открытая передача</dt><dd>${renderHandoff(model.openHandoff)}</dd>
<dt>Последнее уведомление менеджеру</dt><dd>${renderLastNotification(model.lastNotification)}</dd>
</dl>
</section>`;
}

/** Текст сообщения для вывода: без скрытых символов; пустой заменяется пояснением по виду сообщения. */
function messageText(message: StoredMessage): string {
  const text = message.text === null ? '' : cleanText(message.text);
  return text.trim() === '' ? PLACEHOLDERS[message.kind] : text;
}

function renderMessage(message: StoredMessage): SafeHtml {
  return markup`<li class="msg msg-${message.author}">
<div class="meta"><span class="author">${AUTHOR_LABELS[message.author]}</span> ${timeTag(message.tsMs)}</div>
<div class="text">${messageText(message)}</div>
</li>`;
}

function renderHistory(model: ChatPageModel): SafeHtml {
  const { chat, messages, earlierBefore, isEarlierSlice } = model;
  return markup`<section aria-labelledby="history-title">
<h2 id="history-title">Переписка</h2>
${earlierBefore === null ? null : markup`<p><a href="/chats/${chat.id}?before=${earlierBefore}">Показать раньше</a></p>`}
${messages.length === 0 ? markup`<p class="empty">Сообщений пока нет</p>` : markup`<ol class="messages">${messages.map(renderMessage)}</ol>`}
${isEarlierSlice ? markup`<p><a href="/chats/${chat.id}">К последним сообщениям</a></p>` : null}
</section>`;
}

function csrfField(csrf: string): SafeHtml {
  return markup`<input type="hidden" name="csrf" value="${csrf}">`;
}

function renderReplyForm(model: ChatPageModel): SafeHtml {
  const { chat, csrf, draft } = model;
  const hint =
    chat.control.status === 'manager'
      ? 'Чат ведёт менеджер, бот в нём молчит.'
      : 'Если вы ответите, чат перейдёт к менеджеру, бот в нём замолчит.';
  return markup`<section aria-labelledby="reply-title">
<h2 id="reply-title">Ответ от имени номера</h2>
<form method="post" action="/chats/${chat.id}/reply">
${csrfField(csrf)}
<label for="reply-text">Сообщение клиенту</label>
<textarea id="reply-text" name="text" maxlength="${PANEL_TEXT_MAX_LENGTH}" rows="5" required>
${draft}</textarea>
<p class="muted">${hint}</p>
<button type="submit">Отправить</button>
</form>
</section>`;
}

function renderReturnForm(model: ChatPageModel): SafeHtml {
  const { chat, csrf } = model;
  if (chat.control.status !== 'manager') return markup``;
  return markup`<section aria-labelledby="return-title">
<h2 id="return-title">Вернуть чат боту</h2>
<form method="post" action="/chats/${chat.id}/return">
${csrfField(csrf)}
<button type="submit" class="secondary">Вернуть боту</button>
</form>
</section>`;
}

/**
 * Страница чата: карточка клиента, раздел «Компания», переписка (кусок из HISTORY_PAGE_SIZE сообщений с «Показать
 * раньше»), форма ответа и кнопка «Вернуть боту». Всё, что пришло из WhatsApp и почтового проекта (имя, тексты,
 * выжимка, данные о компании), экранирует markup``.
 */
export function renderChatPage(model: ChatPageModel): string {
  const { chat, notice, error, csrf } = model;
  return renderLayout({
    title: nameLabel(chat.pushName),
    nav: { active: 'chats', csrf },
    body: markup`<p><a href="/chats">К списку чатов</a></p>
<h1>${nameLabel(chat.pushName)}</h1>
<p class="muted">${phoneLabel(chat.identity)}</p>
${notice === null ? null : markup`<p class="notice" role="status">${NOTICE_TEXTS[notice]}</p>`}
${error === null ? null : markup`<p class="alert" role="alert">${error}</p>`}
${renderCard(model)}
${renderCompanySection(model.company)}
${renderHistory(model)}
${renderReplyForm(model)}
${renderReturnForm(model)}`,
  });
}
