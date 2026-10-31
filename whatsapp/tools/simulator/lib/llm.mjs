// Клиент LLM симулятора: запись каждого вызова (что получил агент и что ответил) поверх настоящего адаптера
// llm/anthropic.js. В режиме подделок адаптер тот же, но SDK поддельный (шов AnthropicLlmDeps.createSdk): лимит
// вызовов, лог токенов, схема ответа и разбор работают как в бою, а сети нет.
import { AsyncLocalStorage } from 'node:async_hooks';

const llmCall = new AsyncLocalStorage();

/** Обёртка LlmClient: запись запроса и ответа, учёт активности. */
export function wrapLlm(inner, { events, activity, schemas }) {
  let counter = 0;
  return {
    async structured(request) {
      counter += 1;
      const id = counter;
      schemas.remember(request.purpose, request.schema);
      const call = events.push({
        type: 'llm',
        id,
        purpose: request.purpose,
        model: request.model,
        chatId: request.chatId,
        maxTokens: request.maxTokens,
        system: request.system.map((block) => ({ text: block.text, cache: block.cache })),
        turns: request.turns.map((turn) => ({ role: turn.role, text: turn.text })),
        imageBytes: request.image?.data?.byteLength ?? null,
      });
      activity.begin('llm');
      const startedAt = Date.now();
      try {
        const result = await llmCall.run({ purpose: request.purpose, id }, () => inner.structured(request));
        call.ms = Date.now() - startedAt;
        call.result = result;
        return result;
      } catch (error) {
        call.ms = Date.now() - startedAt;
        call.error = error?.name ?? String(error);
        throw error;
      } finally {
        activity.end('llm');
      }
    },
  };
}

/** Схемы ответа по назначению вызова: описания полей тоже инструкция модели, они идут в prompts.md. */
export function createSchemaStore(toJsonSchema) {
  const byPurpose = new Map();
  return {
    remember(purpose, schema) {
      if (byPurpose.has(purpose) || toJsonSchema === null) return;
      try {
        byPurpose.set(purpose, toJsonSchema(schema));
      } catch (error) {
        byPurpose.set(purpose, { error: `схема не переведена: ${error?.name ?? error}` });
      }
    },
    all: () => byPurpose,
  };
}

// Подделки ответов модели (только SIM_FAKE=1).

/** Подсказки поддельной модели из поля fake хода сценария; последний отправленный ход главнее. */
export function createHints() {
  let current = {};
  let replyCalls = 0;
  let reviewCalls = 0;
  let level = 'cold';
  const nth = (value, index) => {
    if (value === undefined) return undefined;
    const list = Array.isArray(value) ? value : [value];
    return list[Math.min(index, list.length - 1)];
  };
  return {
    set(fake) {
      current = fake ?? {};
      replyCalls = 0;
      reviewCalls = 0;
      if (typeof current.interest?.level === 'string') level = current.interest.level;
    },
    reply() {
      const hint = nth(current.reply, replyCalls);
      replyCalls += 1;
      return hint;
    },
    review() {
      const hint = nth(current.review, reviewCalls);
      reviewCalls += 1;
      return hint;
    },
    interest() {
      return { ...(current.interest ?? {}), level };
    },
  };
}

/** Ответы по умолчанию: без двоеточий, тире и «Понятно», чтобы проверки кодом их пропускали. */
const DEFAULT_REPLIES = [
  {
    text: 'Здравствуйте! Мы в Tanbala ставим учёт вещей на RFID метках. Расскажите, из какой вы компании и чем она занимается?',
    stage: 'intro',
    companyQuestion: 'name',
  },
  { text: 'Спасибо. Что именно нужно учитывать и в какой упаковке это лежит?', stage: 'details' },
  { text: 'В каком городе объект и сколько примерно вещей на хранении?', stage: 'details' },
  { text: 'Учёт сейчас ведёте в 1С? Если да, подскажите, какая у вас конфигурация.', stage: 'details' },
  { text: 'Спасибо, это поможет. Где сейчас больше всего теряется времени при пересчёте?', stage: 'details' },
];

function rawReply(hint, fallbackIndex) {
  const base = typeof hint === 'string' ? { text: hint } : (hint ?? DEFAULT_REPLIES[fallbackIndex % DEFAULT_REPLIES.length]);
  return {
    outcome: base.outcome ?? 'answer',
    text: base.text ?? '',
    stopRequested: base.stopRequested ?? false,
    companyQuestion: base.companyQuestion ?? 'none',
    aboutPrice: base.aboutPrice ?? false,
    stage: base.stage ?? 'details',
    usedFacts: base.usedFacts ?? [],
  };
}

/** Невыясненное поле оценки: пустая строка (так отвечает модель по схеме), has1C null. */
function rawInterest(hint) {
  const profile = {
    business: '',
    items: '',
    packaging: '',
    material: '',
    city: '',
    premises: '',
    area: '',
    scope: '',
    itemCount: '',
    turnover: '',
    currentTracking: '',
    monthlyIntake: '',
    passages: '',
    shelfRecount: '',
    has1C: null,
    problem: '',
    specifics: '',
    oneCName: '',
    problemAgreed: false,
    inferred: [],
    ...(hint.profile ?? {}),
  };
  return {
    level: hint.level ?? 'cold',
    ...profile,
    reason: hint.reason ?? 'Симулятор: поддельная оценка интереса',
    companyName: hint.companyName ?? '',
    companyCity: hint.companyCity ?? '',
    companyAliases: hint.companyAliases ?? [],
    companyAnswer: hint.companyAnswer ?? 'none',
    confirmedPains: hint.confirmedPains ?? [],
    priceAsked: hint.priceAsked ?? false,
    refused: hint.refused ?? false,
  };
}

/** Назначение вызова: из обёртки, иначе по полям JSON-схемы ответа. */
function purposeOf(params) {
  const fromCall = llmCall.getStore()?.purpose;
  if (fromCall !== undefined) return fromCall;
  const props = Object.keys(params?.output_config?.format?.schema?.properties ?? {});
  if (props.includes('outcome')) return 'reply';
  if (props.includes('problems')) return 'review';
  if (props.includes('level')) return 'interest';
  return 'logo';
}

function charsOf(params) {
  const system = (params.system ?? []).reduce((sum, block) => sum + String(block.text ?? '').length, 0);
  const messages = (params.messages ?? []).reduce(
    (sum, message) => sum + (typeof message.content === 'string' ? message.content.length : 0),
    0,
  );
  return system + messages;
}

/** Поддельный SDK Anthropic: messages.create отдаёт JSON по назначению вызова и примерные токены (знаки / 3). */
export function createFakeSdk({ hints, latencyMs }) {
  let defaultReplies = 0;
  const answer = (purpose) => {
    switch (purpose) {
      case 'reply': {
        const hint = hints.reply();
        if (hint === undefined) defaultReplies += 1;
        return rawReply(hint, defaultReplies - 1);
      }
      case 'review': {
        const hint = hints.review();
        return hint ?? { ok: true, problems: [] };
      }
      case 'interest':
        return rawInterest(hints.interest());
      default:
        return { companyName: null };
    }
  };
  return {
    messages: {
      async create(params) {
        await new Promise((resolve) => setTimeout(resolve, latencyMs));
        const text = JSON.stringify(answer(purposeOf(params)));
        return {
          id: 'msg_sim',
          type: 'message',
          role: 'assistant',
          model: params.model,
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: Math.round(charsOf(params) / 3),
            output_tokens: Math.round(text.length / 3),
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        };
      },
    },
  };
}
