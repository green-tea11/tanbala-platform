import type { LlmClient, StructuredRequest } from '../../../src/domain/ports.js';
import type { InterestLevel, LlmPurpose } from '../../../src/domain/types.js';

// Поддельный клиент LLM для тестов сборки: отвечает по назначению вызова в форме схем агента. Значение проходит
// через ту же схему, что и настоящий ответ модели. Сети нет.

/**
 * Ответ модели на вызов ответа. Строка: черновик с исходом answer и этим текстом. Объект: любой исход схемы
 * (hot, no_answer, asked_human, complaint) со своим текстом и stopRequested.
 */
export type ReplyScript =
  | string
  | {
      readonly outcome: 'answer' | 'hot' | 'no_answer' | 'asked_human' | 'complaint';
      readonly text?: string;
      readonly stopRequested?: boolean;
    };

/** Что отвечает поддельная модель. */
export interface LlmScript {
  /** Ответы на вызов ответа: на каждый вызов следующий, последний повторяется. */
  readonly replies: readonly [ReplyScript, ...ReplyScript[]];
  /** Уровень интереса в оценке; по умолчанию холодный. */
  readonly level?: InterestLevel;
  /** Замечания проверки черновика; по умолчанию их нет и проверка пройдена. */
  readonly problems?: readonly string[];
}

/** Запрос без схемы: то, что тест может сравнить. */
export type RecordedRequest = Pick<
  StructuredRequest<unknown>,
  'purpose' | 'model' | 'system' | 'turns' | 'maxTokens' | 'chatId'
>;

export interface ScriptedLlm {
  readonly llm: LlmClient;
  /** Запросы в порядке прихода. */
  readonly requests: RecordedRequest[];
  /** Назначения вызовов в порядке прихода. */
  readonly purposes: () => LlmPurpose[];
}

function rawInterest(level: InterestLevel): unknown {
  return {
    level,
    business: null,
    area: null,
    scope: null,
    itemCount: null,
    has1C: null,
    problem: null,
    specifics: null,
    reason: 'по разговору',
  };
}

function rawReply(script: ReplyScript): unknown {
  if (typeof script === 'string') {
    return { outcome: 'answer', text: script, stopRequested: false };
  }
  return {
    outcome: script.outcome,
    text: script.text ?? '',
    stopRequested: script.stopRequested ?? false,
  };
}

export function scriptedLlm(script: LlmScript): ScriptedLlm {
  const requests: RecordedRequest[] = [];
  let replyCalls = 0;
  const rawAnswer = (purpose: LlmPurpose): unknown => {
    switch (purpose) {
      case 'reply': {
        const reply = script.replies[Math.min(replyCalls, script.replies.length - 1)];
        replyCalls += 1;
        if (reply === undefined) throw new Error('В сценарии нет ответа модели');
        return rawReply(reply);
      }
      case 'review': {
        const problems = script.problems ?? [];
        return { ok: problems.length === 0, problems };
      }
      case 'interest':
        return rawInterest(script.level ?? 'cold');
    }
  };
  const llm: LlmClient = {
    structured: (request) => {
      const { purpose, model, system, turns, maxTokens, chatId } = request;
      requests.push({ purpose, model, system, turns, maxTokens, chatId });
      return Promise.resolve({ ok: true, value: request.schema.parse(rawAnswer(request.purpose)) });
    },
  };
  return { llm, requests, purposes: () => requests.map((request) => request.purpose) };
}
