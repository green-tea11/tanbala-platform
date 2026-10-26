import { describe, expect, it, vi, type Mock } from 'vitest';
import type { ConversationContext } from '../../../src/agent/agent.js';
import type { Clock, Logger, Transcriber } from '../../../src/domain/ports.js';
import type {
  AudioClip,
  Chat,
  ChatId,
  ClientProfile,
  HandoffNotice,
  InboundMessage,
  Jid,
  LlmResult,
  MediaRef,
  MessageContent,
  PhoneDigits,
  ReplyDraft,
  StoredMessage,
  WaMessageId,
} from '../../../src/domain/types.js';
import type { SendBlocked } from '../../../src/messaging/outbox.js';
import type { ClientBatch } from '../../../src/pipeline/batcher.js';
import {
  handleClientBatch,
  SEND_RETRY_DELAY_MS,
  type PipelineDeps,
  type PipelineOutcome,
} from '../../../src/pipeline/handle-inbound.js';
import { MAX_AUDIO_BYTES } from '../../../src/voice/transcriber.js';

// Все зависимости поддельные: шаги конвейера пишутся в общий журнал calls, по нему видно порядок.

const NOW = Date.UTC(2026, 9, 26, 9, 0, 0);
const CHAT_ID = 7 as ChatId;
const PHONE = '77000000002' as PhoneDigits;
const JID = `${PHONE}@s.whatsapp.net` as Jid;
const ALLOWLIST: ReadonlySet<PhoneDigits> = new Set([PHONE]);
const ANSWER = 'Учёт подбираем под задачу. Что вы храните?';
const MIME = 'audio/ogg; codecs=opus';
const TYPING_MS = 1200;
const EMPTY_PROFILE: ClientProfile = {
  business: null,
  area: null,
  scope: null,
  itemCount: null,
  has1C: null,
  problem: null,
  specifics: null,
};
const HISTORY: readonly StoredMessage[] = [
  { id: 1, chatId: CHAT_ID, author: 'client', kind: 'text', text: 'Сколько стоит?', tsMs: NOW },
];

type Status = 'bot' | 'manager';

function chatWith(status: Status): Chat {
  return {
    id: CHAT_ID,
    identity: { replyJid: JID, lidJid: null, pnJid: JID },
    pushName: null,
    control: status === 'bot' ? { status: 'bot', by: null } : { status: 'manager', by: 'phone' },
    level: 'cold',
    profile: EMPTY_PROFILE,
  };
}

function text(id: string, tsMs = NOW): InboundMessage {
  return message(id, { kind: 'text', text: 'Сколько стоит?' }, tsMs);
}

function voice(id: string, tsMs = NOW): InboundMessage {
  return message(id, { kind: 'voice', media: id as MediaRef, mimeType: MIME, seconds: 3 }, tsMs);
}

function picture(id: string): InboundMessage {
  return message(id, { kind: 'other' }, NOW);
}

function message(id: string, content: MessageContent, tsMs: number): InboundMessage {
  return {
    waId: id as WaMessageId,
    identity: { replyJid: JID, lidJid: null, pnJid: JID },
    pushName: null,
    content,
    tsMs,
  };
}

function answer(value: string = ANSWER): LlmResult<ReplyDraft> {
  return { ok: true, value: { outcome: 'answer', text: value } };
}

/** Шаг, во время которого человек подключается к чату: статус меняется на manager. */
type JoinStep = 'transcribe' | 'read' | 'draft';

interface Options {
  /** Статус чата с этим ID в начале; null: чата с таким ID нет (слит с другим). */
  readonly status?: Status | null;
  readonly joinOn?: JoinStep;
  readonly drafts?: readonly LlmResult<ReplyDraft>[];
  readonly transcriber?: Transcriber;
  readonly testAllowlist?: ReadonlySet<PhoneDigits> | null;
  readonly found?: Chat | null;
  /** Что вернёт setTranscript: записалась ли расшифровка. */
  readonly transcriptSaved?: boolean;
}

type Mocked<K extends keyof PipelineDeps> = {
  readonly [M in keyof PipelineDeps[K]]: PipelineDeps[K][M] extends (...args: never[]) => unknown
    ? Mock<PipelineDeps[K][M]>
    : never;
};

interface Harness {
  readonly deps: PipelineDeps;
  readonly calls: string[];
  readonly logs: { readonly level: string; readonly context: unknown }[];
  readonly contexts: ConversationContext[];
  readonly outbox: Mocked<'outbox'>;
  readonly inbox: Mocked<'inbox'>;
  readonly setTyping: Mock<PipelineDeps['typing']['setTyping']>;
}

function createLogger(logs: Harness['logs']): Logger {
  const log =
    (level: string) =>
    (context: Readonly<Record<string, unknown>>): void => {
      logs.push({ level, context });
    };
  const logger: Logger = {
    level: 'info',
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    fatal: log('fatal'),
    silent: log('silent'),
    child: () => logger,
  };
  return logger;
}

function setup(options: Options = {}): Harness {
  const calls: string[] = [];
  const logs: Harness['logs'] = [];
  const contexts: ConversationContext[] = [];
  const drafts = [...(options.drafts ?? [answer()])];
  let status = options.status === undefined ? 'bot' : options.status;
  const join = (step: JoinStep): void => {
    if (options.joinOn === step) status = 'manager';
  };
  const outbox: Mocked<'outbox'> = {
    sendBotReply: vi.fn((_chat, reply, replyTo) => {
      calls.push(`reply:${reply}:${replyTo}`);
      return Promise.resolve('sent' as const);
    }),
    sendHandoffNotice: vi.fn((_chat, notice: HandoffNotice, replyTo) => {
      calls.push(`notice:${JSON.stringify(notice)}:${replyTo}`);
      return Promise.resolve('sent' as const);
    }),
    sendVoiceNotice: vi.fn((_chat, replyTo) => {
      calls.push(`voice:${replyTo}`);
      return Promise.resolve('sent' as const);
    }),
  };
  const inbox: Mocked<'inbox'> = {
    markRead: vi.fn((_jid, ids) => {
      calls.push(`read:${ids.join(',')}`);
      join('read');
      return Promise.resolve();
    }),
    downloadAudio: vi.fn((media) => {
      calls.push(`download:${media}`);
      join('transcribe');
      return Promise.resolve<AudioClip>({ data: new Uint8Array([1, 2, 3]), mimeType: MIME });
    }),
  };
  const setTyping = vi.fn<PipelineDeps['typing']['setTyping']>((_jid, on) => {
    calls.push(`typing:${on ? 'on' : 'off'}`);
    return Promise.resolve();
  });
  const clock: Clock = {
    now: () => NOW,
    sleep: (ms) => {
      calls.push(`sleep:${ms}`);
      return Promise.resolve();
    },
  };
  const deps: PipelineDeps = {
    chats: {
      getById: (id) => {
        if (id !== CHAT_ID) return options.found?.id === id ? options.found : null;
        return status === null ? null : chatWith(status);
      },
      findByJid: () => options.found ?? null,
      setStatus: (_id, change) => {
        calls.push(`status:${change.status}:${change.by}`);
      },
    },
    messages: {
      recent: () => HISTORY,
      markAnswered: (_id, upTo) => {
        calls.push(`answered:${upTo}`);
      },
      setTranscript: (_id, waId, transcript) => {
        calls.push(`transcript:${waId}:${transcript}`);
        return options.transcriptSaved ?? true;
      },
    },
    agent: {
      draftReply: (context) => {
        calls.push('draft');
        contexts.push(context);
        join('draft');
        const next = drafts.length > 1 ? drafts.shift() : drafts[0];
        return Promise.resolve(next ?? answer());
      },
    },
    outbox,
    transcriber: options.transcriber ?? { enabled: false },
    inbox,
    typing: { setTyping },
    typingDelayMs: (draft) => (draft === ANSWER ? TYPING_MS : TYPING_MS + 1),
    testAllowlist: options.testAllowlist === undefined ? ALLOWLIST : options.testAllowlist,
    clock,
    logger: createLogger(logs),
  };
  return { deps, calls, logs, contexts, outbox, inbox, setTyping };
}

function batchOf(
  messages: readonly InboundMessage[],
  newer: readonly (readonly InboundMessage[])[] = [],
): ClientBatch {
  const queue = [...newer];
  return { chatId: CHAT_ID, messages, takeNewer: () => queue.shift() ?? [] };
}

function run(h: Harness, batch: ClientBatch): Promise<PipelineOutcome> {
  return handleClientBatch(h.deps, batch);
}

function levels(h: Harness, level: string): unknown[] {
  return h.logs.filter((entry) => entry.level === level).map((entry) => entry.context);
}

const TYPING_STEPS = ['typing:on', `sleep:${TYPING_MS}`, 'typing:off'];

/** Шаги ответа после черновика: «печатает», ответ, «отвечено». */
const SEND_STEPS = (replyTo: string): string[] => [
  ...TYPING_STEPS,
  `reply:${ANSWER}:${replyTo}`,
  `answered:${replyTo}`,
];

const REPLY_STEPS = (replyTo: string): string[] => ['draft', ...SEND_STEPS(replyTo)];

describe('pipeline/handle-inbound: статус, закрытый режим и пустые пачки', () => {
  it('чат ведёт менеджер: бот молчит, не отмечает прочитанным и не зовёт LLM', async () => {
    const h = setup({ status: 'manager' });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(h.calls).toEqual([]);
  });

  it('чата с этим ID нет (слит с другим): ищется по адресу; не нашёлся => молчит', async () => {
    const survivor: Chat = { ...chatWith('bot'), id: 9 as ChatId };
    const found = setup({ status: null, found: survivor });
    const lost = setup({ status: null, found: null });

    await expect(run(found, batchOf([text('A1')]))).resolves.toEqual({ kind: 'replied' });
    expect(found.outbox.sendBotReply).toHaveBeenCalledWith(survivor.id, ANSWER, 'A1');
    await expect(run(lost, batchOf([text('A1')]))).resolves.toEqual({
      kind: 'silent',
      reason: 'no_chat',
    });
    expect(lost.calls).toEqual([]);
  });

  it.each<[string, ReadonlySet<PhoneDigits>, Chat]>([
    ['номер не из списка', new Set(['77000000009' as PhoneDigits]), chatWith('bot')],
    [
      'только @lid, номер неизвестен',
      ALLOWLIST,
      { ...chatWith('bot'), identity: { replyJid: JID, lidJid: JID, pnJid: null } },
    ],
  ])(
    'закрытый режим (%s): до оплачиваемых вызовов отказ, без расшифровки, прочтения и LLM',
    async (_case, testAllowlist, chat) => {
      const h = setup({ status: null, found: chat, testAllowlist });

      const outcome = await run(h, batchOf([voice('V1'), text('A1')]));

      expect(outcome).toEqual({ kind: 'blocked', reason: 'skipped_test_mode' });
      expect(h.calls).toEqual([]);
    },
  );

  it('пачка без текста и голосовых (картинка) или пустая: без LLM и без отметки прочтения', async () => {
    const h = setup();

    await expect(run(h, batchOf([picture('P1')]))).resolves.toEqual({
      kind: 'silent',
      reason: 'no_text',
    });
    await expect(run(h, batchOf([]))).resolves.toEqual({ kind: 'silent', reason: 'no_text' });
    expect(h.calls).toEqual([]);
  });

  it.each<[JoinStep, string[]]>([
    ['read', ['read:A1']],
    ['draft', ['read:A1', 'draft']],
  ])('человек подключился (шаг %s): статус перечитан, дальше бот молчит', async (joinOn, steps) => {
    const h = setup({ joinOn });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(h.calls).toEqual(steps);
  });
});

describe('pipeline/handle-inbound: ответ', () => {
  it('answer: прочтение, «печатает» с паузой по тексту, ответ на последнее сообщение, «отвечено»', async () => {
    const h = setup();

    const outcome = await run(h, batchOf([text('A1'), picture('P2')]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.calls).toEqual(['read:A1,P2', ...REPLY_STEPS('P2')]);
    expect(h.contexts).toEqual([{ chatId: CHAT_ID, history: HISTORY, profile: EMPTY_PROFILE }]);
    expect(h.logs).toContainEqual({
      level: 'info',
      context: { chatId: CHAT_ID, outcome: 'replied' },
    });
  });

  it('новые сообщения, пока писался черновик: перегенерация один раз, без «печатает» для старого', async () => {
    const h = setup({ drafts: [answer('Первый черновик'), answer()] });

    const outcome = await run(h, batchOf([text('A1')], [[text('A2')], [text('A3')]]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.calls).toEqual(['read:A1', 'draft', 'read:A2', ...REPLY_STEPS('A2')]);
    expect(h.outbox.sendBotReply).toHaveBeenCalledTimes(1);
  });

  it('новое сообщение во время «печатает»: черновик перегенерируется, уходит один ответ', async () => {
    const h = setup({ drafts: [answer('Первый черновик'), answer()] });

    const outcome = await run(h, batchOf([text('A1')], [[], [text('A2')]]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.calls).toEqual([
      'read:A1',
      'draft',
      'typing:on',
      `sleep:${TYPING_MS + 1}`,
      'typing:off',
      'read:A2',
      ...REPLY_STEPS('A2'),
    ]);
  });

  it.each<[string, Awaited<ReturnType<PipelineDeps['outbox']['sendBotReply']>>, PipelineOutcome]>([
    ['уже отвечено', 'skipped_no_inbound', { kind: 'silent', reason: 'duplicate' }],
    ['чат у менеджера', 'skipped_manager', { kind: 'silent', reason: 'manager_mode' }],
    [
      'лимит исходящих',
      'skipped_limit' satisfies SendBlocked,
      { kind: 'blocked', reason: 'skipped_limit' },
    ],
  ])('outbox не отправил (%s): итог без «отвечено»', async (_case, result, expected) => {
    const h = setup();
    h.outbox.sendBotReply.mockResolvedValue(result);

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual(expected);
    expect(h.calls).not.toContain('answered:A1');
  });

  it('без закрытого режима непроверенный ответ не уходит: передача check_failed', async () => {
    const h = setup({ testAllowlist: null });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'handed_off', reason: 'check_failed' });
    expect(h.calls).toEqual([
      'read:A1',
      'draft',
      'status:manager:bot',
      'notice:{"reason":"check_failed"}:A1',
      'answered:A1',
    ]);
  });

  it('сбой отметки прочтения и «печатает» не мешает ответу: пишется в лог', async () => {
    const h = setup();
    h.inbox.markRead.mockRejectedValue(new Error('сокет закрыт'));
    h.setTyping.mockRejectedValue(new Error('сокет закрыт'));

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.outbox.sendBotReply).toHaveBeenCalledTimes(1);
    expect(levels(h, 'warn')).toHaveLength(3);
  });

  it('пауза прервана (остановка): «печатает» снимается, ответ не уходит, сбой наружу', async () => {
    const h = setup();
    h.deps.clock.sleep = () => Promise.reject(new Error('Пауза прервана'));

    await expect(run(h, batchOf([text('A1')]))).rejects.toThrow('Пауза прервана');

    expect(h.calls).toEqual(['read:A1', 'draft', 'typing:on', 'typing:off']);
  });
});

describe('pipeline/handle-inbound: сбой отправки исключением', () => {
  it('ответ не ушёл (сокет закрыт при переподключении): один повтор после паузы', async () => {
    const h = setup();
    h.outbox.sendBotReply.mockRejectedValueOnce(new Error('Connection Closed'));

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.outbox.sendBotReply).toHaveBeenCalledTimes(2);
    expect(h.calls).toContain(`sleep:${SEND_RETRY_DELAY_MS}`);
    expect(h.calls).toContain('answered:A1');
  });

  it('и повтор не ушёл: клиент остался без ответа, ошибка в лог без номера и текста', async () => {
    const h = setup();
    h.outbox.sendBotReply.mockRejectedValue(new Error('Connection Closed'));

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'send_failed' });
    expect(h.outbox.sendBotReply).toHaveBeenCalledTimes(2);
    expect(levels(h, 'error')).toEqual([{ chatId: CHAT_ID, errorName: 'Error' }]);
    expect(h.calls).not.toContain('answered:A1');
  });

  it('фраза передачи не ушла: чат у менеджера, это видно в логе ошибкой', async () => {
    const h = setup({ drafts: [{ ok: true, value: { outcome: 'asked_human' } }] });
    h.outbox.sendHandoffNotice.mockRejectedValue(new Error('Connection Closed'));

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'handed_off', reason: 'asked_human' });
    expect(h.calls).toContain('status:manager:bot');
    expect(levels(h, 'error')).toEqual([{ chatId: CHAT_ID, errorName: 'Error' }]);
  });

  it('фраза про голосовое не ушла: клиент остался без ответа', async () => {
    const h = setup();
    h.outbox.sendVoiceNotice.mockRejectedValue(new Error('Connection Closed'));

    const outcome = await run(h, batchOf([voice('V1')]));

    expect(outcome).toEqual({ kind: 'send_failed' });
    expect(levels(h, 'error')).toHaveLength(1);
  });
});

describe('pipeline/handle-inbound: передача менеджеру', () => {
  it.each<[string, ReplyDraft, string]>([
    ['нет ответа в знаниях', { outcome: 'no_answer' }, '{"reason":"no_answer"}'],
    ['просит человека', { outcome: 'asked_human' }, '{"reason":"asked_human"}'],
    [
      'жалоба с просьбой не писать',
      { outcome: 'complaint', stopRequested: true },
      '{"reason":"complaint","stopRequested":true}',
    ],
  ])(
    '%s: статус manager (бот), фраза по причине на последнее сообщение',
    async (_case, draft, notice) => {
      const h = setup({ drafts: [{ ok: true, value: draft }] });

      const outcome = await run(h, batchOf([text('A1'), text('A2')]));

      expect(outcome).toEqual({ kind: 'handed_off', reason: draft.outcome });
      expect(h.calls).toEqual([
        'read:A1,A2',
        'draft',
        'status:manager:bot',
        `notice:${notice}:A2`,
        'answered:A2',
      ]);
    },
  );

  it('дневной лимит API: статус manager без фразы клиенту', async () => {
    const h = setup({ drafts: [{ ok: false, failure: 'budget_exceeded', scope: 'chat' }] });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'handed_off', reason: 'limit' });
    expect(h.calls).toEqual(['read:A1', 'draft', 'status:manager:bot']);
    expect(levels(h, 'warn')).toContainEqual({ chatId: CHAT_ID, scope: 'chat' });
  });

  it.each(['unavailable', 'invalid_output', 'refusal'] as const)(
    'сбой LLM (%s): статус manager и фраза «передам вопрос специалисту»',
    async (failure) => {
      const h = setup({ drafts: [{ ok: false, failure }] });

      const outcome = await run(h, batchOf([text('A1')]));

      expect(outcome).toEqual({ kind: 'handed_off', reason: 'llm_error' });
      expect(h.calls).toEqual([
        'read:A1',
        'draft',
        'status:manager:bot',
        'notice:{"reason":"llm_error"}:A1',
        'answered:A1',
      ]);
      expect(levels(h, 'warn')).toContainEqual({ chatId: CHAT_ID, failure });
    },
  );

  it.each<[string, LlmResult<ReplyDraft>]>([
    ['нет ответа', { ok: true, value: { outcome: 'no_answer' } }],
    ['лимит', { ok: false, failure: 'budget_exceeded', scope: 'global' }],
  ])(
    'чат ушёл менеджеру, пока шёл вызов LLM (%s): статус не перезаписан, фразы нет',
    async (_case, draft) => {
      const h = setup({ joinOn: 'draft', drafts: [draft] });

      const outcome = await run(h, batchOf([text('A1')]));

      expect(outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
      expect(h.calls).toEqual(['read:A1', 'draft']);
    },
  );

  it('фраза передачи не ушла: статус всё равно manager, «отвечено» не ставится', async () => {
    const h = setup({ drafts: [{ ok: true, value: { outcome: 'asked_human' } }] });
    h.outbox.sendHandoffNotice.mockResolvedValue('skipped_test_mode');

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'handed_off', reason: 'asked_human' });
    expect(h.calls).toEqual(['read:A1', 'draft', 'status:manager:bot']);
  });
});

describe('pipeline/handle-inbound: голосовые', () => {
  type Transcribe = (clip: AudioClip, chatId: ChatId) => Promise<LlmResult<string>>;

  function transcriber(result: LlmResult<string> | Error): {
    readonly enabled: true;
    readonly transcribe: Mock<Transcribe>;
  } {
    return {
      enabled: true,
      transcribe: vi.fn<Transcribe>((clip, chatId) => {
        expect(clip.mimeType).toBe(MIME);
        expect(chatId).toBe(CHAT_ID);
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      }),
    };
  }

  it('расшифровка выключена, только голосовые: одна фраза на пачку, LLM не зовётся', async () => {
    const h = setup();

    const outcome = await run(h, batchOf([voice('V1'), voice('V2')]));

    expect(outcome).toEqual({ kind: 'voice_notice' });
    expect(h.calls).toEqual(['read:V1,V2', 'voice:V2', 'answered:V2']);
  });

  it('живая пачка с текстом и голосовым: черновик answer => фраза про голосовое, потом ответ', async () => {
    const h = setup();

    const outcome = await run(h, batchOf([text('T1'), voice('V1')]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.calls).toEqual(['read:T1,V1', 'draft', 'voice:V1', ...SEND_STEPS('V1')]);
  });

  it.each<[string, LlmResult<ReplyDraft>]>([
    ['нет ответа', { ok: true, value: { outcome: 'no_answer' } }],
    [
      'жалоба, просит не писать',
      { ok: true, value: { outcome: 'complaint', stopRequested: true } },
    ],
    ['сбой LLM', { ok: false, failure: 'unavailable' }],
  ])(
    'пачка с текстом и голосовым, черновик не answer (%s): фразы про голосовое нет',
    async (_case, draft) => {
      const h = setup({ drafts: [draft] });

      const outcome = await run(h, batchOf([text('T1'), voice('V1')]));

      expect(outcome).toMatchObject({ kind: 'handed_off' });
      expect(h.outbox.sendVoiceNotice).not.toHaveBeenCalled();
    },
  );

  it('пачка простоя (сообщения старше двух минут) с текстом: один ответ, без фразы про голосовое', async () => {
    const old = NOW - 3 * 60_000;
    const h = setup();

    const outcome = await run(h, batchOf([voice('V1', old), text('T1', old + 1)]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.outbox.sendVoiceNotice).not.toHaveBeenCalled();
  });

  it('фраза про голосовое: outbox ответил «чат у менеджера» => ответа нет', async () => {
    const h = setup();
    h.outbox.sendVoiceNotice.mockResolvedValue('skipped_manager');

    const outcome = await run(h, batchOf([text('T1'), voice('V1')]));

    expect(outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(h.outbox.sendBotReply).not.toHaveBeenCalled();
  });

  it('только голосовое: человек подключился во время прочтения => фразы нет', async () => {
    const h = setup({ joinOn: 'read' });

    const outcome = await run(h, batchOf([voice('V1')]));

    expect(outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(h.outbox.sendVoiceNotice).not.toHaveBeenCalled();
  });

  it('на голосовое уже ответили: фраза не ушла, «отвечено» не ставится', async () => {
    const h = setup();
    h.outbox.sendVoiceNotice.mockResolvedValue('skipped_no_inbound');

    const outcome = await run(h, batchOf([voice('V1')]));

    expect(outcome).toEqual({ kind: 'silent', reason: 'duplicate' });
    expect(h.outbox.sendVoiceNotice).toHaveBeenCalledWith(CHAT_ID, 'V1');
    expect(h.calls).toEqual(['read:V1']);
  });

  it.each([true, false])(
    'расшифровка (записана: %s): скачана с лимитом, сохранена в базе до черновика, история из базы',
    async (saved) => {
      const voiceOnly = transcriber({ ok: true, value: '  Сколько стоит учёт склада?  ' });
      const h = setup({ transcriber: voiceOnly, transcriptSaved: saved });

      const outcome = await run(h, batchOf([voice('V1')]));

      expect(outcome).toEqual({ kind: 'replied' });
      expect(h.inbox.downloadAudio).toHaveBeenCalledWith('V1', MAX_AUDIO_BYTES);
      expect(h.calls).toEqual([
        'download:V1',
        'transcript:V1:Сколько стоит учёт склада?',
        'read:V1',
        ...REPLY_STEPS('V1'),
      ]);
      expect(h.contexts[0]?.history).toBe(HISTORY);
      expect(levels(h, 'warn')).toHaveLength(saved ? 0 : 1);
    },
  );

  it('человек подключился во время расшифровки: ни прочтения, ни LLM', async () => {
    const h = setup({
      transcriber: transcriber({ ok: true, value: 'Здравствуйте' }),
      joinOn: 'transcribe',
    });

    const outcome = await run(h, batchOf([voice('V1')]));

    expect(outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(h.calls).toEqual(['download:V1', 'transcript:V1:Здравствуйте']);
  });

  it.each<[string, LlmResult<string> | Error]>([
    ['сбой расшифровки', { ok: false, failure: 'unavailable' }],
    ['пустая расшифровка', { ok: true, value: '   ' }],
    ['исключение расшифровки', new Error('сеть')],
  ])('%s: фраза про голосовое', async (_case, result) => {
    const h = setup({ transcriber: transcriber(result) });

    const outcome = await run(h, batchOf([voice('V1')]));

    expect(outcome).toEqual({ kind: 'voice_notice' });
    expect(h.calls).toEqual(['download:V1', 'read:V1', 'voice:V1', 'answered:V1']);
  });

  it('голосовое не скачалось (нет в памяти): фраза про голосовое, расшифровки нет', async () => {
    const voiceOnly = transcriber({ ok: true, value: 'текст' });
    const h = setup({ transcriber: voiceOnly });
    h.inbox.downloadAudio.mockRejectedValue(new Error('Голосовое не найдено в памяти'));

    const outcome = await run(h, batchOf([voice('V1')]));

    expect(outcome).toEqual({ kind: 'voice_notice' });
    expect(voiceOnly.transcribe).not.toHaveBeenCalled();
  });

  it('лимит на расшифровке: статус manager без фразы, LLM не зовётся', async () => {
    const h = setup({
      transcriber: transcriber({ ok: false, failure: 'budget_exceeded', scope: 'global' }),
    });

    const outcome = await run(h, batchOf([text('T1'), voice('V1')]));

    expect(outcome).toEqual({ kind: 'handed_off', reason: 'limit' });
    expect(h.calls).toEqual(['download:V1', 'status:manager:bot']);
  });

  it('перегенерация: уже расшифрованное не расшифровывается снова, фраза про голосовое одна', async () => {
    const voiceOnly = transcriber({ ok: true, value: 'Расскажите про учёт' });
    const h = setup({ transcriber: voiceOnly });

    const outcome = await run(h, batchOf([voice('V1')], [[text('T2')]]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(voiceOnly.transcribe).toHaveBeenCalledTimes(1);
    expect(h.outbox.sendVoiceNotice).not.toHaveBeenCalled();
    expect(h.outbox.sendBotReply).toHaveBeenCalledWith(CHAT_ID, ANSWER, 'T2');
  });
});
