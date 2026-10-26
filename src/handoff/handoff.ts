import type { ChatsRepo, Clock, HandoffsRepo, Logger, UnitOfWork } from '../domain/ports.js';
import type {
  BudgetScope,
  Chat,
  ChatControl,
  ChatId,
  ClientProfile,
  HandoffNotice,
  PhoneDigits,
  WaMessageId,
} from '../domain/types.js';
import type { Outbox } from '../messaging/outbox.js';
import { jidToPhone } from '../whatsapp/jid.js';
import { formatManagerNotification, type NotificationReason } from './notification.js';
import type { ManagerNotifier } from './notifier.js';

/**
 * Запрос передачи. Перехват человеком и исчерпанный дневной лимит идут без фразы клиенту;
 * остальные поводы всегда с фразой на входящее replyToWaId.
 */
export type HandOffRequest =
  | { readonly reason: 'human_took_over'; readonly by: 'phone' | 'panel' }
  | { readonly reason: 'limit'; readonly scope: BudgetScope }
  | (HandoffNotice & { readonly replyToWaId: WaMessageId });

/** Передача чата менеджеру и возврат боту (раздел плана «Передача менеджеру»). */
export interface HandoffService {
  /**
   * Передаёт чат менеджеру. Бросает (отказом промиса), только если передачу не удалось записать: чата нет или
   * сбой базы, тогда статус не менялся и ничего не отправлялось. После записи фраза клиенту и уведомление
   * менеджеру выполняются по возможности, их сбои пишутся в лог и наружу не бросаются: чат уже у менеджера.
   * Исключение при отправке фразы повторяется один раз через PHRASE_RETRY_DELAY_MS внутри handOff, поэтому
   * вызывающему оборачивать передачу в свои повторы не нужно: достаточно поймать исключение записи.
   * Открытая передача уже есть: повтор ничего не дублирует (ни фразы, ни уведомления).
   */
  handOff(chatId: ChatId, request: HandOffRequest): Promise<void>;
  /** Вернуть чат боту вручную из панели: закрыть передачу и поставить статус bot (by 'panel') одной транзакцией. */
  returnToBot(chatId: ChatId): Promise<void>;
}

/** Зависимости передачи. */
export interface HandoffDeps {
  chats: ChatsRepo;
  handoffs: HandoffsRepo;
  /** Транзакция для handoffs.open с chats.setStatus и для handoffs.resolve с chats.setStatus. */
  unitOfWork: UnitOfWork;
  /** Только фраза клиенту: уведомление менеджеру идёт через notifier. */
  outbox: Pick<Outbox, 'sendHandoffNotice'>;
  /** Запись уведомления в базу, отправка менеджеру и повтор при сбое (handoff/notifier.ts). */
  notifier: Pick<ManagerNotifier, 'notify'>;
  clock: Clock;
  logger: Logger;
}

/**
 * Пауза перед повтором фразы клиенту, упавшей исключением: за это время сокет WhatsApp успевает переподключиться
 * (то же значение, что SEND_RETRY_DELAY_MS в конвейере ответов).
 */
export const PHRASE_RETRY_DELAY_MS = 5_000;

/** Итог отправки фразы клиенту без исключения: sent или причина, по которой фраза не ушла. */
type PhraseResult = Awaited<ReturnType<Outbox['sendHandoffNotice']>>;

/** Запрос, после которого клиенту пишут фразу: всё, кроме перехвата человеком и лимита. */
type PhraseRequest = Extract<HandOffRequest, { readonly replyToWaId: WaMessageId }>;

/** Запрос, после которого уведомляют менеджера: всё, кроме перехвата человеком. */
type NotifiedRequest = Exclude<HandOffRequest, { readonly reason: 'human_took_over' }>;

/** Смена статуса при передаче: чат всегда уходит менеджеру. */
type ManagerChange = Extract<Parameters<ChatsRepo['setStatus']>[1], { readonly status: 'manager' }>;

/**
 * Создаёт сервис передачи. handOff: внутри unitOfWork.run handoffs.open (уровень интереса чата и снимок выжимки в
 * JSON) и chats.setStatus manager (by 'bot', а при перехвате 'phone' или 'panel'); open вернул false (открытая
 * передача уже есть) => выход, повтор ничего не дублирует. Статус при этом всё равно приводится в порядок: чат без
 * статуса manager уходит менеджеру, а чат, который передал бот, переходит к человеку, подключившемуся с телефона или
 * из панели; чат, который уже ведёт человек, статус не меняет (время перехвата остаётся первым). Затем фраза клиенту
 * через outbox.sendHandoffNotice (кроме human_took_over и limit; при исключении один повтор через 5 с) и уведомление
 * менеджеру через notifier (кроме human_took_over): kind 'handoff', для лимита 'limit' со своей квотой. Пустой
 * MANAGER_WHATSAPP и сбои отправки обрабатывает notifier: уведомление остаётся в панели, отправка повторяется.
 * Логи без имён, номеров и текста.
 */
export function createHandoffService(deps: HandoffDeps): HandoffService {
  return {
    handOff: (chatId, request) => handOff(deps, chatId, request),
    // Исполнитель промиса превращает исключение записи в отказ, а не в бросок.
    returnToBot: (chatId) =>
      new Promise<void>((resolve) => {
        resolve(returnToBot(deps, chatId));
      }),
  };
}

async function handOff(deps: HandoffDeps, chatId: ChatId, request: HandOffRequest): Promise<void> {
  const chat = requireChat(deps.chats, chatId);
  if (!recordHandoff(deps, chat, request)) {
    deps.logger.info({ chatId, reason: request.reason }, 'Передача уже открыта: повтор пропущен');
    return;
  }
  deps.logger.info({ chatId, reason: request.reason, level: chat.level }, 'Чат передан менеджеру');
  if (request.reason === 'human_took_over') return;
  if (request.reason !== 'limit') await sayToClient(deps, chat.id, request);
  await tellManager(deps, chat, request);
}

/** Запись передачи и смена статуса одной транзакцией. false: открытая передача уже была. */
function recordHandoff(deps: HandoffDeps, chat: Chat, request: HandOffRequest): boolean {
  const nowMs = deps.clock.now();
  const change = managerChangeOf(request);
  return deps.unitOfWork.run(() => {
    const opened = deps.handoffs.open(
      chat.id,
      request.reason,
      chat.level,
      snapshotOf(chat.profile),
      nowMs,
    );
    if (needsStatusChange(chat.control, change)) deps.chats.setStatus(chat.id, change, nowMs);
    return opened;
  });
}

function managerChangeOf(request: HandOffRequest): ManagerChange {
  return { status: 'manager', by: request.reason === 'human_took_over' ? request.by : 'bot' };
}

/**
 * Чат у бота: уходит менеджеру. Чат уже у менеджера: меняется только переход от бота к человеку, который
 * подключился; остальное оставляет прежнее время и автора перехвата.
 */
function needsStatusChange(current: ChatControl, change: ManagerChange): boolean {
  if (current.status === 'bot') return true;
  return current.by === 'bot' && change.by !== 'bot';
}

/** Снимок выжимки на момент передачи: JSON, чтобы позже можно было разобрать по полям. */
function snapshotOf(profile: ClientProfile): string {
  return JSON.stringify(profile);
}

/**
 * Фраза клиенту. Исключение отправки (например, сокет WhatsApp переподключается) повторяется один раз после паузы
 * PHRASE_RETRY_DELAY_MS. Отказ значением (skipped_no_inbound и прочие SendBlocked) не повторяется: он не случайный.
 * Окончательный сбой пишется ошибкой без текста и номера, а дальше всё идёт как обычно: уведомление менеджеру
 * уходит в любом случае.
 */
async function sayToClient(
  deps: HandoffDeps,
  chatId: ChatId,
  request: PhraseRequest,
): Promise<void> {
  const send = (): Promise<PhraseResult> =>
    deps.outbox.sendHandoffNotice(chatId, noticeOf(request), request.replyToWaId);
  try {
    logRefusal(deps.logger, chatId, await send());
    return;
  } catch (error: unknown) {
    deps.logger.warn(
      { chatId, errorName: errorNameOf(error) },
      `Фраза передачи клиенту не ушла: повтор через ${PHRASE_RETRY_DELAY_MS / 1000} с`,
    );
  }
  try {
    await deps.clock.sleep(PHRASE_RETRY_DELAY_MS);
    logRefusal(deps.logger, chatId, await send());
  } catch (error: unknown) {
    deps.logger.error(
      { chatId, reason: request.reason, errorName: errorNameOf(error) },
      `Клиент остался без фразы передачи: чат #${chatId}`,
    );
  }
}

function logRefusal(logger: Logger, chatId: ChatId, result: PhraseResult): void {
  if (result !== 'sent') logger.warn({ chatId, result }, 'Фраза передачи клиенту не отправлена');
}

/** Только имя класса: текст ошибки сокета может содержать адреса. */
function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function noticeOf(request: PhraseRequest): HandoffNotice {
  return request.reason === 'complaint'
    ? { reason: 'complaint', stopRequested: request.stopRequested }
    : { reason: request.reason };
}

async function tellManager(deps: HandoffDeps, chat: Chat, request: NotifiedRequest): Promise<void> {
  const kind = request.reason === 'limit' ? 'limit' : 'handoff';
  try {
    const text = formatManagerNotification({
      ...reasonOf(request),
      name: chat.pushName,
      phone: phoneOf(chat),
      level: chat.level,
      profile: chat.profile,
      chatId: chat.id,
    });
    await deps.notifier.notify(kind, chat.id, text, { reason: request.reason });
  } catch (error: unknown) {
    deps.logger.error(
      { err: error, chatId: chat.id, kind },
      'Уведомление менеджеру не записано: чат отмечен в панели',
    );
  }
}

function reasonOf(request: NotifiedRequest): NotificationReason {
  return request.reason === 'limit'
    ? { reason: 'limit', scope: request.scope }
    : { reason: request.reason };
}

/** Номер из адреса с номером; чат только с @lid номера не даёт. */
function phoneOf(chat: Chat): PhoneDigits | null {
  const { pnJid } = chat.identity;
  return pnJid === null ? null : jidToPhone(pnJid);
}

function returnToBot(deps: HandoffDeps, chatId: ChatId): void {
  requireChat(deps.chats, chatId);
  const nowMs = deps.clock.now();
  deps.unitOfWork.run(() => {
    deps.handoffs.resolve(chatId, nowMs);
    deps.chats.setStatus(chatId, { status: 'bot', by: 'panel' }, nowMs);
  });
  deps.logger.info({ chatId }, 'Чат возвращён боту из панели');
}

function requireChat(chats: ChatsRepo, chatId: ChatId): Chat {
  const chat = chats.getById(chatId);
  if (chat === null) throw new Error(`Чат #${chatId} не найден`);
  return chat;
}
