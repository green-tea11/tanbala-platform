import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Anthropic } from '@anthropic-ai/sdk';
import { expect, it, vi } from 'vitest';
import { normalizeDraft, runCodeChecks } from '../../src/checks/code-checks.js';
import { loadEnvironment } from '../../src/config/dotenv.js';
import { loadConfig } from '../../src/config/env.js';
import { createUnitOfWork } from '../../src/db/connection.js';
import { createBacklogRepo } from '../../src/db/repos/backlog.js';
import { createCallBudget } from '../../src/db/repos/call-budget.js';
import { createChatCompaniesRepo } from '../../src/db/repos/chat-companies.js';
import { createChatsRepo } from '../../src/db/repos/chats.js';
import { createHandoffsRepo } from '../../src/db/repos/handoffs.js';
import { createManagerNotificationsRepo } from '../../src/db/repos/manager-notifications.js';
import { createMessagesRepo } from '../../src/db/repos/messages.js';
import { createOutboundIdsRepo } from '../../src/db/repos/outbound-ids.js';
import { createRejectedDraftsRepo } from '../../src/db/repos/rejected-drafts.js';
import type {
  Clock,
  LlmClient,
  StructuredRequest,
  WhatsAppContacts,
} from '../../src/domain/ports.js';
import type {
  ChatId,
  ChatIdentity,
  InboundMessage,
  Jid,
  PhoneDigits,
  WaMessageId,
} from '../../src/domain/types.js';
import { createAnthropicLlm, type AnthropicLlmDeps } from '../../src/llm/anthropic.js';
import { assembleCompany } from '../../src/pipeline/company-setup.js';
import { assembleResponder, type ResponderConnection } from '../../src/pipeline/responder-setup.js';
import { assembleServices } from '../../src/pipeline/services.js';
import { createFakeLogger, type LogEntry } from '../helpers/fake-logger.js';
import { useMigratedDb } from '../unit/db/fixture.js';

// Живой прогон диалога: сборка как в main.ts, настоящие модели (ключ из .env), настоящие знания и внутренний API
// почтового проекта на 127.0.0.1 (если задан в .env). Поддельные только WhatsApp (отправленное копится) и часы
// (сон не ждёт). База своя, в памяти. Платный: запускать только вручную, см. vitest.live.config.ts.
// LIVE_DIALOG: JSON { "name": "...", "steps": [ { "say": "..." } | { "returnToBot": { "note": "..." | null } } ] }
// или клиент-модель: { "name": "...", "persona": "кто клиент и что он знает", "opening": "первое сообщение",
// "maxClientMessages": 8, "afterHandoff": [шаги как в steps; { "say": "<клиент>" } пишет клиент-модель] }:
// реплики клиента пишет SIMULATOR_MODEL по переписке, диалог идёт до передачи менеджеру или до maxClientMessages.
// LIVE_OUT: папка отчёта (report.md, calls.json). LIVE_ENV_ROOT: папка с .env (по умолчанию корень бота).

const ROOT = process.cwd();
const CLIENT_PHONE = '77000000002';
const CLIENT_JID = `${CLIENT_PHONE}@s.whatsapp.net` as Jid;
const MANAGER_PHONE = '77000000009';
const TURN_GAP_MS = 30_000;

// Цены за 1M токенов: вход, выход, запись кэша, чтение кэша (claude-api, 2026-10).
const PRICES: Record<string, readonly [number, number, number, number]> = {
  'claude-sonnet-5-5': [2, 10, 2.5, 0.2],
  'claude-haiku-5-5': [0.1, 0.5, 0.125, 0.01],
};

type Step = { readonly say: string } | { readonly returnToBot: { readonly note: string | null } };
interface Dialog {
  readonly name: string;
  readonly steps?: readonly Step[];
  readonly persona?: string;
  readonly opening?: string;
  readonly maxClientMessages?: number;
  readonly afterHandoff?: readonly Step[];
}

/** Модель, которая играет клиента: не бот, поэтому дешёвая. */
const SIMULATOR_MODEL = 'claude-haiku-5-5';

const SIMULATOR_SYSTEM = [
  'Ты играешь клиента, который пишет в WhatsApp компании Tanbala (учёт вещей на RFID-метках). Ты не ассистент и не бот.',
  'Пиши как живой человек в мессенджере: коротко, 1–2 предложения, без приветствий в каждом сообщении, можно без точек и с мелкими опечатками.',
  'Отвечай только на то, что спросили; факты бери из описания клиента; чего там нет, отвечай «не знаю» или коротко и правдоподобно.',
  'Если бот задаёт много вопросов подряд или повторяется, можешь показать лёгкое раздражение, как живой человек.',
  'Верни только текст следующего сообщения клиента, без кавычек и пояснений.',
].join('\n');

interface Call {
  readonly turn: number;
  readonly purpose: string;
  readonly model: string;
  readonly data: string;
  readonly ok: boolean;
  readonly value: unknown;
  readonly checks?: readonly unknown[];
}

interface Usage {
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

function costOf(usage: readonly Usage[]): number {
  return usage.reduce((sum, u) => {
    const price = PRICES[u.model];
    if (price === undefined) return sum;
    const [inp, out, write, read] = price;
    return sum + (u.input * inp + u.output * out + u.cacheWrite * write + u.cacheRead * read) / 1e6;
  }, 0);
}

function dataBlockOf(request: StructuredRequest<unknown>): string {
  const text = request.turns.at(-1)?.text ?? '';
  return /<данные>\n([\s\S]*)\n<\/данные>$/u.exec(text)?.[1] ?? '';
}

function clientTextOf(request: StructuredRequest<unknown>): string {
  return request.turns
    .filter((turn) => turn.role === 'user')
    .map((turn) => turn.text)
    .join('\n');
}

it('живой диалог', async () => {
  const dialogPath = process.env['LIVE_DIALOG'];
  const outDir = process.env['LIVE_OUT'];
  if (dialogPath === undefined || outDir === undefined)
    throw new Error('нужны LIVE_DIALOG и LIVE_OUT');
  const dialog = JSON.parse(readFileSync(dialogPath, 'utf8')) as Dialog;
  mkdirSync(outDir, { recursive: true });

  const envRoot = process.env['LIVE_ENV_ROOT'] ?? ROOT;
  const fileEnv = loadEnvironment(envRoot, {});
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const tokenLogPath = join(ROOT, 'data', 'live-token-usage.jsonl');
  const env = {
    ...fileEnv,
    TEST_MODE: 'true',
    TEST_ALLOWLIST: CLIENT_PHONE,
    MANAGER_WHATSAPP: MANAGER_PHONE,
    TOKEN_LOG_PATH: tokenLogPath,
  };
  const models: unknown = JSON.parse(readFileSync(join(ROOT, 'config', 'models.json'), 'utf8'));
  const config = loadConfig(env, models, ROOT).config;

  const logs: LogEntry[] = [];
  const logger = createFakeLogger(logs);
  let nowMs = Date.now();
  const clock: Clock = { now: () => nowMs, sleep: () => Promise.resolve() };
  const db = useMigratedDb();
  const storage = {
    chats: createChatsRepo(db),
    messages: createMessagesRepo(db),
    outboundIds: createOutboundIdsRepo(db),
    budget: createCallBudget(db, config.limits),
    backlog: createBacklogRepo(db),
    handoffs: createHandoffsRepo(db),
    notifications: createManagerNotificationsRepo(db),
    unitOfWork: createUnitOfWork(db),
    chatCompanies: createChatCompaniesRepo(db, logger),
    rejectedDrafts: createRejectedDraftsRepo(db),
  };
  const company = assembleCompany({
    config,
    logger,
    clock,
    repo: storage.chatCompanies,
    fetch: globalThis.fetch,
  });
  const services = assembleServices({ config, logger, clock, storage, company: company.service });
  const sendText = vi.fn<ResponderConnection['sendText']>(() => Promise.resolve());
  let sent = 0;
  const link: ResponderConnection = {
    newMessageId: () => `OUT-${(sent += 1)}` as WaMessageId,
    sendText,
    setTyping: () => Promise.resolve(),
    markRead: () => Promise.resolve(),
    downloadAudio: () => Promise.reject(new Error('голосовых нет')),
  };
  services.connect(link);
  const contacts: WhatsAppContacts = {
    businessProfile: () => Promise.resolve({ kind: 'personal' }),
    profilePhoto: () => Promise.resolve(null),
  } as unknown as WhatsAppContacts;
  company.connect(contacts);

  const calls: Call[] = [];
  const usage: Usage[] = [];
  let turn = 0;
  const createLlm = (deps: AnthropicLlmDeps): LlmClient => {
    const tokenLog = {
      record: async (entry: Parameters<AnthropicLlmDeps['tokenLog']['record']>[0]) => {
        const e = entry as unknown as Usage;
        usage.push({
          model: e.model,
          input: e.input,
          output: e.output,
          cacheRead: e.cacheRead,
          cacheWrite: e.cacheWrite,
        });
        await deps.tokenLog.record(entry);
      },
    };
    const real = createAnthropicLlm({ ...deps, tokenLog });
    return {
      structured: async <T>(request: StructuredRequest<T>) => {
        const result = await real.structured(request);
        const value = result.ok ? result.value : result;
        const text = (value as { text?: unknown } | null)?.text;
        const checks =
          request.purpose === 'reply' && typeof text === 'string'
            ? runCodeChecks(normalizeDraft(text), {
                ownPhone: CLIENT_PHONE as PhoneDigits,
                clientText: clientTextOf(request),
              })
            : undefined;
        calls.push({
          turn,
          purpose: request.purpose,
          model: request.model,
          data: dataBlockOf(request),
          ok: result.ok,
          value,
          ...(checks === undefined ? {} : { checks }),
        });
        return result;
      },
    };
  };
  // drain() у очереди склейки означает остановку: на каждую реплику своя сборка ответов, база и службы общие.
  const responderOf = async () => {
    const responder = await assembleResponder({
      config,
      logger,
      clock,
      storage,
      services,
      company: company.service,
      createLlm,
    });
    if (responder === null) throw new Error('ответы не собраны');
    company.useLogo(responder.logo);
    responder.connect(link);
    return responder;
  };

  const identity: ChatIdentity = { replyJid: CLIENT_JID, lidJid: null, pnJid: CLIENT_JID };
  let chatId: ChatId | null = null;
  const lines: string[] = [`# ${dialog.name}`, ''];
  /** Переписка глазами клиента: только сообщения клиента и бота. */
  const transcript: string[] = [];
  let clientMessages = 0;
  let simulatorCalls = 0;

  const runStep = async (step: Step): Promise<void> => {
    turn += 1;
    const markSent = sendText.mock.calls.length;
    const markLogs = logs.length;
    const responder = await responderOf();
    if ('say' in step) {
      clientMessages += 1;
      lines.push(`## ${turn}. Клиент: ${step.say}`, '');
      transcript.push(`Клиент: ${step.say}`);
      const message: InboundMessage = {
        waId: `WA-${turn}` as WaMessageId,
        identity,
        pushName: 'Тест',
        content: { kind: 'text', text: step.say },
        tsMs: nowMs,
      };
      const chat = storage.chats.upsertByIdentity(identity, 'Тест', nowMs);
      chatId = chat.id;
      storage.messages.insertIfNew({
        chatId,
        waId: message.waId,
        author: 'client',
        kind: 'text',
        text: step.say,
        tsMs: nowMs,
      });
      responder.batcher.push(chatId, message);
      await responder.batcher.drain();
    } else {
      if (chatId === null) throw new Error('возврат до первого сообщения');
      const note = step.returnToBot.note;
      lines.push(`## ${turn}. Менеджер: «Вернуть боту»${note ? ` с заметкой «${note}»` : ''}`, '');
      transcript.push(`(менеджер вернул чат боту${note ? `, заметка: ${note}` : ''})`);
      await services.handoff.returnToBot(chatId, note);
      responder.resume(chatId);
      await responder.batcher.drain();
    }
    for (const call of calls.filter((c) => c.turn === turn)) {
      lines.push(`- **${call.purpose}** (${call.model})${call.ok ? '' : ' СБОЙ'}:`);
      lines.push('```json', JSON.stringify(call.value, null, 1), '```');
      if (call.checks !== undefined && call.checks.length > 0) {
        lines.push(`  проверка кодом: ${JSON.stringify(call.checks)}`);
      }
    }
    for (const log of logs.slice(markLogs))
      lines.push(`- лог ${log.level}: ${log.message} ${JSON.stringify(log.context).slice(0, 300)}`);
    for (const [to, body] of sendText.mock.calls.slice(markSent)) {
      const toClient = to === CLIENT_JID;
      lines.push(`- **→ ${toClient ? 'клиенту' : 'менеджеру'}:** ${body}`);
      transcript.push(toClient ? `Бот: ${body}` : '(уведомление менеджеру)');
    }
    lines.push('');
    nowMs += TURN_GAP_MS;
  };

  const withManager = (): boolean =>
    chatId !== null &&
    (db.prepare('SELECT status FROM chats WHERE id = ?').get(chatId) as { status: string } | undefined)
      ?.status === 'manager';

  const simulator = new Anthropic({ apiKey: String(fileEnv['VENMART_ANTHROPIC_KEY'] ?? '') });
  const nextClientMessage = async (persona: string): Promise<string> => {
    const response = await simulator.messages.create({
      model: SIMULATOR_MODEL,
      max_tokens: 1024,
      system: SIMULATOR_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Кто ты (клиент):\n${persona}\n\nПереписка до сих пор:\n${transcript.join('\n')}\n\nНапиши следующее сообщение клиента.`,
        },
      ],
    });
    const u = response.usage;
    usage.push({
      model: SIMULATOR_MODEL,
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    });
    simulatorCalls += 1;
    const text = response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join(' ')
      .trim();
    return text === '' ? 'ок' : text;
  };

  if (dialog.persona !== undefined) {
    const persona = dialog.persona;
    const max = dialog.maxClientMessages ?? 8;
    await runStep({ say: dialog.opening ?? 'Здравствуйте' });
    while (!withManager() && clientMessages < max) {
      await runStep({ say: await nextClientMessage(persona) });
    }
    for (const step of dialog.afterHandoff ?? []) {
      const live = 'say' in step && step.say === '<клиент>';
      await runStep(live ? { say: await nextClientMessage(persona) } : step);
    }
  } else {
    for (const step of dialog.steps ?? []) await runStep(step);
  }
  const notes = db.prepare('SELECT text FROM manager_notifications ORDER BY id').all() as {
    text: string;
  }[];
  if (notes.length > 0)
    lines.push('## Уведомления менеджеру', '', ...notes.map((n) => '```\n' + n.text + '\n```'), '');
  const rejected = db.prepare('SELECT * FROM rejected_drafts ORDER BY id').all();
  if (rejected.length > 0)
    lines.push(
      '## Отклонённые черновики',
      '',
      '```json',
      JSON.stringify(rejected, null, 1),
      '```',
      '',
    );
  const profiles = db.prepare('SELECT * FROM client_profiles').all();
  lines.push('## Выжимка в базе', '', '```json', JSON.stringify(profiles, null, 1), '```', '');
  const total = costOf(usage);
  const botCost = costOf(usage.filter((u, i) => u.model !== SIMULATOR_MODEL || i < 0));
  lines.push(`## Расход: $${total.toFixed(4)}, вызовов ${usage.length} (из них клиент-модель ${simulatorCalls})`);
  writeFileSync(join(outDir, 'report.md'), lines.join('\n'), 'utf8');
  writeFileSync(
    join(outDir, 'chat.md'),
    [
      `# ${dialog.name}`,
      '',
      ...transcript.map((line) => `${line}\n`),
      `Сообщений клиента: ${clientMessages}. Передан менеджеру: ${withManager() ? 'да' : 'нет'}.`,
      `Расход бота: $${botCost.toFixed(4)}, всего вместе с клиентом-моделью: $${total.toFixed(4)}.`,
      '',
      ...notes.map((n) => '```\n' + n.text + '\n```'),
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(outDir, 'calls.json'),
    JSON.stringify({ calls, usage, total }, null, 1),
    'utf8',
  );
  await services.stop();
  expect(calls.length).toBeGreaterThan(0);
});
