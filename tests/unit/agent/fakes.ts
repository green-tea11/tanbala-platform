import type { ConversationContext } from '../../../src/agent/agent.js';
import type { Knowledge } from '../../../src/agent/knowledge.js';
import type { LlmClient, StructuredRequest } from '../../../src/domain/ports.js';
import type { ChatId, ClientProfile, LlmResult, StoredMessage } from '../../../src/domain/types.js';

// Общие заглушки тестов агента: без сети, диска и реального LLM.

export const KNOWLEDGE: Knowledge = {
  owner: '# Tanbala: что должен знать агент\n',
  whatsapp: '# Tanbala в WhatsApp\n',
  version: 'v1',
};

/** Разные модели у вызовов: видно, что каждый вызов берёт свою модель из конфига. */
export const MODELS = {
  reply: 'claude-sonnet-5-5',
  review: 'claude-review-model',
  interest: 'claude-interest-model',
} as const;

/**
 * Любое тире: цифровое, en, em, горизонтальная линия и минус. Символы заданы кодами, чтобы в исходнике тире
 * не было.
 */
export const ANY_DASH = new RegExp(
  `[${String.fromCharCode(0x2012)}-${String.fromCharCode(0x2015)}${String.fromCharCode(0x2212)}]`,
);

export const CHAT_ID = 11 as ChatId;
export const BASE_TS = Date.UTC(2026, 9, 26, 6, 0, 0);

export const CLIENT_TEXT = 'Здравствуйте, сколько стоит учёт?';

export const EMPTY_PROFILE: ClientProfile = {
  business: null,
  area: null,
  scope: null,
  itemCount: null,
  has1C: null,
  problem: null,
  specifics: null,
};

export function history(count: number): StoredMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    chatId: CHAT_ID,
    author: index % 2 === 0 ? 'client' : 'bot',
    kind: 'text',
    text: `сообщение ${index + 1}`,
    tsMs: BASE_TS + index * 1000,
  }));
}

export function context(overrides: Partial<ConversationContext> = {}): ConversationContext {
  return {
    chatId: CHAT_ID,
    history: [
      {
        id: 1,
        chatId: CHAT_ID,
        author: 'client',
        kind: 'text',
        text: CLIENT_TEXT,
        tsMs: BASE_TS,
      },
    ],
    profile: EMPTY_PROFILE,
    ...overrides,
  };
}

/** LlmClient, который запоминает запрос и отвечает заданным значением (как будто прошло схему). */
export function fakeLlm(answer: LlmResult<unknown>) {
  const requests: StructuredRequest<unknown>[] = [];
  const llm: LlmClient = {
    structured: <T>(request: StructuredRequest<T>): Promise<LlmResult<T>> => {
      requests.push(request);
      return Promise.resolve(answer as LlmResult<T>);
    },
  };
  return { requests, llm };
}

/** Единственный запрос к LLM: тест падает, если вызова не было. */
export function onlyRequest(
  requests: readonly StructuredRequest<unknown>[],
): StructuredRequest<unknown> {
  const request = requests[0];
  if (request === undefined) {
    throw new Error('LLM не вызван');
  }
  return request;
}
