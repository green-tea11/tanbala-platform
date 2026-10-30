import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Chat } from '../domain/types.js';
import { normalizeNewlines, replyToClient, returnChatToBot } from './chat-actions.js';
import { loadChatPage } from './chat-model.js';
import { redirectTo, sendHtml, withSession, type PanelContext } from './context.js';
import { formField } from './http.js';
import { renderMessagePage } from './layout.js';
import {
  LIST_PAGE_SIZE,
  parseBeforeId,
  parseChatId,
  parseNotice,
  parsePage,
  parseStatusFilter,
} from './params.js';
import type { Session } from './sessions.js';
import { renderChatPage } from './view-chat.js';
import { renderChatsPage } from './view-chats.js';
import { pageCountOf } from './view-parts.js';

/** Чат по части адреса /chats/:id; неверный адрес и неизвестный чат дают null (до базы доходит только верный ID). */
function findChat(context: PanelContext, rawId: unknown): Chat | null {
  const chatId = parseChatId(rawId);
  return chatId === null ? null : context.deps.chats.getById(chatId);
}

/** Ответ 404 для чата, которого нет. */
function chatNotFound(reply: FastifyReply): FastifyReply {
  return sendHtml(
    reply,
    404,
    renderMessagePage('Чат не найден', 'Чата с таким номером в панели нет.'),
  );
}

const BAD_STATUS = 422;
const BAD_GATEWAY = 502;

/**
 * Страница чата с ошибкой над формой и сохранённым текстом ответа. Чат читается заново: передача могла
 * уже пройти, а отправка нет, и менеджер должен видеть настоящий статус.
 */
function failurePage(
  context: PanelContext,
  chat: Chat,
  session: Session,
  failure: { readonly error: string; readonly draft: string; readonly noteDraft?: string },
): string {
  const fresh = context.deps.chats.getById(chat.id) ?? chat;
  return renderChatPage(
    loadChatPage(context, fresh, {
      csrf: session.csrf,
      notice: null,
      error: failure.error,
      draft: failure.draft,
      noteDraft: failure.noteDraft ?? '',
      before: undefined,
    }),
  );
}

/**
 * Ответ от имени номера (логика и порядок вызовов в panel/chat-actions.replyToClient, общей с консолью). Отказ
 * с понятным текстом: 422 и страница чата с ошибкой и набранным текстом; сбой: 502 с общей фразой; повтор той же
 * формы: пометка duplicate; успех: пометка sent.
 */
async function handleReply(
  context: PanelContext,
  chat: Chat,
  session: Session,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const text = normalizeNewlines(formField(request.body, 'text') ?? '');
  const outcome = await replyToClient(context, chat, text);
  switch (outcome.kind) {
    case 'sent':
    case 'duplicate':
      return redirectTo(reply, `/chats/${chat.id}?notice=${outcome.kind}`);
    case 'refused':
      return sendHtml(
        reply,
        BAD_STATUS,
        failurePage(context, chat, session, { error: outcome.message, draft: text }),
      );
    case 'failed':
      return sendHtml(
        reply,
        BAD_GATEWAY,
        failurePage(context, chat, session, { error: outcome.message, draft: text }),
      );
  }
}

/**
 * Возврат чата боту (логика и порядок в panel/chat-actions.returnChatToBot, общей с консолью). Чат уже у бота:
 * пометка already_bot. Заметка длиннее предела: 422, чат остаётся у менеджера, набранный текст в форме. Сбой
 * возврата: 502. Успех: пометка returned или returned_answering (бот ответит на неотвеченное).
 */
async function handleReturn(
  context: PanelContext,
  chat: Chat,
  session: Session,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const typed = normalizeNewlines(formField(request.body, 'note') ?? '');
  const outcome = await returnChatToBot(context, chat, typed);
  switch (outcome.kind) {
    case 'already_bot':
    case 'returned':
    case 'returned_answering':
      return redirectTo(reply, `/chats/${chat.id}?notice=${outcome.kind}`);
    case 'note_too_long': {
      const page = failurePage(context, chat, session, {
        error: outcome.message,
        draft: '',
        noteDraft: typed,
      });
      return sendHtml(reply, BAD_STATUS, page);
    }
    case 'failed':
      return sendHtml(
        reply,
        BAD_GATEWAY,
        failurePage(context, chat, session, { error: outcome.message, draft: '' }),
      );
  }
}

/** Параметры маршрутов /chats/:id. */
interface ChatRoute {
  Params: { id: string };
}

/** Действия над чатом: только POST (токен CSRF и Origin проверены хуками), только в существующем чате. */
function registerChatActionRoutes(app: FastifyInstance, context: PanelContext): void {
  app.post<ChatRoute>(
    '/chats/:id/reply',
    withSession<ChatRoute>(context, (request, reply, session) => {
      const chat = findChat(context, request.params.id);
      return chat === null
        ? chatNotFound(reply)
        : handleReply(context, chat, session, request, reply);
    }),
  );
  app.post<ChatRoute>(
    '/chats/:id/return',
    withSession<ChatRoute>(context, (request, reply, session) => {
      const chat = findChat(context, request.params.id);
      return chat === null
        ? chatNotFound(reply)
        : handleReturn(context, chat, session, request, reply);
    }),
  );
}

/** Список чатов, страница чата, ответ клиенту и возврат боту. */
export function registerChatRoutes(app: FastifyInstance, context: PanelContext): void {
  app.get(
    '/chats',
    withSession(context, (request, reply, session) => {
      const status = parseStatusFilter(request.query);
      const page = parsePage(request.query);
      const filter = status === undefined ? {} : { status };
      const { chats } = context.deps;
      const total = chats.countForPanel(filter);
      const rows = chats.listForPanel({
        ...filter,
        limit: LIST_PAGE_SIZE,
        offset: (page - 1) * LIST_PAGE_SIZE,
      });
      const pageCount = pageCountOf(total, LIST_PAGE_SIZE);
      return sendHtml(
        reply,
        200,
        renderChatsPage({ rows, status, page, pageCount, total, csrf: session.csrf }),
      );
    }),
  );

  app.get<ChatRoute>(
    '/chats/:id',
    withSession<ChatRoute>(context, (request, reply, session) => {
      const chat = findChat(context, request.params.id);
      if (chat === null) return chatNotFound(reply);
      const model = loadChatPage(context, chat, {
        csrf: session.csrf,
        notice: parseNotice(request.query),
        error: null,
        draft: '',
        noteDraft: '',
        before: parseBeforeId(request.query),
      });
      return sendHtml(reply, 200, renderChatPage(model));
    }),
  );

  registerChatActionRoutes(app, context);
}
