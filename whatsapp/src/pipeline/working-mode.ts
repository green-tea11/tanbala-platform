import type { TestMode } from '../config/env.js';
import type {
  AppStateRepo,
  ChatsRepo,
  Clock,
  Logger,
  UnitOfWork,
  WorkingModeRepo,
} from '../domain/ports.js';
import type { ChatIdentity, Jid, StatusChange, WorkingMode } from '../domain/types.js';
import { isChatAllowlisted } from '../messaging/allowlist.js';
import { SafeError } from '../shared/safe-error.js';

/** Что нужно переходу в рабочий режим при запуске. */
export interface WorkingModeDeps {
  readonly appState: Pick<
    AppStateRepo,
    | 'getLinkedAtMs'
    | 'getHistoryIncomplete'
    | 'getWorkingSinceMs'
    | 'setWorkingSinceMs'
    | 'clearWorkingSince'
  >;
  readonly repo: WorkingModeRepo;
  /** Статус manager для чатов базы, которые правило отдало менеджеру. */
  readonly chats: Pick<ChatsRepo, 'setStatus'>;
  /** Граница, отметки и статусы одной транзакцией: всё или ничего. */
  readonly unitOfWork: UnitOfWork;
  readonly clock: Pick<Clock, 'now'>;
  readonly logger: Logger;
}

/** Почему бот не переходит в рабочий режим. */
export type WorkingModeRefusal = 'not_linked' | 'history_incomplete';

const REFUSAL_TEXTS: Readonly<Record<WorkingModeRefusal, string>> = {
  not_linked:
    'Рабочий режим (TEST_MODE=false) не включён: номер ещё не привязан, список чатов рабочего номера не собран, ' +
    'и старые чаты достались бы боту. Привяжите номер с TEST_MODE=true, дождитесь в логе строки ' +
    '«Первая синхронизация» и только потом переключайте',
  history_incomplete:
    'Рабочий режим (TEST_MODE=false) не включён: в базе флаг «список чатов неполный», и старые чаты могли бы ' +
    'достаться боту. Верните TEST_MODE=true и передайте разработчику',
};

/**
 * Отказ перехода в рабочий режим: запуск останавливается до WhatsApp, в базе ничего не записано. Текст безопасен для
 * владельца: без номеров и адресов.
 */
export class WorkingModeRefusedError extends SafeError {
  override readonly name: string = 'WorkingModeRefusedError';
  readonly reason: WorkingModeRefusal;

  constructor(reason: WorkingModeRefusal) {
    super(REFUSAL_TEXTS[reason]);
    this.reason = reason;
  }
}

/**
 * Статус чата, который правило перехода отдало менеджеру: тот же manager, что у перехвата; by 'phone', потому что до
 * бота чаты рабочего номера вели люди с телефона. Передачи (handoffs) и уведомления менеджеру нет: это его прежние чаты.
 */
export const HELD_FOR_MANAGER = { status: 'manager', by: 'phone' } as const satisfies StatusChange;

/**
 * Правило перехода для чата, который был на рабочем номере до перехода (по умолчанию до решения владельца): каждый
 * такой чат начинает у менеджера, бот в нём молчит, пока менеджер не вернёт чат кнопкой «Вернуть боту». Владелец
 * может сузить правило, например только чаты с активностью за последние N дней:
 * `lastActivityMs !== null && switchedAtMs - lastActivityMs <= N * 24 * 60 * 60 * 1000`. Отдельной настройки нет:
 * правило меняется здесь, одним местом. lastActivityMs: последняя активность чата до перехода (known_chats или
 * последнее сообщение в базе), null, если неизвестна. Чаты с номеров TEST_ALLOWLIST правило не касается.
 */
export function startsWithManager(lastActivityMs: number | null, switchedAtMs: number): boolean {
  return true;
}

/**
 * Режим при запуске по TEST_MODE (этап 8). Правило из CLAUDE.md: чаты с перепиской до переключения ведёт менеджер,
 * бот берёт только чаты, впервые написавшие после него.
 * TEST_MODE=true: закрытый режим, null. Граница рабочего режима, если была, снимается (строка в лог): в закрытом
 * режиме бот не видит чатов не из списка, ни сообщений клиентов, ни ответов менеджера с телефона, поэтому следующий
 * TEST_MODE=false снова переход. Отметки и статусы чатов остаются.
 * TEST_MODE=false и граница уже есть: рабочий режим с этой границей, ничего не пересчитывается.
 * TEST_MODE=false без границы: переход. Сначала проверки, при отказе WorkingModeRefusedError и ничего не записано:
 * номер не привязан (список чатов ещё не собран) или стоит флаг «список чатов неполный». Затем одной транзакцией:
 * граница = сейчас (app_state), отметка «у менеджера» на адресах known_chats по правилу startsWithManager (новый чат с
 * таким адресом начнёт у менеджера, createHeldForManagerCheck) и статус manager (by 'phone') чатам базы со статусом
 * bot не из TEST_ALLOWLIST по тому же правилу. Сбой откатывает всё. Повторный переход после закрытого режима делает то
 * же самое: чаты, которые вёл бот, тоже уходят менеджеру, ведь пока режим был закрытым, менеджер мог ответить им с
 * телефона, а бот этого не видел (решение реализации вместо «оставить первую границу»: так бот никогда не отвечает
 * поверх человека). В лог одна строка с числом адресов и чатов, без адресов и номеров.
 */
export function settleWorkingMode(deps: WorkingModeDeps, testMode: TestMode): WorkingMode | null {
  if (testMode.enabled) {
    closeWorkingMode(deps);
    return null;
  }
  const existing = deps.appState.getWorkingSinceMs();
  if (existing !== null) {
    deps.logger.info(
      { workingSinceMs: existing },
      'Рабочий режим: переход уже был, граница не меняется, бот отвечает новым чатам',
    );
    return { sinceMs: existing, allowlist: testMode.allowlist };
  }
  return { sinceMs: enterWorkingMode(deps, testMode.allowlist), allowlist: testMode.allowlist };
}

function closeWorkingMode(deps: WorkingModeDeps): void {
  if (!deps.appState.clearWorkingSince()) return;
  deps.logger.info(
    {},
    'Закрытый режим: граница рабочего режима снята, следующий TEST_MODE=false снова будет переходом',
  );
}

function refusalOf(appState: WorkingModeDeps['appState']): WorkingModeRefusal | null {
  if (appState.getLinkedAtMs() === null) return 'not_linked';
  if (appState.getHistoryIncomplete() !== null) return 'history_incomplete';
  return null;
}

/** Переход одной транзакцией; возвращает границу. */
function enterWorkingMode(deps: WorkingModeDeps, allowlist: TestMode['allowlist']): number {
  const refusal = refusalOf(deps.appState);
  if (refusal !== null) throw new WorkingModeRefusedError(refusal);
  const nowMs = deps.clock.now();
  const counts = deps.unitOfWork.run(() => {
    deps.appState.setWorkingSinceMs(nowMs);
    const held = holdKnownChats(deps.repo, nowMs);
    const moved = deps.repo
      .listChats()
      .filter(
        (chat) =>
          chat.status === 'bot' &&
          !isChatAllowlisted(allowlist, chat.identity) &&
          startsWithManager(chat.lastMessageAtMs, nowMs),
      );
    for (const chat of moved) deps.chats.setStatus(chat.id, HELD_FOR_MANAGER, nowMs);
    return { heldAddresses: held, movedChats: moved.length };
  });
  deps.logger.info(
    counts,
    `Переход в рабочий режим: граница записана, у менеджера адресов известных чатов ${counts.heldAddresses}, ` +
      `чатов из базы переведено к менеджеру ${counts.movedChats}`,
  );
  return nowMs;
}

/** Отметки «у менеджера» на адресах known_chats по правилу; возвращает их число. */
function holdKnownChats(repo: WorkingModeRepo, nowMs: number): number {
  const held: Jid[] = repo
    .listKnownChats()
    .filter((chat) => startsWithManager(chat.lastActivityMs, nowMs))
    .map((chat) => chat.jid);
  repo.holdForManager(held);
  return held.length;
}

/**
 * Проверка для чата, который впервые появился в базе (pipeline/recorder.ts): в рабочем режиме чат не из TEST_ALLOWLIST
 * с адресом, отмеченным при переходе, начинает у менеджера. Закрытый режим (mode null): всегда false.
 */
export function createHeldForManagerCheck(
  mode: WorkingMode | null,
  repo: Pick<WorkingModeRepo, 'isHeldForManager'>,
): (identity: ChatIdentity) => boolean {
  return (identity) => {
    if (mode === null || isChatAllowlisted(mode.allowlist, identity)) return false;
    const { replyJid, lidJid, pnJid } = identity;
    return repo.isHeldForManager([replyJid, lidJid, pnJid].filter((jid) => jid !== null));
  };
}

/**
 * Самое раннее время сообщения, на которое бот отвечает после возврата чата (pipeline/resume.ts): в рабочем режиме у
 * чата не из TEST_ALLOWLIST граница перехода, иначе 0 (как раньше).
 */
export function resumeFloorMs(mode: WorkingMode | null, identity: ChatIdentity): number {
  if (mode === null || isChatAllowlisted(mode.allowlist, identity)) return 0;
  return mode.sinceMs;
}
