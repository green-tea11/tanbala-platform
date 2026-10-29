import { toNumber, type Chat, type MessageUpsertType, type WAMessage } from 'baileys';
import type { PhoneDigits } from '../domain/types.js';
import type { HistoryChat, WhatsAppDeps } from './connection-types.js';
import type { ClassifyContext, WaEvent } from './inbound.js';
import { jidOf, type LidResolver } from './lid-resolver.js';

/** Сбоев разбора или onEvent подряд, после которых бот отключается. */
export const MAX_EVENT_FAILURES_IN_ROW = 3;

const MS_PER_SECOND = 1000;

/** Пачка messages.upsert: 'notify' живые, 'append' история и офлайн-очередь. */
export interface UpsertBatch {
  readonly messages: readonly WAMessage[];
  readonly type: MessageUpsertType;
}

/** Приём событий WhatsApp: чаты первой синхронизации и сообщения. */
export interface MessageIntake {
  /** Чаты первой синхронизации в onHistoryChats; сбой => markHistoryIncomplete, исключение наружу не уходит. */
  history(chats: readonly Chat[]): Promise<void>;
  /** Сообщения пачки по одному: номер собеседника, разбор, onEvent. linkedAtMs null => пачка не разбирается. */
  messages(batch: UpsertBatch, resolver: LidResolver, linkedAtMs: number | null): Promise<void>;
}

/** Зависимости приёма. */
export interface MessageIntakeOptions {
  readonly deps: Pick<
    WhatsAppDeps,
    | 'logger'
    | 'clock'
    | 'appState'
    | 'onEvent'
    | 'onHistoryChats'
    | 'managerPhone'
    | 'testAllowlist'
    | 'workingMode'
    | 'backlogMaxAgeMs'
  >;
  /** whatsapp/inbound.classifyUpsert или подмена в тестах. */
  readonly classify: (message: WAMessage, context: ClassifyContext) => WaEvent;
  /** MAX_EVENT_FAILURES_IN_ROW сбоев подряд: адаптер останавливается, WhatsApp копит офлайн-очередь до перезапуска. */
  readonly onTooManyFailures: () => Promise<void>;
}

/** Состояние приёма одного запуска: меняется только здесь. */
interface IntakeState {
  failuresInRow: number;
  /** Сбоев подряд набралось MAX_EVENT_FAILURES_IN_ROW: дальше ничего не разбирается. */
  halted: boolean;
  botAllowlistWarned: boolean;
}

type BaseContext = Omit<ClassifyContext, 'nowMs' | 'chatPhone' | 'upsertType'>;

/** Одно сообщение пачки и всё, что нужно для его разбора. */
interface MessageJob {
  readonly message: WAMessage;
  readonly resolver: LidResolver;
  readonly base: BaseContext;
  readonly upsertType: MessageUpsertType;
}

/**
 * Принимает события сокета для приложения. История: в onHistoryChats только адрес и время чатов (сообщения истории
 * не передаются); сбой записи отмечается markHistoryIncomplete, а сообщения той же пачки не теряются.
 * Сообщения: номер собеседника (whatsapp/lid-resolver.ts), classifyUpsert и onEvent строго по одному. Сбой разбора
 * или onEvent пишется в лог с ID сообщения и типом события, без текста и номера; MAX_EVENT_FAILURES_IN_ROW сбоев
 * подряд => onTooManyFailures, дальше приём не разбирает ничего. Номер самого бота в TEST_ALLOWLIST не считается
 * разрешённым (одно предупреждение без номера). Пропуски 'not_allowlisted' в лог только счётчиком.
 */
export function createMessageIntake(options: MessageIntakeOptions): MessageIntake {
  const state: IntakeState = { failuresInRow: 0, halted: false, botAllowlistWarned: false };
  return {
    history: (chats) => reportHistory(options.deps, chats),
    messages: (batch, resolver, linkedAtMs) =>
      receiveMessages(options, state, { batch, resolver, linkedAtMs }),
  };
}

async function receiveMessages(
  options: MessageIntakeOptions,
  state: IntakeState,
  input: {
    readonly batch: UpsertBatch;
    readonly resolver: LidResolver;
    readonly linkedAtMs: number | null;
  },
): Promise<void> {
  const { deps } = options;
  const { batch, resolver, linkedAtMs } = input;
  if (linkedAtMs === null) {
    deps.logger.warn(
      { count: batch.messages.length },
      'Момент привязки неизвестен: сообщения пропущены',
    );
    return;
  }
  const base: BaseContext = {
    managerJids: await resolver.managerJids(deps.managerPhone),
    selfJids: resolver.selfJids(),
    linkedAtMs,
    backlogMaxAgeMs: deps.backlogMaxAgeMs,
    testAllowlist: allowlistWithoutBot(options, state, resolver.botPhone()),
    workingMode: deps.workingMode,
  };
  let notAllowlisted = 0;
  for (const message of batch.messages) {
    if (state.halted) return;
    const event = await classifyOne(options, state, {
      message,
      resolver,
      base,
      upsertType: batch.type,
    });
    if (event === null) continue;
    if (event.type === 'ignore' && event.reason === 'not_allowlisted') notAllowlisted += 1;
    await deliver(options, state, message, event);
  }
  if (notAllowlisted > 0) {
    deps.logger.info({ count: notAllowlisted }, 'Закрытый режим: пропущены сообщения вне списка');
  }
}

async function classifyOne(
  options: MessageIntakeOptions,
  state: IntakeState,
  job: MessageJob,
): Promise<WaEvent | null> {
  const { deps } = options;
  const { message, upsertType } = job;
  try {
    const chatPhone = await job.resolver.chatPhone(message.key);
    const context = { ...job.base, nowMs: deps.clock.now(), chatPhone, upsertType };
    return options.classify(message, context);
  } catch (error: unknown) {
    // В лог только ID и тип пачки: текст и номер не пишутся.
    const waId = message.key.id ?? null;
    deps.logger.error({ err: error, waId, upsertType }, 'Не удалось разобрать сообщение WhatsApp');
    await countFailure(options, state);
    return null;
  }
}

async function deliver(
  options: MessageIntakeOptions,
  state: IntakeState,
  message: WAMessage,
  event: WaEvent,
): Promise<void> {
  try {
    await options.deps.onEvent(event);
    state.failuresInRow = 0;
  } catch (error: unknown) {
    const context = { err: error, waId: message.key.id ?? null, event: event.type };
    options.deps.logger.error(context, 'Сбой обработки события WhatsApp');
    await countFailure(options, state);
  }
}

async function countFailure(options: MessageIntakeOptions, state: IntakeState): Promise<void> {
  state.failuresInRow += 1;
  if (state.failuresInRow < MAX_EVENT_FAILURES_IN_ROW) return;
  state.halted = true;
  await options.onTooManyFailures();
}

/** Номер самого бота не собеседник: в TEST_ALLOWLIST он не считается разрешённым (предупреждение без номера). */
function allowlistWithoutBot(
  options: MessageIntakeOptions,
  state: IntakeState,
  botPhone: PhoneDigits | null,
): ReadonlySet<PhoneDigits> | null {
  const { testAllowlist, logger } = options.deps;
  if (testAllowlist === null || botPhone === null || !testAllowlist.has(botPhone)) {
    return testAllowlist;
  }
  if (!state.botAllowlistWarned) {
    state.botAllowlistWarned = true;
    logger.warn({}, 'Номер самого бота есть в TEST_ALLOWLIST: он не считается разрешённым');
  }
  return new Set([...testAllowlist].filter((phone) => phone !== botPhone));
}

/** Повтор одного чата не схлопывается: KnownChatsRepo.touch сам хранит самое позднее время. */
async function reportHistory(
  deps: MessageIntakeOptions['deps'],
  chats: readonly Chat[],
): Promise<void> {
  try {
    const known = chats.flatMap((chat): HistoryChat[] => {
      const jid = jidOf(chat.id);
      return jid === null ? [] : [{ jid, lastMessageAtMs: lastMessageMs(chat) }];
    });
    if (known.length > 0) await deps.onHistoryChats(known);
  } catch (error: unknown) {
    deps.logger.error({ err: error }, 'Чаты первой синхронизации записаны не все');
    try {
      deps.appState.markHistoryIncomplete(deps.clock.now());
    } catch (markError: unknown) {
      deps.logger.error({ err: markError }, 'Не удалось отметить неполную синхронизацию истории');
    }
  }
}

/** Время последнего сообщения чата из синхронизации (секунды Baileys => мс); нет времени => null. */
function lastMessageMs(chat: Chat): number | null {
  const seconds = Math.max(
    toNumber(chat.conversationTimestamp),
    chat.lastMessageRecvTimestamp ?? 0,
  );
  return seconds > 0 ? seconds * MS_PER_SECOND : null;
}
