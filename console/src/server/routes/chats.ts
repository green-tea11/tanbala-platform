import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { BackendResult } from '../../backends/result.js';
import type { ListData } from '../../backends/schemas.js';
import type { SessionRecord } from '../../db/sessions.js';
import { BOT_RESULT_MESSAGES, BOT_SEND_FAILED } from '../../domain/messages.js';
import { composeNote } from '../../domain/note.js';
import { buildClientCard } from '../../services/cards.js';
import { normalizeNewlines } from '../../shared/text.js';
import type { AppContext } from '../context.js';
import {
  codeParam,
  flagParam,
  idParam,
  idParams,
  pageParam,
  parseBoth,
  parseInput,
  searchText,
} from '../params.js';
import { sendJson, sendReadFailure, type FailureTexts } from '../respond.js';
import { refuseAction, respondRead, runAction, userRoute } from './define.js';

const CHAT_TEXTS: FailureTexts = { source: 'wa', notFound: 'Чат не найден.' };
/** Предел ответа клиенту в единицах UTF-16, как у бота (WA-40). */
const REPLY_MAX = 4096;
const NOTE_PART_MAX = 2000;
/** Поиск по имени или цифрам номера: бот принимает до 64 символов. */
const SEARCH_MAX = 64;

/** Подписи состояний связи WhatsApp для отказа в ответе. */
const WHATSAPP_STATES: Readonly<Record<string, string>> = {
  connecting: 'подключается',
  closed: 'связь потеряна',
  disabled: 'выключен',
};

const chatsQuery = z.object({
  status: z.enum(['bot', 'manager']).optional(),
  level: z.enum(['cold', 'warm', 'hot']).optional(),
  company: z.enum(['confirmed', 'candidate', 'none']).optional(),
  waiting: flagParam.optional(),
  q: searchText(SEARCH_MAX).optional(),
  page: pageParam.optional(),
});

const messagesQuery = z.object({ before: idParam.optional() });
const chatIdParams = z.object({ chatId: idParam });
const notificationsQuery = z.object({ status: codeParam.optional(), page: pageParam.optional() });
const replyBody = z.object({ text: z.string().max(REPLY_MAX * 2) });
const returnBody = z.object({
  answer: z.string().max(NOTE_PART_MAX).default(''),
  task: z.string().max(NOTE_PART_MAX).default(''),
});

/** Тот же отказ, что у бота (WA-40), но до вызова: пустой или длинный текст боту не отправляется. */
export function replyTextProblem(text: string): string | null {
  const trimmed = normalizeNewlines(text).trim();
  if (trimmed === '') return 'Пустое сообщение не отправляется';
  if (trimmed.length > REPLY_MAX) return `Сообщение длиннее ${REPLY_MAX} символов: сократите его`;
  return null;
}

/** 502 бота при ответе: отправка не удалась — понятный текст, если бот его не дал. */
function withSendFailedText<T>(result: BackendResult<T>): BackendResult<T> {
  if (result.ok || result.failure.kind !== 'rejected' || result.failure.status !== 502) {
    return result;
  }
  return {
    ok: false,
    failure: { ...result.failure, message: result.failure.message ?? BOT_SEND_FAILED },
  };
}

/** Уведомления с отметкой «видел» этого пользователя (по id уведомления). */
function withSeenFlags(context: AppContext, auth: SessionRecord, data: ListData): ListData {
  const ids = data.items.flatMap((item) => (typeof item['id'] === 'number' ? [item['id']] : []));
  const seen = context.seen.seenAmong(auth.userId, 'notification', ids);
  const items = data.items.map((item) => ({
    ...item,
    seen: typeof item['id'] === 'number' && seen.has(item['id']),
  }));
  return { ...data, items };
}

function registerChatReads(app: FastifyInstance, context: AppContext): void {
  const { wa } = context.deps;
  userRoute(app, 'manager', 'GET', '/api/chats', async (request, reply) => {
    const query = parseInput(chatsQuery, request.query, reply);
    return query.ok ? respondRead(reply, wa.chats(query.data), CHAT_TEXTS) : reply;
  });
  userRoute(app, 'manager', 'GET', '/api/chats/:id', async (request, reply) => {
    const params = parseInput(idParams, request.params, reply);
    return params.ok ? respondRead(reply, wa.chat(params.data.id), CHAT_TEXTS) : reply;
  });
  userRoute(app, 'manager', 'GET', '/api/chats/:id/messages', async (request, reply) => {
    const input = parseBoth(reply, [idParams, request.params], [messagesQuery, request.query]);
    if (!input.ok) return reply;
    const [{ id }, { before }] = input.data;
    return respondRead(reply, wa.messages(id, before), CHAT_TEXTS);
  });
  userRoute(app, 'manager', 'GET', '/api/clients/:chatId', async (request, reply) => {
    const params = parseInput(chatIdParams, request.params, reply);
    if (!params.ok) return reply;
    const card = await buildClientCard(context.deps, params.data.chatId);
    return card.ok ? sendJson(reply, card.body) : sendReadFailure(reply, card.failure, CHAT_TEXTS);
  });
  userRoute(app, 'manager', 'GET', '/api/notifications', async (request, reply, auth) => {
    const query = parseInput(notificationsQuery, request.query, reply);
    if (!query.ok) return reply;
    const result = await wa.notifications(query.data);
    return result.ok
      ? sendJson(reply, withSeenFlags(context, auth, result.data))
      : sendReadFailure(reply, result.failure, CHAT_TEXTS);
  });
}

/**
 * Связь WhatsApp не открыта — отказ до вызова бота. Иначе бот сначала передал бы чат менеджеру, а потом не смог
 * отправить (502), и чат остался бы у менеджера с молчащим ботом. Состояние не прочиталось — решает сам бот.
 */
async function whatsappNotOpen(context: AppContext): Promise<string | null> {
  const status = await context.deps.wa.status();
  if (!status.ok || status.data.whatsapp.state === 'open') return null;
  const state = status.data.whatsapp.state;
  return (Object.hasOwn(WHATSAPP_STATES, state) ? WHATSAPP_STATES[state] : undefined) ?? state;
}

function registerReply(app: FastifyInstance, context: AppContext): void {
  const { wa } = context.deps;
  // Ответ клиенту от имени номера: чат переходит к менеджеру, бот в нём замолкает.
  userRoute(app, 'manager', 'POST', '/api/chats/:id/reply', async (request, reply, auth) => {
    const input = parseBoth(reply, [idParams, request.params], [replyBody, request.body]);
    if (!input.ok) return reply;
    const [{ id }, { text }] = input.data;
    const base = { action: 'chat_reply', target: `chat:${id}` };
    const problem = replyTextProblem(text);
    if (problem !== null) {
      return refuseAction(context, request, reply, auth, {
        ...base,
        status: 422,
        code: 'refused',
        message: problem,
      });
    }
    const notOpen = await whatsappNotOpen(context);
    if (notOpen !== null) {
      return refuseAction(context, request, reply, auth, {
        ...base,
        status: 422,
        code: 'refused',
        outcome: 'whatsapp_not_open',
        message: `WhatsApp не подключён (${notOpen}): ответ не отправлен, статус чата не менялся.`,
      });
    }
    return runAction(context, request, reply, auth, {
      ...base,
      texts: CHAT_TEXTS,
      run: async () => withSendFailedText(await wa.reply(id, text, auth.userName)),
      done: (data) => ({
        outcome: data.result,
        body: { result: data.result, message: BOT_RESULT_MESSAGES[data.result] },
      }),
    });
  });
}

function registerReturn(app: FastifyInstance, context: AppContext): void {
  // «Вернуть боту» с полями «Ответ клиенту» и «Задание боту»: консоль склеивает их в одну заметку.
  userRoute(app, 'manager', 'POST', '/api/chats/:id/return', async (request, reply, auth) => {
    const input = parseBoth(reply, [idParams, request.params], [returnBody, request.body]);
    if (!input.ok) return reply;
    const [{ id }, { answer, task }] = input.data;
    const base = { action: 'chat_return', target: `chat:${id}` };
    const note = composeNote(answer, task);
    if (!note.ok) return refuseNote(context, request, reply, auth, base, note);
    return runAction(context, request, reply, auth, {
      ...base,
      texts: CHAT_TEXTS,
      run: () => context.deps.wa.returnToBot(id, note.note, auth.userName),
      done: (data) => ({
        outcome: data.result,
        body: {
          result: data.result,
          message: BOT_RESULT_MESSAGES[data.result],
          ...(data.resumed === undefined ? {} : { resumed: data.resumed }),
        },
      }),
    });
  });
}

function refuseNote(
  context: AppContext,
  request: Parameters<typeof refuseAction>[1],
  reply: FastifyReply,
  auth: SessionRecord,
  base: { readonly action: string; readonly target: string },
  note: { readonly length: number; readonly message: string },
): FastifyReply {
  return refuseAction(context, request, reply, auth, {
    ...base,
    status: 422,
    code: 'refused',
    message: note.message,
    extra: { noteLength: note.length },
  });
}

/** Чаты, переписка, единая карточка клиента, уведомления менеджеру; ответ и «Вернуть боту». */
export function registerChatRoutes(app: FastifyInstance, context: AppContext): void {
  registerChatReads(app, context);
  registerReply(app, context);
  registerReturn(app, context);
}
