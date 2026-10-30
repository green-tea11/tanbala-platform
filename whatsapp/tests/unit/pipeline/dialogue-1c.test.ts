import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { loadConfig, type AppConfig } from '../../../src/config/env.js';
import { createUnitOfWork } from '../../../src/db/connection.js';
import { createBacklogRepo } from '../../../src/db/repos/backlog.js';
import { createCallBudget } from '../../../src/db/repos/call-budget.js';
import { createChatCompaniesRepo } from '../../../src/db/repos/chat-companies.js';
import { createChatsRepo } from '../../../src/db/repos/chats.js';
import { createHandoffsRepo } from '../../../src/db/repos/handoffs.js';
import { createManagerNotificationsRepo } from '../../../src/db/repos/manager-notifications.js';
import { createMessagesRepo } from '../../../src/db/repos/messages.js';
import { createOutboundIdsRepo } from '../../../src/db/repos/outbound-ids.js';
import { createRejectedDraftsRepo } from '../../../src/db/repos/rejected-drafts.js';
import type { Clock, Logger } from '../../../src/domain/ports.js';
import type { ChatCompaniesRepo } from '../../../src/domain/company.js';
import type { Chat, InboundMessage, Jid, WaMessageId } from '../../../src/domain/types.js';
import { assembleCompany } from '../../../src/pipeline/company-setup.js';
import {
  assembleResponder,
  type ResponderConnection,
  type ResponderStorage,
} from '../../../src/pipeline/responder-setup.js';
import { assembleServices, type ServicesStorage } from '../../../src/pipeline/services.js';
import { ROOT as PROJECT_ROOT } from '../../helpers/source-files.js';
import { useMigratedDb, useTempDir } from '../db/fixture.js';
import { scriptedLlm, type LlmScript, type ScriptedLlm } from './scripted-llm.js';

// Живой случай клиента с 1С целиком, на моках: сообщение клиента => Sonnet отвечает hot с текстом => проверки кодом
// и вторым вызовом => передача с этим текстом одним сообщением => уведомление менеджеру. Настоящие агент, конвейер,
// сервис передачи, исходящие и репозитории на SQLite в памяти; модель, подключение WhatsApp и сеть поддельные.
// С 29.10.2026 передача по цене только с минимумом (вещи и материал, число вещей, город и помещение, 1С; компания не
// нужна: определение компании выключено), поэтому клиент здесь называет и это. Без минимума тот же вопрос даёт вопрос
// о недостающем: pipeline/price-scenarios.test.ts.

const CLIENT_PHONE = '77000000002';
const CLIENT_JID = `${CLIENT_PHONE}@s.whatsapp.net` as Jid;
const MANAGER_PHONE = '77000000009';
const MANAGER_JID = `${MANAGER_PHONE}@s.whatsapp.net` as Jid;

/** Сообщение клиента из живого теста (после него бот ответил только фиксированной фразой). */
const CLIENT_QUESTION =
  'Склад металлических запчастей в Алматы, 11 000 м², около 20 000 позиций, хотим учитывать ввоз и вывоз, сколько будет стоить, у нас 1С, у вас есть специалист, который подключится к нашей 1С?';

/** Ответ модели по решению владельца: ответ из знаний (раздел 9, вопрос 11) и одна фраза о передаче. */
const MODEL_TEXT =
  'Да, мы проводим интеграцию с вашей 1С, детали решаем по вашей конфигурации. Стоимость зависит от вашей задачи, уточню у коллеги и вернусь к вам.';

const KNOWLEDGE_ANSWER =
  'Да, мы проводим интеграцию с вашей 1С. Детали решаем по вашей конфигурации.';

const MODELS: unknown = JSON.parse(
  readFileSync(join(PROJECT_ROOT, 'config', 'models.json'), 'utf8'),
);
const CLOCK: Clock = { now: () => Date.now(), sleep: () => Promise.resolve() };

const SILENT_LOGGER: Logger = {
  level: 'silent',
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  silent: () => undefined,
  child: () => SILENT_LOGGER,
};

type Storage = ResponderStorage & ServicesStorage & { readonly chatCompanies: ChatCompaniesRepo };

/** Настройки с настоящими файлами знаний проекта и номером менеджера. */
function configOfProject(): AppConfig {
  const root = useTempDir().path;
  mkdirSync(join(root, 'knowledge'));
  for (const name of ['tanbala-agent.md', 'whatsapp.md', 'consult.md']) {
    copyFileSync(join(PROJECT_ROOT, 'knowledge', name), join(root, 'knowledge', name));
  }
  const env = {
    TEST_MODE: 'true',
    TEST_ALLOWLIST: CLIENT_PHONE,
    MANAGER_WHATSAPP: MANAGER_PHONE,
    VENMART_ANTHROPIC_KEY: 'sk-test-not-a-real-key',
  };
  return loadConfig(env, MODELS, root).config;
}

function storageOf(config: AppConfig): Storage {
  const db = useMigratedDb();
  return {
    chats: createChatsRepo(db),
    messages: createMessagesRepo(db),
    outboundIds: createOutboundIdsRepo(db),
    budget: createCallBudget(db, config.limits),
    backlog: createBacklogRepo(db),
    handoffs: createHandoffsRepo(db),
    notifications: createManagerNotificationsRepo(db),
    unitOfWork: createUnitOfWork(db),
    rejectedDrafts: createRejectedDraftsRepo(db),
    chatCompanies: createChatCompaniesRepo(db, SILENT_LOGGER),
  };
}

interface Dialogue {
  readonly llm: ScriptedLlm;
  readonly storage: Storage;
  readonly chat: Chat;
  /** Всё, что ушло в WhatsApp: адрес, текст, ID. */
  readonly sendText: Mock<ResponderConnection['sendText']>;
  readonly toClient: () => string[];
  readonly toManager: () => string[];
}

/** Диалог: клиент написал вопрос про 1С и цену; ждём, пока бот закончит (уведомление менеджеру и сообщение клиенту). */
async function runDialogue(script: LlmScript): Promise<Dialogue> {
  const config = configOfProject();
  const storage = storageOf(config);
  // Определение компании как в main: без INTERNAL_API_TOKEN выключено, но сервис один на конвейер и передачу.
  const company = assembleCompany({
    config,
    logger: SILENT_LOGGER,
    clock: CLOCK,
    repo: storage.chatCompanies,
  });
  const services = assembleServices({
    config,
    logger: SILENT_LOGGER,
    clock: CLOCK,
    storage,
    company: company.service,
  });
  const llm = scriptedLlm(script);
  const responder = await assembleResponder({
    config,
    logger: SILENT_LOGGER,
    clock: CLOCK,
    storage,
    services,
    company: company.service,
    createLlm: () => llm.llm,
  });
  if (responder === null) throw new Error('ответы не собраны');
  const sendText = vi.fn<ResponderConnection['sendText']>(() => Promise.resolve());
  let sent = 0;
  const link: ResponderConnection = {
    newMessageId: () => `OUT-${(sent += 1)}` as WaMessageId,
    sendText,
    setTyping: () => Promise.resolve(),
    markRead: () => Promise.resolve(),
    downloadAudio: () => Promise.reject(new Error('голосовых в тесте нет')),
  };
  services.connect(link);
  responder.connect(link);

  const message: InboundMessage = {
    waId: 'WA-1' as WaMessageId,
    identity: { replyJid: CLIENT_JID, lidJid: null, pnJid: CLIENT_JID },
    pushName: null,
    content: { kind: 'text', text: CLIENT_QUESTION },
    tsMs: Date.now(),
  };
  const chat = storage.chats.upsertByIdentity(message.identity, null, message.tsMs);
  storage.messages.insertIfNew({
    chatId: chat.id,
    waId: message.waId,
    author: 'client',
    kind: 'text',
    text: CLIENT_QUESTION,
    tsMs: message.tsMs,
  });
  responder.batcher.push(chat.id, message);
  await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(2));
  await responder.batcher.drain();
  await services.stop();

  const sentTo = (jid: Jid): string[] =>
    sendText.mock.calls.filter(([to]) => to === jid).map(([, text]) => text);
  return {
    llm,
    storage,
    chat,
    sendText,
    toClient: () => sentTo(CLIENT_JID),
    toManager: () => sentTo(MANAGER_JID),
  };
}

const HOT_REPLY = { outcome: 'hot', text: MODEL_TEXT, aboutPrice: true } as const;

/** Оценка интереса этого сообщения: минимум для передачи по цене собран, клиент спрашивает цену. */
const MINIMUM_COLLECTED: LlmScript['interests'] = [
  {
    profile: {
      area: '11 000 м²',
      scope: 'ввоз и вывоз',
      itemCount: 'около 20 000',
      has1C: true,
      problemAgreed: true,
      items: 'запчасти',
      packaging: null,
      material: 'металл',
      city: 'Алматы',
      premises: 'склад',
      turnover: null,
      currentTracking: null,
      monthlyIntake: null,
      passages: null,
      shelfRecount: null,
      inferred: [],
    },
    priceAsked: true,
  },
];

describe('диалог про 1С и цену (живой случай): Sonnet решает hot, проверки пройдены', () => {
  it('клиент получает ровно одно сообщение: ответ из знаний и фраза о передаче; текст тот же, что в ответе модели', async () => {
    const d = await runDialogue({
      replies: [HOT_REPLY],
      level: 'warm',
      interests: MINIMUM_COLLECTED,
    });

    expect(d.toClient()).toEqual([MODEL_TEXT]);
    expect(d.storage.messages.recent(d.chat.id, 10).filter((m) => m.author === 'bot')).toEqual([
      expect.objectContaining({ text: MODEL_TEXT }),
    ]);
  });

  it('передача с причиной hot, уровень hot в передаче и в чате, чат у менеджера', async () => {
    const d = await runDialogue({
      replies: [HOT_REPLY],
      level: 'warm',
      interests: MINIMUM_COLLECTED,
    });

    expect(d.storage.handoffs.findOpen(d.chat.id)).toMatchObject({ reason: 'hot', level: 'hot' });
    const chat = d.storage.chats.getById(d.chat.id);
    expect(chat?.level).toBe('hot');
    expect(chat?.control).toEqual({ status: 'manager', by: 'bot' });
  });

  it('уведомление менеджеру с причиной hot уходит до сообщения клиенту и записано в базу', async () => {
    const d = await runDialogue({
      replies: [HOT_REPLY],
      level: 'warm',
      interests: MINIMUM_COLLECTED,
    });

    const notice = d.toManager();
    expect(notice).toHaveLength(1);
    expect(notice[0]).toContain('Передача чата менеджеру: горячий клиент.');
    expect(notice[0]).toContain('Уровень интереса: горячий');
    expect(d.sendText.mock.calls.map(([jid]) => jid)).toEqual([MANAGER_JID, CLIENT_JID]);
    expect(d.storage.notifications.latestForChat(d.chat.id)).toMatchObject({
      kind: 'handoff',
      status: 'sent',
    });
  });

  it('вызовы: ответ, проверка и оценка на Sonnet (модели из config/models.json), проверка знает, что это сообщение о передаче', async () => {
    const d = await runDialogue({
      replies: [HOT_REPLY],
      level: 'warm',
      interests: MINIMUM_COLLECTED,
    });

    expect(d.llm.purposes()).toEqual(['reply', 'interest', 'review']);
    expect(d.llm.requests.map((request) => request.model)).toEqual([
      'claude-sonnet-5-5',
      'claude-sonnet-5-5',
      'claude-sonnet-5-5',
    ]);
    const review = d.llm.requests[2]?.turns.at(-1)?.text ?? '';
    expect(review).toContain(MODEL_TEXT);
    expect(review).toMatch(/сообщения о передаче чата коллеге/);
  });

  it('модель видит вопрос клиента и ответ про 1С в знаниях (раздел 9, вопрос 11)', async () => {
    const d = await runDialogue({
      replies: [HOT_REPLY],
      level: 'warm',
      interests: MINIMUM_COLLECTED,
    });

    const reply = d.llm.requests[0];
    expect(reply?.turns.at(-1)?.text).toContain(CLIENT_QUESTION);
    expect(reply?.system[0]?.text).toContain(KNOWLEDGE_ANSWER);
  });
});

describe('диалог про 1С и цену: проверка не пройдена', () => {
  it('проверка не пропустила дважды: причина всё равно hot, клиенту ровно одна фиксированная фраза передачи', async () => {
    const d = await runDialogue({
      replies: [HOT_REPLY],
      level: 'warm',
      interests: MINIMUM_COLLECTED,
      problems: ['Названы сроки, их нет в знаниях'],
    });

    expect(d.llm.purposes()).toEqual(['reply', 'interest', 'review', 'reply', 'review']);
    const toClient = d.toClient();
    expect(toClient).toHaveLength(1);
    expect(toClient[0]).toMatch(/Уточню у коллеги и вернусь к вам\.$/);
    expect(toClient[0]).not.toBe(MODEL_TEXT);
    expect(d.storage.handoffs.findOpen(d.chat.id)).toMatchObject({ reason: 'hot', level: 'hot' });
    expect(d.toManager()[0]).toContain('Передача чата менеджеру: горячий клиент.');
    expect(d.storage.chats.getById(d.chat.id)?.level).toBe('hot');
  });
});
