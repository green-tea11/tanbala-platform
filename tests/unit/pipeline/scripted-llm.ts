import type { LlmClient, StructuredRequest } from '../../../src/domain/ports.js';
import type { InterestLevel, LlmPurpose } from '../../../src/domain/types.js';

// Поддельный клиент LLM для тестов сборки: отвечает по назначению вызова в форме схем агента. Значение проходит
// через ту же схему, что и настоящий ответ модели. Сети нет.

/** Что отвечает поддельная модель. */
export interface LlmScript {
  /** Текст черновика с исходом answer: на каждый вызов ответа следующий, последний повторяется. */
  readonly replies: readonly [string, ...string[]];
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

export function scriptedLlm(script: LlmScript): ScriptedLlm {
  const requests: RecordedRequest[] = [];
  let replyCalls = 0;
  const rawAnswer = (purpose: LlmPurpose): unknown => {
    switch (purpose) {
      case 'reply': {
        const text = script.replies[Math.min(replyCalls, script.replies.length - 1)];
        replyCalls += 1;
        return { outcome: 'answer', text, stopRequested: false };
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
