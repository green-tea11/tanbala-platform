import type { FastifyInstance } from 'fastify';
import { sendHtml, withSession, type PanelContext } from './context.js';
import { LIST_PAGE_SIZE, parsePage } from './params.js';
import { renderNotificationsPage } from './view-notifications.js';
import { pageCountOf } from './view-parts.js';

/** Уведомления менеджеру со статусами: новые сверху, по LIST_PAGE_SIZE на странице. */
export function registerNotificationRoutes(app: FastifyInstance, context: PanelContext): void {
  app.get(
    '/notifications',
    withSession(context, (request, reply, session) => {
      const page = parsePage(request.query);
      const { notifications } = context.deps;
      const total = notifications.countAll();
      const items = notifications.listRecent({
        limit: LIST_PAGE_SIZE,
        offset: (page - 1) * LIST_PAGE_SIZE,
      });
      const pageCount = pageCountOf(total, LIST_PAGE_SIZE);
      return sendHtml(
        reply,
        200,
        renderNotificationsPage({ items, page, pageCount, total, csrf: session.csrf }),
      );
    }),
  );
}
