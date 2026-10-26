import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Chat } from '../domain/types.js';
import { panelTextProblem } from '../messaging/outbox.js';
import { SafeError } from '../shared/safe-error.js';
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

/** Что менеджер видит, если сбой не из тех, чей текст можно показать: подробности только в логе. */
const SEND_FAILED = 'Не удалось отправить сообщение. Подробности записаны в лог бота.';
const RETURN_FAILED = 'Не удалось вернуть чат боту. Подробности записаны в лог бота.';
const BAD_STATUS = 422;
const BAD_GATEWAY = 502;

/** Браузер шлёт переводы строк формы как CRLF; в WhatsApp уходит LF. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Страница чата с ошибкой над формой и сохранённым текстом ответа. Чат читается заново: передача могла
 * уже пройти, а отправка нет, и менеджер должен видеть настоящий статус.
 */
function failurePage(
  context: PanelContext,
  chat: Chat,
  session: Session,
  failure: { readonly error: string; readonly draft: string },
): string {
  const fresh = context.deps.chats.getById(chat.id) ?? chat;
  return renderChatPage(
    loadChatPage(context, fresh, {
      csrf: session.csrf,
      notice: null,
      error: failure.error,
      draft: failure.draft,
      before: undefined,
    }),
  );
}

/**
 * Ответ от имени номера. Порядок из плана: сначала чат уходит менеджеру (бот в нём замолкает), потом сообщение
 * уходит клиенту. Проверка текста идёт до передачи: пустой или слишком длинный ответ не должен отключать бота.
 * Отказ с понятным текстом (SafeError) показывается как есть, прочие сбои скрыты за общей фразой.
 */
async function handleReply(
  context: PanelContext,
  chat: Chat,
  session: Session,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const text = normalizeNewlines(formField(request.body, 'text') ?? '');
  const problem = panelTextProblem(text);
  if (problem !== null) {
    return sendHtml(
      reply,
      BAD_STATUS,
      failurePage(context, chat, session, { error: problem, draft: text }),
    );
  }
  try {
    await context.deps.handoff.handOff(chat.id, { reason: 'human_took_over', by: 'panel' });
    await context.deps.outbox.sendFromPanel(chat.id, text);
  } catch (error: unknown) {
    return replyFailed(context, chat, session, { error, draft: text }, reply);
  }
  context.audit.info({ action: 'reply', chatId: chat.id }, 'Панель: ответ клиенту отправлен');
  return redirectTo(reply, `/chats/${chat.id}?notice=sent`);
}

function replyFailed(
  context: PanelContext,
  chat: Chat,
  session: Session,
  failure: { readonly error: unknown; readonly draft: string },
  reply: FastifyReply,
): FastifyReply {
  const { error, draft } = failure;
  if (error instanceof SafeError) {
    context.audit.warn(
      { action: 'reply_failed', chatId: chat.id },
      'Панель: ответ не отправлен (отказ)',
    );
    return sendHtml(
      reply,
      BAD_STATUS,
      failurePage(context, chat, session, { error: error.message, draft }),
    );
  }
  context.audit.error(
    { action: 'reply_failed', chatId: chat.id, err: error },
    'Панель: ответ не отправлен (сбой)',
  );
  return sendHtml(
    reply,
    BAD_GATEWAY,
    failurePage(context, chat, session, { error: SEND_FAILED, draft }),
  );
}

/**
 * Возврат чата боту. Чат уже у бота (страница устарела): ничего не вызывается, пометка already_bot.
 * Вернуть чат боту можно только отсюда: сам бот себе чат не возвращает.
 */
async function handleReturn(
  context: PanelContext,
  chat: Chat,
  session: Session,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (chat.control.status === 'bot')
    return redirectTo(reply, `/chats/${chat.id}?notice=already_bot`);
  try {
    await context.deps.handoff.returnToBot(chat.id);
  } catch (error: unknown) {
    context.audit.error(
      { action: 'return_to_bot_failed', chatId: chat.id, err: error },
      'Панель: чат не возвращён боту',
    );
    return sendHtml(
      reply,
      BAD_GATEWAY,
      failurePage(context, chat, session, { error: RETURN_FAILED, draft: '' }),
    );
  }
  context.audit.info({ action: 'return_to_bot', chatId: chat.id }, 'Панель: чат возвращён боту');
  return redirectTo(reply, `/chats/${chat.id}?notice=returned`);
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
      return chat === null ? chatNotFound(reply) : handleReturn(context, chat, session, reply);
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
        before: parseBeforeId(request.query),
      });
      return sendHtml(reply, 200, renderChatPage(model));
    }),
  );

  registerChatActionRoutes(app, context);
}
