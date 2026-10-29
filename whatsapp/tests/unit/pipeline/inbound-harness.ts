import { vi, type Mock } from 'vitest';
import type { ConversationContext, DraftKind } from '../../../src/agent/agent.js';
import type { CompanySummary, CompanyTurn } from '../../../src/domain/company.js';
import type { Clock, Logger, Transcriber } from '../../../src/domain/ports.js';
import type {
  AudioClip,
  Chat,
  ChatId,
  ChatProgress,
  ClientProfile,
  InboundMessage,
  InterestAssessment,
  InterestLevel,
  Jid,
  LlmResult,
  MediaRef,
  MessageContent,
  PhoneDigits,
  ReplyDraft,
  ReviewResult,
  StoredMessage,
  WaMessageId,
} from '../../../src/domain/types.js';
import type { HandoffService } from '../../../src/handoff/handoff.js';
import type { ClientBatch } from '../../../src/pipeline/batcher.js';
import {
  handleClientBatch,
  type PipelineDeps,
  type PipelineOutcome,
} from '../../../src/pipeline/handle-inbound.js';

// Стенд конвейера для тестов pipeline/handle-inbound*.test.ts. Все зависимости поддельные: шаги конвейера пишутся
// в общий журнал calls, по нему видно порядок. Сервис компании по умолчанию выключен (блок off) и в журнал не
// пишет: тест, которому важен его порядок, подменяет реализацию моков h.company.

export const NOW = Date.UTC(2026, 9, 26, 9, 0, 0);
export const CHAT_ID = 7 as ChatId;
export const PHONE = '77000000002' as PhoneDigits;
export const JID = `${PHONE}@s.whatsapp.net` as Jid;
export const ALLOWLIST: ReadonlySet<PhoneDigits> = new Set([PHONE]);
export const ANSWER = 'Учёт подбираем под задачу. Что вы храните?';
export const HOT_TEXT =
  'Да, мы проводим интеграцию с вашей 1С, детали решаем по вашей конфигурации. Стоимость зависит от вашей задачи, уточню у коллеги и вернусь к вам.';
export const SECOND_HOT_TEXT = 'Интеграцию с вашей 1С проводим. Уточню у коллеги и вернусь к вам.';
export const MIME = 'audio/ogg; codecs=opus';
export const TYPING_MS = 1200;
export const EMPTY_PROFILE: ClientProfile = {
  business: null,
  area: null,
  scope: null,
  itemCount: null,
  has1C: null,
  oneCName: null,
  problem: null,
  specifics: null,
  problemAgreed: false,
};
export const HISTORY: readonly StoredMessage[] = [
  { id: 1, chatId: CHAT_ID, author: 'client', kind: 'text', text: 'Сколько стоит?', tsMs: NOW },
];

export type Status = 'bot' | 'manager';

export function chatWith(status: Status): Chat {
  return {
    id: CHAT_ID,
    identity: { replyJid: JID, lidJid: null, pnJid: JID },
    pushName: null,
    control: status === 'bot' ? { status: 'bot', by: null } : { status: 'manager', by: 'phone' },
    level: 'cold',
    profile: EMPTY_PROFILE,
  };
}

export function text(id: string, tsMs = NOW): InboundMessage {
  return message(id, { kind: 'text', text: 'Сколько стоит?' }, tsMs);
}

export function voice(id: string, tsMs = NOW): InboundMessage {
  return message(id, { kind: 'voice', media: id as MediaRef, mimeType: MIME, seconds: 3 }, tsMs);
}

export function picture(id: string): InboundMessage {
  return message(id, { kind: 'other' }, NOW);
}

export function message(id: string, content: MessageContent, tsMs: number): InboundMessage {
  return {
    waId: id as WaMessageId,
    identity: { replyJid: JID, lidJid: null, pnJid: JID },
    pushName: null,
    content,
    tsMs,
  };
}

export function answer(value: string = ANSWER): LlmResult<ReplyDraft> {
  return { ok: true, value: { outcome: 'answer', text: value } };
}

export function handoffAnswer(
  outcome: 'hot' | 'no_answer' | 'asked_human',
  value: string,
): LlmResult<ReplyDraft> {
  return { ok: true, value: { outcome, text: value } };
}

export function assessed(level: InterestLevel): LlmResult<InterestAssessment> {
  return { ok: true, value: { level, profile: EMPTY_PROFILE, reason: 'по разговору' } };
}

export const REVIEW_OK: LlmResult<ReviewResult> = { ok: true, value: { ok: true } };

/** Шаг, во время которого человек подключается к чату: статус меняется на manager. */
export type JoinStep = 'transcribe' | 'read' | 'prepare' | 'draft';

export interface Options {
  /** Статус чата с этим ID в начале; null: чата с таким ID нет (слит с другим). */
  readonly status?: Status | null;
  readonly joinOn?: JoinStep;
  readonly drafts?: readonly LlmResult<ReplyDraft>[];
  /** Ответы проверки черновика по порядку вызовов; последний повторяется. */
  readonly reviews?: readonly LlmResult<ReviewResult>[];
  /** Ответ оценки интереса; по умолчанию холодный клиент. */
  readonly assessment?: LlmResult<InterestAssessment>;
  readonly transcriber?: Transcriber;
  readonly testAllowlist?: ReadonlySet<PhoneDigits> | null;
  readonly found?: Chat | null;
  /** Что вернёт setTranscript: записалась ли расшифровка. */
  readonly transcriptSaved?: boolean;
  /** Передача не записалась: handOff отклоняется этой ошибкой. */
  readonly handOffFails?: Error;
  /** Что вернёт company.prepare; по умолчанию блок off без ожидания ответа. */
  readonly companyTurn?: CompanyTurn;
  /** Ход разговора о цене в базе; по умолчанию вопросов цены не было. */
  readonly progress?: ChatProgress;
  /** Сводка о компании (название для минимума); по умолчанию функция выключена. */
  readonly summary?: CompanySummary;
}

/** Сводка выключенного определения компании. */
export const OFF_SUMMARY: CompanySummary = {
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

/** Определение компании выключено: так сервис отвечает без INTERNAL_API_TOKEN. */
export const OFF_TURN: CompanyTurn = { prompt: { kind: 'off' }, awaitingAnswer: false };

export type Mocked<K extends keyof PipelineDeps> = {
  readonly [M in keyof PipelineDeps[K]]: PipelineDeps[K][M] extends (...args: never[]) => unknown
    ? Mock<PipelineDeps[K][M]>
    : never;
};

export interface Harness {
  readonly deps: PipelineDeps;
  readonly calls: string[];
  readonly logs: { readonly level: string; readonly context: unknown }[];
  readonly contexts: ConversationContext[];
  /** Контексты оценки интереса и проверки черновика по порядку вызовов. */
  readonly assessContexts: ConversationContext[];
  readonly reviewContexts: ConversationContext[];
  /** Замечания, с которыми вызывали draftReply (undefined: первый черновик), и тексты, отданные на проверку. */
  readonly feedbacks: (readonly string[] | undefined)[];
  readonly reviewed: string[];
  /** Подпись ревью: обычный ответ или сообщение о передаче. */
  readonly reviewKinds: (DraftKind | undefined)[];
  readonly outbox: Mocked<'outbox'>;
  readonly inbox: Mocked<'inbox'>;
  readonly handOff: Mock<HandoffService['handOff']>;
  readonly setTyping: Mock<PipelineDeps['typing']['setTyping']>;
  readonly company: Mocked<'company'>;
}

export function createLogger(logs: Harness['logs']): Logger {
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

export function setup(options: Options = {}): Harness {
  const calls: string[] = [];
  const logs: Harness['logs'] = [];
  const contexts: ConversationContext[] = [];
  const assessContexts: ConversationContext[] = [];
  const reviewContexts: ConversationContext[] = [];
  const feedbacks: Harness['feedbacks'] = [];
  const reviewed: string[] = [];
  const reviewKinds: (DraftKind | undefined)[] = [];
  const drafts = [...(options.drafts ?? [answer()])];
  const reviews = [...(options.reviews ?? [REVIEW_OK])];
  let status = options.status === undefined ? 'bot' : options.status;
  const join = (step: JoinStep): void => {
    if (options.joinOn === step) status = 'manager';
  };
  const outbox: Mocked<'outbox'> = {
    sendBotReply: vi.fn((_chat, reply, replyTo) => {
      calls.push(`reply:${reply}:${replyTo}`);
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
  // Как настоящий сервис передачи: чат уходит менеджеру, и бот в нём молчит.
  const handOff = vi.fn<HandoffService['handOff']>((_chatId, request) => {
    calls.push(`handoff:${request.reason}`);
    if (options.handOffFails !== undefined) return Promise.reject(options.handOffFails);
    status = 'manager';
    return Promise.resolve();
  });
  const clock: Clock = {
    now: () => NOW,
    sleep: (ms) => {
      calls.push(`sleep:${ms}`);
      return Promise.resolve();
    },
  };
  const company = companyFake(options, join);
  const deps: PipelineDeps = {
    chats: {
      getById: (id) => {
        if (id !== CHAT_ID) return options.found?.id === id ? options.found : null;
        return status === null ? null : chatWith(status);
      },
      findByJid: () => options.found ?? null,
      saveAssessment: (_id, assessment) => {
        calls.push(`save:${assessment.level}`);
      },
      getProgress: () => options.progress ?? { priceAsks: 0, refused: false },
      recordTurn: (_id, signals) => {
        calls.push(
          `turn:${signals.priceAsked ? 'price' : '-'}:${signals.refused ? 'refused' : '-'}`,
        );
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
      draftReply: (context, feedback) => {
        calls.push(feedback === undefined ? 'draft' : 'draft:retry');
        contexts.push(context);
        feedbacks.push(feedback);
        join('draft');
        const next = drafts.length > 1 ? drafts.shift() : drafts[0];
        return Promise.resolve(next ?? answer());
      },
      reviewDraft: (context, text, kind) => {
        calls.push('review');
        reviewContexts.push(context);
        reviewed.push(text);
        reviewKinds.push(kind);
        const next = reviews.length > 1 ? reviews.shift() : reviews[0];
        return Promise.resolve(next ?? REVIEW_OK);
      },
      assessInterest: (context) => {
        calls.push('assess');
        assessContexts.push(context);
        return Promise.resolve(options.assessment ?? assessed('cold'));
      },
    },
    outbox,
    handoff: { handOff },
    company,
    transcriber: options.transcriber ?? { enabled: false },
    inbox,
    typing: { setTyping },
    typingDelayMs: (draft) => (draft === ANSWER ? TYPING_MS : TYPING_MS + 1),
    testAllowlist: options.testAllowlist === undefined ? ALLOWLIST : options.testAllowlist,
    clock,
    logger: createLogger(logs),
  };
  return {
    deps,
    calls,
    logs,
    contexts,
    assessContexts,
    reviewContexts,
    feedbacks,
    reviewed,
    reviewKinds,
    outbox,
    inbox,
    handOff,
    setTyping,
    company,
  };
}

/** Сервис компании: по умолчанию блок off, в журнал не пишет; prepare может «подключить человека» (joinOn prepare). */
function companyFake(options: Options, join: (step: JoinStep) => void): Mocked<'company'> {
  const turn = options.companyTurn ?? OFF_TURN;
  return {
    prepare: vi.fn<PipelineDeps['company']['prepare']>(() => {
      join('prepare');
      return Promise.resolve(turn);
    }),
    applyAssessment: vi.fn<PipelineDeps['company']['applyAssessment']>(() =>
      Promise.resolve(turn.prompt),
    ),
    markAsked: vi.fn<PipelineDeps['company']['markAsked']>(),
    identifyAfterReply: vi.fn<PipelineDeps['company']['identifyAfterReply']>(() =>
      Promise.resolve(),
    ),
    summary: vi.fn<PipelineDeps['company']['summary']>(() => options.summary ?? OFF_SUMMARY),
  };
}

export function batchOf(
  messages: readonly InboundMessage[],
  newer: readonly (readonly InboundMessage[])[] = [],
): ClientBatch {
  const queue = [...newer];
  return { chatId: CHAT_ID, messages, takeNewer: () => queue.shift() ?? [] };
}

export function run(h: Harness, batch: ClientBatch): Promise<PipelineOutcome> {
  return handleClientBatch(h.deps, batch);
}

export function levels(h: Harness, level: string): unknown[] {
  return h.logs.filter((entry) => entry.level === level).map((entry) => entry.context);
}

export const TYPING_STEPS = ['typing:on', `sleep:${TYPING_MS}`, 'typing:off'];

/** Шаги ответа после черновика: «печатает», ответ, «отвечено». */
export const SEND_STEPS = (replyTo: string): string[] => [
  ...TYPING_STEPS,
  `reply:${ANSWER}:${replyTo}`,
  `answered:${replyTo}`,
];

/** Черновик и оценка параллельно, оценка сохранена, ревью, затем отправка. */
export const CHECKED_STEPS = ['draft', 'assess', 'save:cold', 'review'];

export const REPLY_STEPS = (replyTo: string): string[] => [
  ...CHECKED_STEPS,
  ...SEND_STEPS(replyTo),
];
