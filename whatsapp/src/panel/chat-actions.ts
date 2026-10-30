import type { ChatsRepo, Logger } from '../domain/ports.js';
import type { Chat, ChatId } from '../domain/types.js';
import { botNoteProblem, cleanBotNote } from '../handoff/bot-note.js';
import type { HandoffService } from '../handoff/handoff.js';
import { panelTextProblem, type Outbox } from '../messaging/outbox.js';
import { SafeError } from '../shared/safe-error.js';
import type { RecentReplies } from './recent-replies.js';

// Действия над чатом из старой панели (HTML-формы) и из внутреннего API консоли (JSON): одна логика и один порядок
// вызовов. Маршруты только переводят итог в свой ответ.

/** Что менеджер видит, если сбой не из тех, чей текст можно показать: подробности только в логе. */
export const SEND_FAILED = 'Не удалось отправить сообщение. Подробности записаны в лог бота.';
export const RETURN_FAILED = 'Не удалось вернуть чат боту. Подробности записаны в лог бота.';
/** Чат закрыт для ответа из панели: закрытый режим или WhatsApp не подключён (outbox.canSendFromPanel вернул false). */
export const CHAT_CLOSED_FOR_REPLY =
  'Ответ не отправлен, статус чата не менялся: чат не из TEST_ALLOWLIST (закрытый режим) или WhatsApp не подключён.';

/** Что действиям нужно от приложения: те же outbox, сервис передачи и ответ бота после возврата, что у панели. */
export interface ChatActionDeps {
  readonly chats: Pick<ChatsRepo, 'getById'>;
  readonly outbox: Pick<Outbox, 'canSendFromPanel' | 'sendFromPanel'>;
  readonly handoff: Pick<HandoffService, 'handOff' | 'returnToBot'>;
  /** Ответ бота на неотвеченное после возврата (pipeline/resume.ts); нет: отвечать некому, 0. */
  readonly resume?: ((chatId: ChatId) => number) | undefined;
}

/**
 * Контекст действия: зависимости, общая память недавних ответов (окно дубля 10 секунд одно на старую панель и
 * консоль) и журнал действий (строка без текста, имени и номера; у консоли ещё имя пользователя).
 */
export interface ChatActionContext {
  readonly deps: ChatActionDeps;
  readonly recentReplies: RecentReplies;
  readonly audit: Logger;
}

/**
 * Итог ответа клиенту. refused: отказ с понятным текстом (пустой или длинный текст, закрытый чат, отказ самой
 * отправки PanelSendError); failed: прочий сбой передачи или отправки, текст общий.
 */
export type ReplyOutcome =
  | { readonly kind: 'sent' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

/** Итог возврата чата боту. resumed: на сколько сообщений клиента бот ответит после возврата. */
export type ReturnOutcome =
  | { readonly kind: 'returned'; readonly resumed: number }
  | { readonly kind: 'returned_answering'; readonly resumed: number }
  | { readonly kind: 'already_bot' }
  | { readonly kind: 'note_too_long'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

/** Чата с таким ID нет (удалён слиянием или неверная ссылка). */
export interface ChatNotFound {
  readonly kind: 'not_found';
}

const NOT_FOUND: ChatNotFound = { kind: 'not_found' };

/** Браузер шлёт переводы строк формы как CRLF; в WhatsApp уходит LF. Повторный вызов ничего не меняет. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Что мешает ответу ещё до передачи чата менеджеру: пустой или слишком длинный текст, а также чат, в который из
 * панели писать нельзя (закрытый режим, WhatsApp не подключён). После передачи бот в чате уже молчит, поэтому
 * заведомо несостоявшаяся отправка не должна её запускать. null: можно передавать и отправлять.
 */
function refusalBeforeHandoff(context: ChatActionContext, chat: Chat, text: string): string | null {
  const textProblem = panelTextProblem(text);
  if (textProblem !== null) return textProblem;
  if (context.deps.outbox.canSendFromPanel(chat.id)) return null;
  context.audit.warn(
    { action: 'reply_blocked', chatId: chat.id },
    'Панель: ответ не отправлен, чат закрыт для отправки из панели',
  );
  return CHAT_CLOSED_FOR_REPLY;
}

/**
 * Ответ от имени номера. Порядок из плана: сначала чат уходит менеджеру (бот в нём замолкает), потом сообщение
 * уходит клиенту. Переводы строк приводятся к LF; проверки идут до передачи (refusalBeforeHandoff): пустой или
 * слишком длинный ответ и чат, в который отправка заведомо не пройдёт, не должны отключать бота. Затем ответ
 * занимается в recentReplies: повтор (тот же текст в тот же чат в течение 10 секунд) получает duplicate, без передачи
 * и без отправки. Всё до занятия синхронно (до первого await), поэтому из двух одновременных одинаковых запросов
 * проходит один. Сбой передачи или отправки снимает отметку: ответ не ушёл, и менеджер может повторить сразу.
 * Отказ с понятным текстом (SafeError) отдаётся как есть, прочие сбои скрыты за общей фразой.
 */
export async function replyToClient(
  context: ChatActionContext,
  chat: Chat,
  typedText: string,
): Promise<ReplyOutcome> {
  const text = normalizeNewlines(typedText);
  const problem = refusalBeforeHandoff(context, chat, text);
  if (problem !== null) return { kind: 'refused', message: problem };
  if (!context.recentReplies.claim(chat.id, text)) {
    context.audit.info(
      { action: 'reply_duplicate', chatId: chat.id },
      'Панель: повтор того же ответа отклонён',
    );
    return { kind: 'duplicate' };
  }
  try {
    await context.deps.handoff.handOff(chat.id, { reason: 'human_took_over', by: 'panel' });
    await context.deps.outbox.sendFromPanel(chat.id, text);
  } catch (error: unknown) {
    context.recentReplies.release(chat.id, text);
    return replyFailure(context, chat, error);
  }
  context.audit.info({ action: 'reply', chatId: chat.id }, 'Панель: ответ клиенту отправлен');
  return { kind: 'sent' };
}

function replyFailure(context: ChatActionContext, chat: Chat, error: unknown): ReplyOutcome {
  if (error instanceof SafeError) {
    context.audit.warn(
      { action: 'reply_failed', chatId: chat.id },
      'Панель: ответ не отправлен (отказ)',
    );
    return { kind: 'refused', message: error.message };
  }
  context.audit.error(
    { action: 'reply_failed', chatId: chat.id, err: error },
    'Панель: ответ не отправлен (сбой)',
  );
  return { kind: 'failed', message: SEND_FAILED };
}

/**
 * Ответ бота на сообщения клиента без ответа после возврата (решение владельца 29.10.2026). Чат уже возвращён, поэтому
 * сбой здесь возврат не отменяет: ошибка в аудит только именем, бот ответит на следующее сообщение клиента. Нет
 * ответов клиентам (deps.resume не задан): 0.
 */
function resumeSafely(context: ChatActionContext, chat: Chat): number {
  try {
    return context.deps.resume?.(chat.id) ?? 0;
  } catch (error: unknown) {
    context.audit.error(
      {
        action: 'resume_failed',
        chatId: chat.id,
        errorName: error instanceof Error ? error.name : typeof error,
      },
      'Панель: бот не взял неотвеченные сообщения после возврата',
    );
    return 0;
  }
}

/**
 * Возврат чата боту. Чат уже у бота (страница устарела): ничего не вызывается, already_bot, заметка не сохраняется.
 * Вернуть чат боту можно только отсюда: сам бот себе чат не возвращает. Необязательная заметка для бота чистится
 * (переводы строк, cleanBotNote) и проверяется до возврата: длиннее BOT_NOTE_MAX_LENGTH => note_too_long, чат
 * остаётся у менеджера. Затем handoff.returnToBot (сбой => failed с общей фразой) и ответ бота на неотвеченное
 * (resumeSafely). В аудит только то, есть ли заметка, без текста; есть неотвеченные => returned_answering.
 */
export async function returnChatToBot(
  context: ChatActionContext,
  chat: Chat,
  typedNote: string,
): Promise<ReturnOutcome> {
  if (chat.control.status === 'bot') return { kind: 'already_bot' };
  const note = cleanBotNote(normalizeNewlines(typedNote));
  const problem = botNoteProblem(note);
  if (problem !== null) return { kind: 'note_too_long', message: problem };
  try {
    await context.deps.handoff.returnToBot(chat.id, note === '' ? null : note);
  } catch (error: unknown) {
    context.audit.error(
      { action: 'return_to_bot_failed', chatId: chat.id, err: error },
      'Панель: чат не возвращён боту',
    );
    return { kind: 'failed', message: RETURN_FAILED };
  }
  const resumed = resumeSafely(context, chat);
  context.audit.info(
    { action: 'return_to_bot', chatId: chat.id, resumed, note: note !== '' },
    'Панель: чат возвращён боту',
  );
  return resumed > 0 ? { kind: 'returned_answering', resumed } : { kind: 'returned', resumed };
}

/** Ответ клиенту в чат по ID: чата нет => not_found, ничего не вызывается. */
export function replyToChat(
  context: ChatActionContext,
  chatId: ChatId,
  typedText: string,
): Promise<ReplyOutcome | ChatNotFound> {
  const chat = context.deps.chats.getById(chatId);
  return chat === null ? Promise.resolve(NOT_FOUND) : replyToClient(context, chat, typedText);
}

/** Возврат боту чата по ID: чата нет => not_found, ничего не вызывается. */
export function returnChatById(
  context: ChatActionContext,
  chatId: ChatId,
  typedNote: string,
): Promise<ReturnOutcome | ChatNotFound> {
  const chat = context.deps.chats.getById(chatId);
  return chat === null ? Promise.resolve(NOT_FOUND) : returnChatToBot(context, chat, typedNote);
}
