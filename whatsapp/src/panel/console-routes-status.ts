import type { FastifyInstance } from 'fastify';
import { RESEARCH_MAX_STARTS_PER_DAY } from '../company/research.js';
import type { AttentionHandoffRow, HotChatRow, WaitingChatRow } from '../domain/console.js';
import type { ConsoleContext } from './console-context.js';
import { sendJson } from './console-http.js';
import {
  almatyDayOf,
  cleanOrNull,
  isoOrNull,
  nameOf,
  notificationJson,
  phoneOf,
} from './console-json.js';
import {
  parseCompanyId,
  parseConsolePage,
  parseDayRange,
  parseNotificationStatus,
} from './console-params.js';
import { readSpend } from './console-spend.js';
import { HANDOFF_REASON_LABELS, LEVEL_LABELS, NOTIFICATION_STATUS_LABELS } from './format.js';
import { LIST_PAGE_SIZE } from './params.js';
import { pageCountOf } from './view-parts.js';

export const PREFIX = '/internal/console';
const DAY_MS = 24 * 60 * 60_000;
/** Сколько строк в каждом списке «Требует внимания»: больше на главном экране не нужно. */
export const ATTENTION_LIMIT = 200;
/** Связей чат → компания без фильтра не больше этого (контракт). */
export const COMPANY_LINKS_LIMIT = 1000;

/** Ответ списка по контракту: элементы, всего, страница, страниц, размер страницы. */
export function pageJson(
  items: readonly unknown[],
  total: number,
  page: number,
  pageSize: number,
): Record<string, unknown> {
  return { items, total, page, pages: pageCountOf(total, pageSize), pageSize };
}

/** Состояние бота: WhatsApp по событиям сокета, режим, настройки (флаги), лимиты и служебные отметки. */
function statusJson(context: ConsoleContext): Record<string, unknown> {
  const { deps } = context;
  const { facts, reads, appState } = deps;
  const now = deps.clock.now();
  const dayAgo = Math.max(0, now - DAY_MS);
  const whatsapp = deps.whatsapp();
  return {
    whatsapp: {
      enabled: facts.waEnabled,
      state: whatsapp.state,
      since: isoOrNull(whatsapp.sinceMs),
    },
    testMode: facts.testMode,
    allowlistSize: facts.allowlistSize,
    managerConfigured: facts.managerConfigured,
    companyFeature: facts.companyFeature,
    llmConfigured: facts.llmConfigured,
    apiCalls: {
      today: reads.apiCallsOn(almatyDayOf(now)),
      dailyLimit: facts.apiDailyLimit,
      perChatLimit: facts.apiPerChatLimit,
    },
    research24h: { count: deps.researchStarts(dayAgo), limit: RESEARCH_MAX_STARTS_PER_DAY },
    pairingAttempts24h: reads.pairingAttemptsSince(dayAgo),
    linkedAt: isoOrNull(appState.getLinkedAtMs()),
    workingSince: isoOrNull(appState.getWorkingSinceMs()),
    historyIncomplete: appState.getHistoryIncomplete() !== null,
  };
}

function attentionHandoffJson(row: AttentionHandoffRow): Record<string, unknown> {
  const { notification } = row;
  return {
    id: row.id,
    chatId: row.chatId,
    name: nameOf(row.pushName),
    phone: phoneOf(row.pnJid),
    reason: row.reason,
    reasonLabel: HANDOFF_REASON_LABELS[row.reason],
    level: row.level,
    levelLabel: LEVEL_LABELS[row.level],
    openedAt: isoOrNull(row.openedAtMs),
    notification:
      notification === null
        ? null
        : {
            status: notification.status,
            statusLabel: NOTIFICATION_STATUS_LABELS[notification.status],
            attempts: notification.attempts,
          },
  };
}

function hotJson(row: HotChatRow): Record<string, unknown> {
  return {
    chatId: row.chatId,
    name: nameOf(row.pushName),
    phone: phoneOf(row.pnJid),
    status: row.status,
    levelReason: cleanOrNull(row.levelReason),
    levelUpdatedAt: isoOrNull(row.levelUpdatedAtMs),
    lastMessageAt: isoOrNull(row.lastMessageAtMs),
  };
}

function waitingJson(row: WaitingChatRow): Record<string, unknown> {
  return {
    chatId: row.chatId,
    name: nameOf(row.pushName),
    phone: phoneOf(row.pnJid),
    status: row.status,
    group: row.group,
    waitingSince: isoOrNull(row.waitingSinceMs),
    lastClientAt: isoOrNull(row.lastClientAtMs),
    complaint: row.complaint,
  };
}

/** «Требует внимания»: открытые передачи, горячие, ждут ответа и чаты простоя без уведомления. */
function attentionJson(context: ConsoleContext): Record<string, unknown> {
  const { reads, clock } = context.deps;
  return {
    handoffs: reads.openHandoffs(ATTENTION_LIMIT).map(attentionHandoffJson),
    hot: reads.hotChats(ATTENTION_LIMIT).map(hotJson),
    waiting: reads.waitingChats(clock.now(), ATTENTION_LIMIT).map(waitingJson),
    backlog: { pending: reads.pendingBacklogCount() },
  };
}

/** Уведомления менеджеру с именем клиента, фильтр по статусу, по LIST_PAGE_SIZE на странице. */
function notificationsJson(context: ConsoleContext, query: unknown): Record<string, unknown> {
  const status = parseNotificationStatus(query);
  const page = parseConsolePage(query);
  const filter = status === undefined ? {} : { status };
  const { reads } = context.deps;
  const total = reads.countNotifications(filter);
  const items = reads
    .listNotifications({ ...filter, limit: LIST_PAGE_SIZE, offset: (page - 1) * LIST_PAGE_SIZE })
    .map((item) => ({ ...notificationJson(item), chatName: nameOf(item.chatName) }));
  return pageJson(items, total, page, LIST_PAGE_SIZE);
}

/** Подтверждённые связи чат → компания; companyId задан => только её чаты. */
function companyLinksJson(context: ConsoleContext, query: unknown): Record<string, unknown> {
  const companyId = parseCompanyId(query);
  const rows = context.deps.reads.companyLinks({
    ...(companyId === undefined ? {} : { companyId }),
    limit: COMPANY_LINKS_LIMIT,
  });
  return {
    items: rows.map((row) => ({
      chatId: row.chatId,
      companyId: row.companyId,
      name: nameOf(row.pushName),
      phone: phoneOf(row.pnJid),
      status: row.status,
      level: row.level,
      confirmedAt: isoOrNull(row.confirmedAtMs),
      firstClientMessageAt: isoOrNull(row.firstClientMessageAtMs),
      lastMessageAt: isoOrNull(row.lastMessageAtMs),
    })),
  };
}

/** Состояние, «Требует внимания», уведомления, связи с компаниями и расход: только чтение. */
export function registerConsoleStatusRoutes(app: FastifyInstance, context: ConsoleContext): void {
  app.get(`${PREFIX}/status`, (_request, reply) => sendJson(reply, 200, statusJson(context)));
  app.get(`${PREFIX}/attention`, (_request, reply) => sendJson(reply, 200, attentionJson(context)));
  app.get(`${PREFIX}/notifications`, (request, reply) =>
    sendJson(reply, 200, notificationsJson(context, request.query)),
  );
  app.get(`${PREFIX}/company-links`, (request, reply) =>
    sendJson(reply, 200, companyLinksJson(context, request.query)),
  );
  app.get(`${PREFIX}/spend`, async (request, reply) => {
    const range = parseDayRange(request.query);
    const report = await readSpend(context.deps.tokenLogPath, range);
    return sendJson(reply, 200, { from: range.from, to: range.to, ...report });
  });
}
