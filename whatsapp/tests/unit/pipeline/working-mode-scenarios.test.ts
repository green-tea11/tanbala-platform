import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WAMessage } from 'baileys';
import { describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { loadConfig, type AppConfig } from '../../../src/config/env.js';
import { createUnitOfWork } from '../../../src/db/connection.js';
import { createAppStateRepo } from '../../../src/db/repos/app-state.js';
import { createBacklogRepo } from '../../../src/db/repos/backlog.js';
import { createCallBudget } from '../../../src/db/repos/call-budget.js';
import { createChatsRepo } from '../../../src/db/repos/chats.js';
import { createHandoffsRepo } from '../../../src/db/repos/handoffs.js';
import { createKnownChatsRepo } from '../../../src/db/repos/known-chats.js';
import { createManagerNotificationsRepo } from '../../../src/db/repos/manager-notifications.js';
import { createMessagesRepo } from '../../../src/db/repos/messages.js';
import { createOutboundIdsRepo } from '../../../src/db/repos/outbound-ids.js';
import { createRejectedDraftsRepo } from '../../../src/db/repos/rejected-drafts.js';
import { createWorkingModeRepo } from '../../../src/db/repos/working-mode.js';
import type { CompanyService, CompanySummary, CompanyTurn } from '../../../src/domain/company.js';
import type { Logger } from '../../../src/domain/ports.js';
import type { ChatControl, Jid, WaMessageId, WorkingMode } from '../../../src/domain/types.js';
import type { PipelineOutcome } from '../../../src/pipeline/handle-inbound.js';
import { createInboundRecorder, type InboundRecorder } from '../../../src/pipeline/recorder.js';
import {
  assembleResponder,
  type ResponderConnection,
} from '../../../src/pipeline/responder-setup.js';
import { assembleServices, type Services } from '../../../src/pipeline/services.js';
import {
  createHeldForManagerCheck,
  createUnseenHold,
  settleWorkingMode,
} from '../../../src/pipeline/working-mode.js';
import { classifyUpsert, type WaEvent } from '../../../src/whatsapp/inbound.js';
import { createFakeLogger, type LogEntry } from '../../helpers/fake-logger.js';
import { ROOT as PROJECT_ROOT } from '../../helpers/source-files.js';
import { useMigratedDb, useTempDir } from '../db/fixture.js';
import { scriptedLlm, type LlmScript, type ScriptedLlm } from './scripted-llm.js';

// Сценарии этапа 8: переход в рабочий режим на рабочем номере. Сборка как в main.ts: настоящие база в памяти, разбор
// входящих (whatsapp/inbound.classifyUpsert), запись (pipeline/recorder.ts), переход (pipeline/working-mode.ts), общие
// службы и ответы. Поддельные только WhatsApp (сообщения Baileys синтетические, отправка копится) и модель
// (scripted-llm.ts): 0 токенов, без сети. Номера вымышленные.

const HOUR_MS = 3_600_000;
const LINKED_MS = Date.UTC(2026, 9, 20, 9, 0, 0);
const SWITCH_MS = Date.UTC(2026, 9, 29, 9, 0, 0);
const BOT_JID = '77000000001@s.whatsapp.net' as Jid;
const TESTER_PHONE = '77000000002';
const TESTER_JID = `${TESTER_PHONE}@s.whatsapp.net` as Jid;
const MANAGER_PHONE = '77000000009';
const MANAGER_JID = `${MANAGER_PHONE}@s.whatsapp.net` as Jid;
/** Клиент из первой синхронизации: переписка была задолго до бота. */
const OLD_JID = '77000000003@s.whatsapp.net' as Jid;
/** Его же @lid: синхронизация сообщила оба адреса чата. */
const OLD_LID = '100000000000003@lid' as Jid;
/** Писал, пока бот был в закрытом режиме: бот его пропустил, но запомнил чат. */
const QUIET_JID = '77000000004@s.whatsapp.net' as Jid;
/** Бывший тестировщик: чат в базе есть, а номер из TEST_ALLOWLIST убрали. */
const FORMER_JID = '77000000005@s.whatsapp.net' as Jid;
/** Впервые пишет после перехода. */
const NEW_JID = '77000000006@s.whatsapp.net' as Jid;
/** Писал до перехода, а сообщение дошло после (офлайн-очередь). */
const LATE_JID = '77000000007@s.whatsapp.net' as Jid;
const ASK = 'Расскажите, пожалуйста, что вы храните?';
const MODELS: unknown = JSON.parse(
  readFileSync(join(PROJECT_ROOT, 'config', 'models.json'), 'utf8'),
);

/** Что произошло за реплику. */
interface Turn {
  readonly event: WaEvent;
  readonly outcome: PipelineOutcome | null;
  readonly llm: ScriptedLlm;
  readonly toClient: readonly string[];
}

interface Rig {
  readonly config: AppConfig;
  readonly logs: LogEntry[];
  readonly storage: ReturnType<typeof storageOf>;
  readonly services: Services;
  readonly sendText: Mock<ResponderConnection['sendText']>;
  workingMode: WorkingMode | null;
  recorder: InboundRecorder;
  nowMs: number;
}

function configOf(testMode: 'true' | 'false'): AppConfig {
  const root = useTempDir().path;
  mkdirSync(join(root, 'knowledge'));
  for (const name of ['tanbala-agent.md', 'whatsapp.md', 'consult.md']) {
    copyFileSync(join(PROJECT_ROOT, 'knowledge', name), join(root, 'knowledge', name));
  }
  const env = {
    TEST_MODE: testMode,
    TEST_ALLOWLIST: TESTER_PHONE,
    MANAGER_WHATSAPP: MANAGER_PHONE,
    VENMART_ANTHROPIC_KEY: 'sk-test-not-a-real-key',
  };
  return loadConfig(env, MODELS, root).config;
}

function storageOf(config: AppConfig) {
  const db = useMigratedDb();
  return {
    db,
    appState: createAppStateRepo(db),
    switchRepo: createWorkingModeRepo(db),
    chats: createChatsRepo(db),
    messages: createMessagesRepo(db),
    outboundIds: createOutboundIdsRepo(db),
    budget: createCallBudget(db, config.limits),
    backlog: createBacklogRepo(db),
    handoffs: createHandoffsRepo(db),
    notifications: createManagerNotificationsRepo(db),
    knownChats: createKnownChatsRepo(db),
    unitOfWork: createUnitOfWork(db),
    rejectedDrafts: createRejectedDraftsRepo(db),
  };
}

/** Определение компании выключено: так сервис отвечает без INTERNAL_API_TOKEN. */
const OFF_TURN: CompanyTurn = { prompt: { kind: 'off' }, awaitingAnswer: false };

const OFF_SUMMARY: CompanySummary = {
  status: 'off',
  companyId: null,
  name: null,
  city: null,
  rubric: null,
  candidateSource: null,
  cardUrl: null,
  confirmedPains: [],
  briefPains: [],
  emailed: null,
  research: null,
  statedName: null,
};

function companyOff(): CompanyService {
  return {
    prepare: () => Promise.resolve(OFF_TURN),
    applyAssessment: () => Promise.resolve(OFF_TURN.prompt),
    markAsked: () => undefined,
    stopAwaiting: () => undefined,
    identifyAfterReply: () => Promise.resolve(),
    summary: () => OFF_SUMMARY,
  };
}

function recorderOf(rig: Pick<Rig, 'storage' | 'workingMode'>, logger: Logger): InboundRecorder {
  const { storage } = rig;
  return createInboundRecorder({
    ...storage,
    heldForManager: createHeldForManagerCheck(rig.workingMode, storage.switchRepo),
    holdUnseen: createUnseenHold(rig.workingMode, storage.switchRepo),
    logger,
    clock: { now: () => SWITCH_MS, sleep: () => Promise.resolve() },
  });
}

/** Синтетическое сообщение Baileys: текст клиента (или своё, fromMe) в личном чате. */
function waMessage(jid: Jid, waId: string, text: string, tsMs: number, fromMe = false): WAMessage {
  const synthetic: unknown = {
    key: { remoteJid: jid, fromMe, id: waId },
    message: { conversation: text },
    messageTimestamp: tsMs / 1000,
  };
  return synthetic as WAMessage;
}

function outcomeOf(logs: readonly LogEntry[]): PipelineOutcome | null {
  const entry = logs.findLast((log) => typeof log.context['outcome'] === 'string');
  if (entry === undefined) return null;
  const { outcome, reason } = entry.context;
  return (reason === undefined ? { kind: outcome } : { kind: outcome, reason }) as PipelineOutcome;
}

/**
 * Номер привязан в закрытом режиме: первая синхронизация (старый клиент), чат тестировщика и бывшего тестировщика
 * с неотвеченным сообщением за 2 часа до перехода, клиент, которому бот не ответил в закрытом режиме. Затем запуск с
 * TEST_MODE=false в момент SWITCH_MS.
 */
async function switchedRig(): Promise<Rig> {
  const config = configOf('false');
  const logs: LogEntry[] = [];
  const logger = createFakeLogger(logs);
  const storage = storageOf(config);
  storage.appState.setLinkedAtMs(LINKED_MS);
  const closed: Pick<Rig, 'storage' | 'workingMode'> = { storage, workingMode: null };
  const closedRecorder = recorderOf(closed, logger);
  closedRecorder.onHistoryChats([
    { jid: OLD_JID, altJids: [OLD_LID], lastMessageAtMs: LINKED_MS - 40 * 24 * HOUR_MS },
  ]);
  for (const [jid, waId] of [
    [TESTER_JID, 'T-0'],
    [FORMER_JID, 'F-0'],
  ] as const) {
    const chat = storage.chats.upsertByIdentity(
      { replyJid: jid, lidJid: null, pnJid: jid },
      null,
      LINKED_MS,
    );
    storage.messages.insertIfNew({
      chatId: chat.id,
      waId: waId as WaMessageId,
      author: 'client',
      kind: 'text',
      text: 'Старый вопрос до перехода',
      tsMs: SWITCH_MS - 2 * HOUR_MS,
    });
    storage.knownChats.touch(jid, SWITCH_MS - 2 * HOUR_MS, 'message');
  }
  const quiet = classifyUpsert(waMessage(QUIET_JID, 'Q-0', 'Есть кто?', SWITCH_MS - 3 * HOUR_MS), {
    managerJids: new Set([MANAGER_JID]),
    selfJids: new Set([BOT_JID]),
    linkedAtMs: LINKED_MS,
    nowMs: SWITCH_MS - 3 * HOUR_MS,
    backlogMaxAgeMs: config.backlogMaxAgeHours * HOUR_MS,
    testAllowlist: config.testMode.allowlist,
    workingMode: null,
    chatPhone: null,
    upsertType: 'notify',
  });
  expect(quiet).toMatchObject({ type: 'ignore', reason: 'not_allowlisted' });
  await closedRecorder.onEvent(quiet);

  const workingMode = settleWorkingMode(
    { ...storage, repo: storage.switchRepo, clock: { now: () => SWITCH_MS }, logger },
    config.testMode,
  );
  const services = assembleServices({
    config,
    logger,
    clock: { now: () => SWITCH_MS, sleep: () => Promise.resolve() },
    storage,
    company: companyOff(),
  });
  onTestFinished(() => services.stop());
  const sendText = vi.fn<ResponderConnection['sendText']>(() => Promise.resolve());
  let sent = 0;
  services.connect({
    newMessageId: () => `OUT-${(sent += 1)}` as WaMessageId,
    sendText,
    setTyping: () => Promise.resolve(),
  });
  const rig: Rig = {
    config,
    logs,
    storage,
    services,
    sendText,
    workingMode,
    recorder: closedRecorder,
    nowMs: SWITCH_MS + HOUR_MS,
  };
  rig.recorder = recorderOf(rig, logger);
  return rig;
}

async function responderOf(rig: Rig, llm: ScriptedLlm) {
  const clock = { now: () => rig.nowMs, sleep: () => Promise.resolve() };
  const responder = await assembleResponder({
    config: rig.config,
    logger: createFakeLogger(rig.logs),
    clock,
    storage: rig.storage,
    services: rig.services,
    company: companyOff(),
    createLlm: () => llm.llm,
    workingMode: rig.workingMode,
  });
  if (responder === null) throw new Error('ответы не собраны');
  responder.connect({
    newMessageId: () => 'UNUSED' as WaMessageId,
    sendText: rig.sendText,
    setTyping: () => Promise.resolve(),
    markRead: () => Promise.resolve(),
    downloadAudio: () => Promise.reject(new Error('голосовых в сценарии нет')),
  });
  return responder;
}

function sentTo(rig: Rig, from: number, jid: Jid): string[] {
  return rig.sendText.mock.calls
    .slice(from)
    .filter(([to]) => to === jid)
    .map(([, body]) => body);
}

/** Сообщение приходит в рабочем режиме: разбор, запись, очередь ответа (как main.routeEvent). */
async function receive(
  rig: Rig,
  message: {
    readonly jid: Jid;
    readonly waId: string;
    readonly text: string;
    readonly tsMs: number;
    /** Своё сообщение: менеджер ответил с телефона. */
    readonly fromMe?: boolean;
  },
  script: LlmScript = { replies: [ASK] },
  upsertType: 'notify' | 'append' = 'notify',
): Promise<Turn> {
  const mark = { sent: rig.sendText.mock.calls.length, logs: rig.logs.length };
  const llm = scriptedLlm(script);
  const responder = await responderOf(rig, llm);
  const { jid, waId, text, tsMs, fromMe } = message;
  const event = classifyUpsert(waMessage(jid, waId, text, tsMs, fromMe), {
    managerJids: new Set([MANAGER_JID]),
    selfJids: new Set([BOT_JID]),
    linkedAtMs: LINKED_MS,
    nowMs: rig.nowMs,
    backlogMaxAgeMs: rig.config.backlogMaxAgeHours * HOUR_MS,
    testAllowlist: null,
    workingMode: rig.workingMode,
    chatPhone: null,
    upsertType,
  });
  const recorded = await rig.recorder.onEvent(event);
  if (event.type === 'client' && recorded?.isNew === true) {
    responder.batcher.push(recorded.chatId, event.message);
  }
  await responder.batcher.drain();
  return {
    event,
    outcome: outcomeOf(rig.logs.slice(mark.logs)),
    llm,
    toClient: sentTo(rig, mark.sent, message.jid),
  };
}

/** «Вернуть боту» из панели: returnToBot, затем ответ на неотвеченное (Responder.resume). */
async function returnToBot(rig: Rig, jid: Jid, script: LlmScript = { replies: [ASK] }) {
  const chat = rig.storage.chats.findByJid(jid);
  if (chat === null) throw new Error('чата нет');
  const mark = rig.sendText.mock.calls.length;
  const llm = scriptedLlm(script);
  const responder = await responderOf(rig, llm);
  await rig.services.handoff.returnToBot(chat.id, null);
  const resumed = responder.resume(chat.id);
  await responder.batcher.drain();
  return { resumed, llm, toClient: sentTo(rig, mark, jid) };
}

function controlOf(rig: Rig, jid: Jid): ChatControl | undefined {
  return rig.storage.chats.findByJid(jid)?.control;
}

describe('сценарии этапа 8: переход в рабочий режим', () => {
  it('новый клиент после перехода: бот отвечает обычным путём', async () => {
    const rig = await switchedRig();

    const turn = await receive(rig, {
      jid: NEW_JID,
      waId: 'N-1',
      text: 'Здравствуйте',
      tsMs: rig.nowMs,
    });

    expect(turn.event.type).toBe('client');
    expect(turn.outcome).toEqual({ kind: 'replied' });
    expect(turn.toClient).toEqual([ASK]);
    expect(controlOf(rig, NEW_JID)).toEqual({ status: 'bot', by: null });
  });

  it('чужое сообщение, отправленное до перехода (офлайн-очередь): пропуск before_link, ни чата, ни ответа; следующее сообщение после перехода тоже без ответа, чат у менеджера', async () => {
    const rig = await switchedRig();

    const turn = await receive(
      rig,
      { jid: LATE_JID, waId: 'L-1', text: 'Добрый вечер', tsMs: SWITCH_MS - HOUR_MS },
      { replies: [ASK] },
      'append',
    );
    const after = await receive(rig, {
      jid: LATE_JID,
      waId: 'L-2',
      text: 'Вы тут?',
      tsMs: rig.nowMs,
    });

    expect(turn.event).toMatchObject({ type: 'ignore', reason: 'before_link', chatJid: LATE_JID });
    expect(turn.llm.requests).toEqual([]);
    expect(turn.toClient).toEqual([]);
    expect(rig.storage.switchRepo.listKnownChats().map((chat) => chat.jid)).toContain(LATE_JID);
    expect(after.event.type).toBe('client');
    expect(after.outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(after.llm.requests).toEqual([]);
    expect(after.toClient).toEqual([]);
    expect(controlOf(rig, LATE_JID)).toEqual({ status: 'manager', by: 'phone' });
  });

  it('менеджер ответил с телефона до перехода (своё сообщение из офлайн-очереди): клиент пишет после перехода, бот молчит', async () => {
    const rig = await switchedRig();

    const reply = await receive(
      rig,
      {
        jid: LATE_JID,
        waId: 'L-M',
        text: 'Добрый вечер, это менеджер',
        tsMs: SWITCH_MS - 20 * 60_000,
        fromMe: true,
      },
      { replies: [ASK] },
      'append',
    );
    const after = await receive(rig, {
      jid: LATE_JID,
      waId: 'L-2',
      text: 'Спасибо, а ещё вопрос',
      tsMs: rig.nowMs,
    });

    expect(reply.event).toMatchObject({ type: 'ignore', reason: 'before_link', chatJid: LATE_JID });
    expect(after.outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(after.toClient).toEqual([]);
    expect(controlOf(rig, LATE_JID)).toEqual({ status: 'manager', by: 'phone' });
  });

  it('старый клиент из первой синхронизации: чат у менеджера, бот молчит; «Вернуть боту» и бот отвечает', async () => {
    const rig = await switchedRig();

    const silent = await receive(rig, {
      jid: OLD_JID,
      waId: 'O-1',
      text: 'Вы ещё работаете?',
      tsMs: rig.nowMs,
    });
    const back = await returnToBot(rig, OLD_JID);

    expect(silent.outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(silent.llm.requests).toEqual([]);
    expect(silent.toClient).toEqual([]);
    expect(back.resumed).toBe(1);
    expect(back.toClient).toEqual([ASK]);
    expect(controlOf(rig, OLD_JID)).toEqual({ status: 'bot', by: 'panel' });
  });

  it('старый клиент пишет с @lid без номера (WhatsApp не сообщил номер): адрес из синхронизации, чат у менеджера', async () => {
    const rig = await switchedRig();

    const turn = await receive(rig, {
      jid: OLD_LID,
      waId: 'O-L',
      text: 'Добрый день, это снова я',
      tsMs: rig.nowMs,
    });

    expect(turn.event.type).toBe('client');
    expect(turn.outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(turn.toClient).toEqual([]);
    expect(controlOf(rig, OLD_LID)).toEqual({ status: 'manager', by: 'phone' });
  });

  it('клиент, писавший в закрытом режиме: после возврата бот отвечает только на сообщение после перехода', async () => {
    const rig = await switchedRig();
    await receive(
      rig,
      { jid: QUIET_JID, waId: 'Q-1', text: 'Вопрос до перехода', tsMs: SWITCH_MS - HOUR_MS },
      { replies: [ASK] },
      'append',
    );
    const after = await receive(rig, {
      jid: QUIET_JID,
      waId: 'Q-2',
      text: 'Вопрос после перехода',
      tsMs: rig.nowMs,
    });

    const back = await returnToBot(rig, QUIET_JID);

    expect(after.outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(back.toClient).toEqual([ASK]);
    const reply = back.llm.requests.find((request) => request.purpose === 'reply');
    const prompt = JSON.stringify(reply?.turns);
    expect(prompt).toContain('Вопрос после перехода');
    expect(prompt).not.toContain('Вопрос до перехода');
  });

  it('бывший тестировщик (чат в базе не из списка): у менеджера; после возврата старое сообщение без ответа', async () => {
    const rig = await switchedRig();

    expect(controlOf(rig, FORMER_JID)).toEqual({ status: 'manager', by: 'phone' });
    const back = await returnToBot(rig, FORMER_JID);

    expect(back.resumed).toBe(0);
    expect(back.llm.requests).toEqual([]);
    expect(back.toClient).toEqual([]);
    expect(controlOf(rig, FORMER_JID)).toEqual({ status: 'bot', by: 'panel' });
  });

  it('новая привязка по QR в рабочем режиме: чаты новой синхронизации у менеджера, в том числе чат бота; номер из списка как был', async () => {
    const rig = await switchedRig();
    await receive(rig, { jid: NEW_JID, waId: 'N-1', text: 'Здравствуйте', tsMs: rig.nowMs });
    await receive(rig, { jid: TESTER_JID, waId: 'T-1', text: 'Проверка', tsMs: rig.nowMs });
    rig.nowMs += 24 * HOUR_MS;

    // Сессия отозвана, номер привязан заново: в перерыве с клиентами говорили с телефона, бот этого не видел.
    rig.recorder.onHistoryChats([
      { jid: NEW_JID, lastMessageAtMs: rig.nowMs - HOUR_MS },
      { jid: LATE_JID, lastMessageAtMs: rig.nowMs - HOUR_MS },
      { jid: TESTER_JID, lastMessageAtMs: rig.nowMs - HOUR_MS },
    ]);
    const gapClient = await receive(rig, {
      jid: LATE_JID,
      waId: 'L-3',
      text: 'Продолжим?',
      tsMs: rig.nowMs,
    });
    const botClient = await receive(rig, {
      jid: NEW_JID,
      waId: 'N-2',
      text: 'Так что по цене?',
      tsMs: rig.nowMs,
    });
    const tester = await receive(rig, {
      jid: TESTER_JID,
      waId: 'T-2',
      text: 'Ещё проверка',
      tsMs: rig.nowMs,
    });

    expect(gapClient.outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(gapClient.toClient).toEqual([]);
    expect(controlOf(rig, LATE_JID)).toEqual({ status: 'manager', by: 'phone' });
    expect(botClient.outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(botClient.llm.requests).toEqual([]);
    expect(botClient.toClient).toEqual([]);
    expect(controlOf(rig, NEW_JID)).toEqual({ status: 'manager', by: 'phone' });
    expect(tester.toClient).toEqual([ASK]);
    expect(controlOf(rig, TESTER_JID)).toEqual({ status: 'bot', by: null });
  });

  it('номер из TEST_ALLOWLIST работает как раньше: сообщение до перехода из офлайн-очереди получает ответ', async () => {
    const rig = await switchedRig();

    const turn = await receive(
      rig,
      { jid: TESTER_JID, waId: 'T-1', text: 'Проверка до перехода', tsMs: SWITCH_MS - HOUR_MS },
      { replies: [ASK] },
      'append',
    );

    expect(controlOf(rig, TESTER_JID)).toEqual({ status: 'bot', by: null });
    expect(turn.event.type).toBe('client');
    expect(turn.toClient).toEqual([ASK]);
  });
});
