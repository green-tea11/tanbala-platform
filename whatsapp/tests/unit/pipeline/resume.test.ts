import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/domain/ports.js';
import type {
  Chat,
  ChatId,
  InboundMessage,
  Jid,
  UnansweredInbound,
  WaMessageId,
} from '../../../src/domain/types.js';
import { resumeAfterReturn, type ResumeDeps } from '../../../src/pipeline/resume.js';

// Возврат чата боту (решение владельца 29.10.2026): сообщения клиента после последнего исходящего и не старше
// BACKLOG_MAX_AGE_HOURS уходят в очередь ответа одной пачкой. Репозитории и очередь поддельные.

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const HOUR_MS = 60 * 60 * 1000;
const CHAT_ID = 1 as ChatId;
const JID = '77000000002@s.whatsapp.net' as Jid;

function chat(status: 'bot' | 'manager' = 'bot'): Chat {
  return {
    id: CHAT_ID,
    identity: { replyJid: JID, lidJid: null, pnJid: JID },
    pushName: 'Алия',
    control: status === 'bot' ? { status: 'bot', by: 'panel' } : { status: 'manager', by: 'bot' },
    level: 'warm',
    profile: {
      business: null,
      area: null,
      scope: null,
      itemCount: null,
      has1C: null,
      oneCName: null,
      problem: null,
      specifics: null,
      problemAgreed: false,
    },
  };
}

function pending(waId: string, overrides: Partial<UnansweredInbound> = {}): UnansweredInbound {
  return {
    waId: waId as WaMessageId,
    kind: 'text',
    text: `текст ${waId}`,
    tsMs: NOW - 1000,
    ...overrides,
  };
}

function setup(found: Chat | null, messages: readonly UnansweredInbound[]) {
  const logs: { level: string; context: unknown }[] = [];
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
  const push = vi.fn<(chatId: ChatId, message: InboundMessage) => void>();
  const unanswered = vi.fn<ResumeDeps['messages']['unansweredAfterLastOutbound']>(() => messages);
  const deps: ResumeDeps = {
    chats: { getById: (id) => (found?.id === id ? found : null) },
    messages: { unansweredAfterLastOutbound: unanswered },
    batcher: { push },
    clock: { now: () => NOW },
    logger,
    maxAgeMs: 12 * HOUR_MS,
  };
  return { deps, push, unanswered, logs };
}

describe('pipeline/resume: ответ на неотвеченное после возврата боту', () => {
  it('неотвеченные сообщения клиента уходят в очередь по порядку как входящие этого чата', () => {
    const h = setup(chat(), [pending('C1'), pending('C2', { tsMs: NOW - 500 })]);

    const count = resumeAfterReturn(h.deps, CHAT_ID);

    expect(count).toBe(2);
    expect(h.unanswered).toHaveBeenCalledWith(CHAT_ID, NOW - 12 * HOUR_MS);
    expect(h.push.mock.calls).toEqual([
      [
        CHAT_ID,
        {
          waId: 'C1',
          identity: chat().identity,
          pushName: 'Алия',
          content: { kind: 'text', text: 'текст C1' },
          tsMs: NOW - 1000,
        },
      ],
      [
        CHAT_ID,
        {
          waId: 'C2',
          identity: chat().identity,
          pushName: 'Алия',
          content: { kind: 'text', text: 'текст C2' },
          tsMs: NOW - 500,
        },
      ],
    ]);
  });

  it('расшифрованное голосовое идёт текстом, голосовое без расшифровки и вложение без текста', () => {
    const h = setup(chat(), [
      pending('V1', { kind: 'voice', text: 'расшифровка' }),
      pending('V2', { kind: 'voice', text: null }),
      pending('P1', { kind: 'other', text: null }),
    ]);

    resumeAfterReturn(h.deps, CHAT_ID);

    expect(h.push.mock.calls.map(([, message]) => message.content)).toEqual([
      { kind: 'text', text: 'расшифровка' },
      { kind: 'other' },
      { kind: 'other' },
    ]);
  });

  it('отвечать не на что (менеджер ответил или всё старше 12 часов): очередь не трогается', () => {
    const h = setup(chat(), []);

    expect(resumeAfterReturn(h.deps, CHAT_ID)).toBe(0);
    expect(h.push).not.toHaveBeenCalled();
  });

  it.each<[string, Chat | null]>([
    ['чата нет', null],
    ['чат снова у менеджера', chat('manager')],
  ])('%s: ничего не уходит', (_name, found) => {
    const h = setup(found, [pending('C1')]);

    expect(resumeAfterReturn(h.deps, CHAT_ID)).toBe(0);
    expect(h.unanswered).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });

  it('в лог только ID чата и число сообщений, без текста и имени', () => {
    const h = setup(chat(), [pending('C1')]);

    resumeAfterReturn(h.deps, CHAT_ID);

    expect(h.logs).toEqual([{ level: 'info', context: { chatId: CHAT_ID, count: 1 } }]);
    expect(JSON.stringify(h.logs)).not.toMatch(/текст|Алия/);
  });

  it('часы раньше порога (тесты, сбитое время): граница не уходит в минус', () => {
    const h = setup(chat(), []);
    const deps: ResumeDeps = { ...h.deps, clock: { now: () => 1000 } };

    resumeAfterReturn(deps, CHAT_ID);

    expect(h.unanswered).toHaveBeenCalledWith(CHAT_ID, 0);
  });
});
