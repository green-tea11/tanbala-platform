import type { Chat } from '../domain/types.js';
import type { PanelContext } from './context.js';
import { HISTORY_PAGE_SIZE, type NoticeKey } from './params.js';
import type { ChatPageModel } from './view-chat.js';

/** Что страница чата получает кроме данных из базы: токен, пометка после действия, ошибка и набранный текст. */
export interface ChatPageExtras {
  readonly csrf: string;
  readonly notice: NoticeKey | null;
  readonly error: string | null;
  readonly draft: string;
  /** Курсор «показать раньше»: ID сообщения, раньше которого показывать; нет => самые свежие. */
  readonly before: number | undefined;
}

/**
 * Собирает данные страницы чата из репозиториев. Переписка читается с запасом в одно сообщение: оно говорит,
 * есть ли раньше ещё, и на странице не показывается.
 */
export function loadChatPage(
  context: PanelContext,
  chat: Chat,
  extras: ChatPageExtras,
): ChatPageModel {
  const { messages, handoffs, notifications } = context.deps;
  const limit = HISTORY_PAGE_SIZE + 1;
  const fetched = messages.history(
    chat.id,
    extras.before === undefined ? { limit } : { limit, beforeId: extras.before },
  );
  const hasEarlier = fetched.length > HISTORY_PAGE_SIZE;
  const shown = hasEarlier ? fetched.slice(fetched.length - HISTORY_PAGE_SIZE) : fetched;
  return {
    chat,
    messages: shown,
    earlierBefore: hasEarlier ? (shown[0]?.id ?? null) : null,
    isEarlierSlice: extras.before !== undefined,
    openHandoff: handoffs.findOpen(chat.id),
    lastNotification: notifications.latestForChat(chat.id),
    csrf: extras.csrf,
    notice: extras.notice,
    error: extras.error,
    draft: extras.draft,
  };
}
