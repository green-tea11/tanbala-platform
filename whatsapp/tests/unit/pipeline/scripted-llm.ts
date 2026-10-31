import type { LlmClient, StructuredRequest } from '../../../src/domain/ports.js';
import type { ClientProfile, InterestLevel, LlmPurpose } from '../../../src/domain/types.js';

// Поддельный клиент LLM для тестов сборки: отвечает по назначению вызова в форме схем агента. Значение проходит
// через ту же схему, что и настоящий ответ модели. Сети нет.

/**
 * Ответ модели на вызов ответа. Строка: черновик с исходом answer и этим текстом. Объект: любой исход схемы
 * (hot, no_answer, asked_human, complaint) со своим текстом, stopRequested и aboutPrice.
 */
export type ReplyScript =
  | string
  | {
      readonly outcome: 'answer' | 'hot' | 'no_answer' | 'asked_human' | 'complaint';
      readonly text?: string;
      readonly stopRequested?: boolean;
      /** О чём из компании спросил ответ; по умолчанию none. */
      readonly companyQuestion?: 'none' | 'confirm' | 'name';
      /** Клиент спрашивал цену или стоимость; по умолчанию false. */
      readonly aboutPrice?: boolean;
      /** Этап разговора, на котором написан text; по умолчанию details. */
      readonly stage?: 'intro' | 'hook' | 'explain' | 'details' | 'final';
      /** Сильные стороны в text; по умолчанию ни одной. */
      readonly usedFacts?: readonly string[];
    };

/** Ответ оценки интереса: уровень и то, что клиент сказал о своей компании (поля схемы оценки). */
export interface InterestScript {
  /** По умолчанию LlmScript.level, без него холодный. */
  readonly level?: InterestLevel;
  /** Название компании со слов клиента; по умолчанию null. */
  readonly companyName?: string | null;
  /** Город компании со слов клиента; по умолчанию null. */
  readonly companyCity?: string | null;
  /** Варианты названия компании клиента; по умолчанию пусто. */
  readonly companyAliases?: readonly string[];
  /** Ответ на вопрос «Вы из компании X?»; по умолчанию none. */
  readonly companyAnswer?: 'yes' | 'no' | 'none';
  /** Боли, с которыми клиент согласился; по умолчанию пусто. */
  readonly confirmedPains?: readonly string[];
  /** Поля выжимки со слов клиента; по умолчанию null, согласие с трудностью false. */
  readonly profile?: Partial<ClientProfile>;
  /** Клиент спрашивает цену в последних сообщениях; по умолчанию false. */
  readonly priceAsked?: boolean;
  /** Клиент отказывается отвечать на вопросы бота; по умолчанию false. */
  readonly refused?: boolean;
}

/** Что отвечает поддельная модель. */
export interface LlmScript {
  /** Ответы на вызов ответа: на каждый вызов следующий, последний повторяется. */
  readonly replies: readonly [ReplyScript, ...ReplyScript[]];
  /** Уровень интереса в оценке; по умолчанию холодный. */
  readonly level?: InterestLevel;
  /**
   * Ответы оценки интереса: на каждый вызов следующий, последний повторяется. По умолчанию уровень level и ничего
   * о компании.
   */
  readonly interests?: readonly [InterestScript, ...InterestScript[]];
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

/** Так отвечает модель: невыясненное текстовое поле пустая строка (null только у has1C), см. interestSchema. */
function asModelOutput(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      field === null && key !== 'has1C' ? '' : field,
    ]),
  );
}

function rawInterest(level: InterestLevel, interest: InterestScript = {}): unknown {
  return asModelOutput({
    level: interest.level ?? level,
    business: null,
    area: null,
    scope: null,
    itemCount: null,
    has1C: null,
    oneCName: null,
    problem: null,
    specifics: null,
    problemAgreed: false,
    items: null,
    packaging: null,
    material: null,
    city: null,
    premises: null,
    turnover: null,
    currentTracking: null,
    monthlyIntake: null,
    passages: null,
    shelfRecount: null,
    inferred: [],
    ...interest.profile,
    reason: 'по разговору',
    companyName: interest.companyName ?? null,
    companyCity: interest.companyCity ?? null,
    companyAliases: interest.companyAliases ?? [],
    companyAnswer: interest.companyAnswer ?? 'none',
    confirmedPains: interest.confirmedPains ?? [],
    priceAsked: interest.priceAsked ?? false,
    refused: interest.refused ?? false,
  });
}

/** Элемент сценария для очередного вызова: следующий по счёту, последний повторяется; списка нет => undefined. */
function nth<T>(items: readonly T[] | undefined, calls: number): T | undefined {
  return items === undefined ? undefined : items[Math.min(calls, items.length - 1)];
}

function rawReply(script: ReplyScript): unknown {
  if (typeof script === 'string') {
    return {
      outcome: 'answer',
      text: script,
      stopRequested: false,
      companyQuestion: 'none',
      aboutPrice: false,
      stage: 'details',
      usedFacts: [],
    };
  }
  return {
    outcome: script.outcome,
    text: script.text ?? '',
    stopRequested: script.stopRequested ?? false,
    companyQuestion: script.companyQuestion ?? 'none',
    aboutPrice: script.aboutPrice ?? false,
    stage: script.stage ?? 'details',
    usedFacts: script.usedFacts ?? [],
  };
}

export function scriptedLlm(script: LlmScript): ScriptedLlm {
  const requests: RecordedRequest[] = [];
  let replyCalls = 0;
  let interestCalls = 0;
  const rawAnswer = (purpose: LlmPurpose): unknown => {
    switch (purpose) {
      case 'reply': {
        const reply = nth(script.replies, replyCalls);
        replyCalls += 1;
        if (reply === undefined) throw new Error('В сценарии нет ответа модели');
        return rawReply(reply);
      }
      case 'review': {
        const problems = script.problems ?? [];
        return { ok: problems.length === 0, problems };
      }
      case 'interest': {
        const interest = nth(script.interests, interestCalls);
        interestCalls += 1;
        return rawInterest(script.level ?? 'cold', interest);
      }
      case 'logo':
        return { companyName: null };
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
