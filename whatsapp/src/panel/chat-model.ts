import type { CompanySummary } from '../domain/company.js';
import type { Chat, ChatId } from '../domain/types.js';
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
    company: companyOf(context, chat.id),
    csrf: extras.csrf,
    notice: extras.notice,
    error: extras.error,
    draft: extras.draft,
  };
}

/**
 * Сводка о компании для карточки. Сбой чтения не закрывает страницу: менеджер видит переписку и может ответить,
 * а в разделе «Компания» пометку. В лог только ID чата и имя ошибки, без данных о компании.
 */
function companyOf(context: PanelContext, chatId: ChatId): CompanySummary | null {
  try {
    return context.deps.company.summary(chatId);
  } catch (error: unknown) {
    context.audit.warn(
      {
        action: 'company_summary_failed',
        chatId,
        errorName: error instanceof Error ? error.name : typeof error,
      },
      'Панель: сводка о компании не прочитана',
    );
    return null;
  }
}
