import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CompanySummary } from '../domain/company.js';
import type { Chat, ChatId } from '../domain/types.js';
import { panelTextProblem } from '../messaging/outbox.js';
import {
  normalizeNewlines,
  replyToClient,
  returnChatById,
  type ChatActionContext,
  type ChatNotFound,
  type ReplyOutcome,
  type ReturnOutcome,
} from './chat-actions.js';
import { REJECTED_DRAFTS_SHOWN } from './chat-model.js';
import type { ConsoleContext } from './console-context.js';
import {
  bodyString,
  consoleUserOf,
  ConsoleHttpError,
  notFound,
  sendError,
  sendJson,
} from './console-http.js';
import {
  chatRowJson,
  calcJson,
  cleanOrNull,
  companyJson,
  controlJson,
  handoffHistoryJson,
  isoOrNull,
  messageJson,
  nameOf,
  noteJson,
  notificationJson,
  openHandoffJson,
  phoneOf,
  profileFieldsJson,
  rejectedJson,
  toldFactsJson,
} from './console-json.js';
import { parseBefore, parseChatFilter, parseConsolePage } from './console-params.js';
import { pageJson, PREFIX } from './console-routes-status.js';
import { LEVEL_LABELS } from './format.js';
import { HISTORY_PAGE_SIZE, LIST_PAGE_SIZE, parseChatId } from './params.js';

/** Сколько передач из истории чата отдаёт карточка. */
export const HANDOFF_HISTORY_LIMIT = 100;
const CHAT_NOT_FOUND = 'Чата с таким номером нет: он удалён слиянием или ссылка неверна.';
const ALREADY_BOT = 'Чат уже ведёт бот: заметка не сохранена.';
/** Ответ не ушёл после передачи чата: бот в нём уже молчит. Дописывается и к отказу отправки после передачи. */
const AT_MANAGER_NOTE = 'Чат уже у менеджера, бот в нём молчит.';
/** Сбой отправки после передачи чата (контракт). */
const SEND_FAILED_AT_MANAGER = `Не отправлено. ${AT_MANAGER_NOTE}`;
/** Ответ не ушёл, а передача не прошла: статус чата прежний. */
const SEND_FAILED_UNCHANGED = 'Не отправлено. Статус чата не менялся.';

/** Ответ из консоли упёрся в предел ответов за час (panel/console-reply-limit.ts). */
interface RateLimited {
  readonly kind: 'rate_limited';
  readonly message: string;
}

const NOT_FOUND: ChatNotFound = { kind: 'not_found' };

interface ChatRoute {
  Params: { id: string };
}

/** ID чата из адреса: неверный формат => 404 до базы. */
function chatIdOf(request: FastifyRequest<ChatRoute>): ChatId {
  const chatId = parseChatId(request.params.id);
  if (chatId === null) throw notFound(CHAT_NOT_FOUND);
  return chatId;
}

/** Чат по ID из адреса; нет => 404. */
function chatOf(context: ConsoleContext, request: FastifyRequest<ChatRoute>): Chat {
  const chat = context.deps.chats.getById(chatIdOf(request));
  if (chat === null) throw notFound(CHAT_NOT_FOUND);
  return chat;
}

/** Переписка: HISTORY_PAGE_SIZE сообщений строго раньше before (без него последние), старые сверху. */
function historyJson(
  context: ConsoleContext,
  chatId: ChatId,
  before: number | undefined,
): Record<string, unknown> {
  const limit = HISTORY_PAGE_SIZE + 1;
  const fetched = context.deps.messages.history(
    chatId,
    before === undefined ? { limit } : { limit, beforeId: before },
  );
  const hasEarlier = fetched.length > HISTORY_PAGE_SIZE;
  const shown = hasEarlier ? fetched.slice(fetched.length - HISTORY_PAGE_SIZE) : fetched;
  return {
    items: shown.map(messageJson),
    earlierBefore: hasEarlier ? (shown[0]?.id ?? null) : null,
  };
}

/**
 * Сводка о компании. Сбой чтения карточку не закрывает: state not_read, в журнал ID чата и имя ошибки, как у старой
 * панели (panel/chat-model.ts).
 */
function companySummaryOf(context: ConsoleContext, chatId: ChatId): CompanySummary | null {
  try {
    return context.deps.company.summary(chatId);
  } catch (error: unknown) {
    context.audit.warn(
      {
        action: 'company_summary_failed',
        chatId,
        errorName: error instanceof Error ? error.name : typeof error,
      },
      'API консоли: сводка о компании не прочитана',
    );
    return null;
  }
}

/**
 * Карточка чата: всё, что показывает старая карточка, плюс история передач, время смены статуса и ход разговора;
 * рассказанные клиенту сильные стороны (chat.toldFacts) и что для расчёта известно и чего не хватает (profile.calc).
 * Причина оценки (levelReason) с 30.10.2026 при передаче чата ботом: причина передачи своими словами с цитатой клиента.
 */
function chatCardJson(context: ConsoleContext, chat: Chat): Record<string, unknown> {
  const { chats, reads, handoffs, notifications, rejectedDrafts } = context.deps;
  const meta = reads.chatMeta(chat.id);
  const progress = chats.getProgress(chat.id);
  const profileMeta = reads.profileMeta(chat.id);
  const phone = phoneOf(chat.identity.pnJid);
  const lastNotification = notifications.latestForChat(chat.id);
  return {
    chat: {
      id: chat.id,
      name: nameOf(chat.pushName),
      phone,
      phoneHidden: phone === null,
      ...controlJson(chat.control),
      statusChangedAt: isoOrNull(meta?.statusChangedAtMs),
      level: chat.level,
      levelLabel: LEVEL_LABELS[chat.level],
      createdAt: isoOrNull(meta?.createdAtMs),
      priceAsks: progress.priceAsks,
      refusedAnswers: progress.refused,
      handedOff: progress.handedOff === true,
      toldFacts: toldFactsJson(progress.toldFacts ?? []),
    },
    profile: {
      fields: profileFieldsJson(chat.profile),
      calc: calcJson(chat.profile),
      problemAgreed: chat.profile.problemAgreed,
      levelReason: cleanOrNull(profileMeta?.reason ?? null),
      updatedAt: isoOrNull(profileMeta?.updatedAtMs),
    },
    note: noteJson(chats.getNote(chat.id)),
    openHandoff: openHandoffJson(handoffs.findOpen(chat.id)),
    handoffs: reads.handoffHistory(chat.id, HANDOFF_HISTORY_LIMIT).map(handoffHistoryJson),
    lastNotification: lastNotification === null ? null : notificationJson(lastNotification),
    company: companyJson(companySummaryOf(context, chat.id)),
    rejected: {
      items: rejectedDrafts.listForChat(chat.id, REJECTED_DRAFTS_SHOWN).map(rejectedJson),
      total: reads.countRejected(chat.id),
    },
    messages: historyJson(context, chat.id, undefined),
  };
}

/** Контекст действия: общие с панелью зависимости и память ответов, в журнале ещё имя пользователя консоли. */
function actionContextOf(context: ConsoleContext, request: FastifyRequest): ChatActionContext {
  return {
    deps: context.deps,
    recentReplies: context.deps.recentReplies,
    audit: context.audit.child({ user: consoleUserOf(request) ?? 'unknown' }),
  };
}

function refused(message: string): ConsoleHttpError {
  return new ConsoleHttpError(422, 'refused', message);
}

/** Текст отказа и ещё одно предложение: точка в конце первого ставится, если её нет. */
function withSentence(message: string, sentence: string): string {
  const trimmed = message.trimEnd();
  return /[.!?…]$/.test(trimmed) ? `${trimmed} ${sentence}` : `${trimmed}. ${sentence}`;
}

/**
 * Ответ клиенту из консоли: чат есть (иначе not_found), предел ответов из консоли не исчерпан (иначе rate_limited, ничего
 * не вызывается), затем общая с кнопкой старой панели логика replyToClient. Место в пределе занимается до отправки и
 * освобождается, если ответ не ушёл (отказ, сбой, дубль): считаются только отправленные.
 */
async function replyFromConsole(
  context: ConsoleContext,
  actions: ChatActionContext,
  chatId: ChatId,
  text: string,
): Promise<ReplyOutcome | ChatNotFound | RateLimited> {
  const chat = context.deps.chats.getById(chatId);
  if (chat === null) return NOT_FOUND;
  const place = context.replyLimit.take(chatId);
  if (place.kind === 'limited') return { kind: 'rate_limited', message: place.message };
  const outcome = await replyToClient(actions, chat, text);
  if (outcome.kind !== 'sent') place.slot.release();
  return outcome;
}

/**
 * Итог ответа клиенту в JSON. Отказы, которые общая логика не пишет в журнал (текст ответа, нет чата), получают
 * свою строку: действие, пользователь и ID чата, без текста.
 */
function sendReplyOutcome(
  context: ConsoleContext,
  actions: ChatActionContext,
  reply: FastifyReply,
  request: { readonly chatId: ChatId; readonly text: string },
  outcome: ReplyOutcome | ChatNotFound | RateLimited,
): FastifyReply {
  const { chatId, text } = request;
  switch (outcome.kind) {
    case 'sent':
    case 'duplicate':
      return sendJson(reply, 200, { result: outcome.kind });
    case 'refused':
      if (panelTextProblem(normalizeNewlines(text)) !== null) {
        actions.audit.info({ action: 'reply_refused', chatId }, 'API консоли: ответ не принят');
      }
      return sendError(
        reply,
        refused(
          outcome.afterHandoff ? withSentence(outcome.message, AT_MANAGER_NOTE) : outcome.message,
        ),
      );
    case 'rate_limited':
      actions.audit.warn(
        { action: 'reply_rate_limited', chatId },
        'API консоли: предел ответов из консоли за час',
      );
      return sendError(reply, new ConsoleHttpError(429, 'rate_limited', outcome.message));
    case 'failed': {
      const atManager = context.deps.chats.getById(chatId)?.control.status === 'manager';
      const message = atManager ? SEND_FAILED_AT_MANAGER : SEND_FAILED_UNCHANGED;
      return sendError(reply, new ConsoleHttpError(502, 'send_failed', message));
    }
    case 'not_found':
      actions.audit.info({ action: 'chat_not_found', chatId }, 'API консоли: чата нет');
      return sendError(reply, notFound(CHAT_NOT_FOUND));
  }
}

/** Итог возврата боту в JSON; отказы без строки в общей логике получают свою строку журнала. */
function sendReturnOutcome(
  actions: ChatActionContext,
  reply: FastifyReply,
  chatId: ChatId,
  outcome: ReturnOutcome | ChatNotFound,
): FastifyReply {
  switch (outcome.kind) {
    case 'returned':
    case 'returned_answering':
      return sendJson(reply, 200, { result: outcome.kind, resumed: outcome.resumed });
    case 'already_bot':
      actions.audit.info({ action: 'return_already_bot', chatId }, 'API консоли: чат уже у бота');
      return sendJson(reply, 200, { result: 'already_bot', message: ALREADY_BOT });
    case 'note_too_long':
      actions.audit.info({ action: 'return_refused', chatId }, 'API консоли: заметка не принята');
      return sendError(reply, refused(outcome.message));
    case 'failed':
      return sendError(reply, new ConsoleHttpError(502, 'return_failed', outcome.message));
    case 'not_found':
      actions.audit.info({ action: 'chat_not_found', chatId }, 'API консоли: чата нет');
      return sendError(reply, notFound(CHAT_NOT_FOUND));
  }
}

/** Ответ клиенту и возврат боту: та же логика и тот же порядок, что у кнопок старой панели (panel/chat-actions.ts). */
function registerActionRoutes(app: FastifyInstance, context: ConsoleContext): void {
  app.post<ChatRoute>(`${PREFIX}/chats/:id/reply`, async (request, reply) => {
    const chatId = chatIdOf(request);
    const text = bodyString(request.body, 'text');
    const actions = actionContextOf(context, request);
    const outcome = await replyFromConsole(context, actions, chatId, text);
    return sendReplyOutcome(context, actions, reply, { chatId, text }, outcome);
  });
  app.post<ChatRoute>(`${PREFIX}/chats/:id/return`, async (request, reply) => {
    const chatId = chatIdOf(request);
    const note = bodyString(request.body, 'note', '');
    const actions = actionContextOf(context, request);
    const outcome = await returnChatById(actions, chatId, note);
    return sendReturnOutcome(actions, reply, chatId, outcome);
  });
}

/** Список чатов, карточка, переписка, ответ клиенту и возврат боту. */
export function registerConsoleChatRoutes(app: FastifyInstance, context: ConsoleContext): void {
  app.get(`${PREFIX}/chats`, (request, reply) => {
    const { reads, clock } = context.deps;
    const filter = parseChatFilter(request.query, clock.now());
    const page = parseConsolePage(request.query);
    // Число и страница одной транзакцией чтения: total совпадает со страницей.
    const { total, rows } = reads.readTransaction(() => ({
      total: reads.countChats(filter),
      rows: reads.listChats(filter, {
        limit: LIST_PAGE_SIZE,
        offset: (page - 1) * LIST_PAGE_SIZE,
      }),
    }));
    return sendJson(reply, 200, pageJson(rows.map(chatRowJson), total, page, LIST_PAGE_SIZE));
  });
  app.get<ChatRoute>(`${PREFIX}/chats/:id`, (request, reply) =>
    sendJson(reply, 200, chatCardJson(context, chatOf(context, request))),
  );
  app.get<ChatRoute>(`${PREFIX}/chats/:id/messages`, (request, reply) => {
    chatIdOf(request);
    const before = parseBefore(request.query);
    const chat = chatOf(context, request);
    return sendJson(reply, 200, historyJson(context, chat.id, before));
  });
  registerActionRoutes(app, context);
}
