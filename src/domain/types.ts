// Общий словарь проекта: только типы, без кода. Значения из docs/PLAN.md и knowledge/whatsapp.md.
// Брендированные ID не дают перепутать числа и строки разного смысла. Приводить к ним можно только
// на границе: в src/db (ID из базы), src/whatsapp/jid.ts (адреса и номера) и src/config (номер менеджера).

/** Внутренний ID чата в базе. */
export type ChatId = number & { readonly __brand: 'ChatId' };

/** ID сообщения WhatsApp (key.id). */
export type WaMessageId = string & { readonly __brand: 'WaMessageId' };

/** Адрес WhatsApp (JID) личного чата: ...@s.whatsapp.net, ...@lid или их hosted-варианты (whatsapp/jid.isPersonalJid). */
export type Jid = string & { readonly __brand: 'Jid' };

/** Номер телефона: только цифры с кодом страны, без «+» и суффикса устройства. */
export type PhoneDigits = string & { readonly __brand: 'PhoneDigits' };

/** Непрозрачная ссылка адаптера WhatsApp на голосовое в памяти: по ней его скачивают. */
export type MediaRef = string & { readonly __brand: 'MediaRef' };

/** Кто ведёт чат: бот или человек (менеджер с телефона или из панели). */
export type ChatStatus = 'bot' | 'manager';

/**
 * Смена статуса чата и кто её сделал. Вернуть чат боту можно только из панели:
 * сам бот себе чат не возвращает.
 */
export type StatusChange =
  | { readonly status: 'manager'; readonly by: 'bot' | 'phone' | 'panel' }
  | { readonly status: 'bot'; readonly by: 'panel' };

/**
 * Кто ведёт чат сейчас и кто это решил. by: null значит «бот с самого начала, статус не менялся».
 * Одно поле вместо пары «статус и последняя смена»: они не могут разойтись.
 */
export type ChatControl =
  | { readonly status: 'bot'; readonly by: 'panel' | null }
  | { readonly status: 'manager'; readonly by: 'bot' | 'phone' | 'panel' };

/**
 * Текст ответа, прошедший проверки кодом и второй вызов LLM. Приводится к бренду только в pipeline/decide.ts
 * (вариант send), поэтому Outbox.sendBotReply не примет непроверенный текст.
 */
export type ReviewedText = string & { readonly __brand: 'ReviewedText' };

/**
 * Ответ модели после нормализации Unicode NFKC. Приводит к бренду только конвейер (этап 4) перед
 * проверками кодом: checks/code-checks.runCodeChecks принимает только такой текст.
 */
export type NormalizedText = string & { readonly __brand: 'NormalizedText' };

/**
 * Уровень интереса клиента (раздел плана «Передача менеджеру»).
 * cold: спрашивает в общем; warm: рассказывает о бизнесе и задаче;
 * hot: основное о бизнесе собрано, и клиент спрашивает цену, сроки, договор или просит человека.
 */
export type InterestLevel = 'cold' | 'warm' | 'hot';

/**
 * Почему чат ушёл менеджеру. Уходит в уведомление, в панель и в таблицу handoffs.
 * limit: исчерпан дневной лимит вызовов API (решение владельца): бот замолкает без фразы клиенту.
 */
export type HandoffReason =
  | 'hot'
  | 'no_answer'
  | 'check_failed'
  | 'asked_human'
  | 'complaint'
  | 'human_took_over'
  | 'llm_error'
  | 'limit';

/**
 * Повод фразы клиенту при передаче. Фраза фиксированная и выбирается по поводу, без LLM;
 * stopRequested: клиент просит больше не писать, тогда только извинение.
 * Перехват человеком и лимит идут без фразы клиенту, поэтому их здесь нет.
 */
export type HandoffNotice =
  | { readonly reason: Exclude<HandoffReason, 'human_took_over' | 'complaint' | 'limit'> }
  | { readonly reason: 'complaint'; readonly stopRequested: boolean };

/** Какой дневной лимит вызовов API исчерпан: одного чата или всего бота. */
export type BudgetScope = 'chat' | 'global';

/**
 * Дневной предохранитель расходов (решение владельца): числа из .env, по умолчанию 500 и 40.
 * При превышении бот замолкает в этом чате и уведомляет менеджера.
 */
export interface ApiLimits {
  /** API_DAILY_LIMIT: вызовов API в сутки на весь бот (Anthropic и OpenRouter вместе). */
  readonly apiCallsPerDay: number;
  /** API_DAILY_LIMIT_PER_CHAT: вызовов API в сутки на один чат. */
  readonly apiCallsPerChatPerDay: number;
}

/** Автор сообщения в истории чата. */
export type Author = 'client' | 'bot' | 'human_phone' | 'human_panel';

/** Вид сообщения. Голосовое после расшифровки хранится как текст (этап 7). */
export type MessageKind = 'text' | 'voice' | 'other';

/** Отдельный вызов LLM из плана: ответ, проверка черновика, оценка интереса. Ключи config/models.json. */
export type LlmPurpose = 'reply' | 'review' | 'interest';

/**
 * Откуда исходящее сообщение. Нужен в outbound_ids, чтобы отличить эхо бота от человека.
 * voice_notice: фиксированная фраза в ответ на голосовое, пока расшифровки нет.
 */
export type SendOrigin =
  'bot_reply' | 'handoff_notice' | 'voice_notice' | 'manager_notify' | 'panel';

/**
 * Выжимка о клиенте для менеджера (раздел плана «Роль агента»).
 * Только то, что клиент сказал сам: null значит «не выяснили».
 */
export interface ClientProfile {
  /** Тип бизнеса. */
  readonly business: string | null;
  /** Площадь. */
  readonly area: string | null;
  /** Что учитывать: только ввоз и вывоз или где лежит каждая вещь. */
  readonly scope: string | null;
  /** Примерное число вещей. */
  readonly itemCount: string | null;
  /** Есть ли 1С. */
  readonly has1C: boolean | null;
  /** Какую проблему клиент хочет решить. */
  readonly problem: string | null;
  /** Особенности со слов клиента. */
  readonly specifics: string | null;
}

/**
 * Адреса чата в WhatsApp. В Baileys 7 чат может прийти с адресом @lid вместо номера.
 * Отвечать нужно на тот JID, с которого пришло сообщение.
 */
export interface ChatIdentity {
  /** JID, на который бот отвечает (как пришёл в key.remoteJid). */
  readonly replyJid: Jid;
  /** Адрес вида ...@lid, если известен. */
  readonly lidJid: Jid | null;
  /** Адрес с номером вида ...@s.whatsapp.net, если известен. */
  readonly pnJid: Jid | null;
}

/** Содержимое сообщения. Сырой WAMessage голосового остаётся в памяти адаптера, наружу только MediaRef. */
export type MessageContent =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'voice';
      readonly media: MediaRef;
      readonly mimeType: string;
      /** Длительность со слов отправителя: для лимитов не годится, лимит ставят по реальным байтам. */
      readonly seconds: number | null;
    }
  | { readonly kind: 'other' };

/** Голосовое, скачанное в память. */
export interface AudioClip {
  readonly data: Uint8Array;
  readonly mimeType: string;
}

/** Входящее сообщение клиента после разбора whatsapp/inbound.ts. */
export interface InboundMessage {
  readonly waId: WaMessageId;
  readonly identity: ChatIdentity;
  /** Имя из профиля WhatsApp: недоверенный и изменчивый текст, в ключ чата не входит. */
  readonly pushName: string | null;
  /** Текст клиента: недоверенные данные, не инструкции. */
  readonly content: MessageContent;
  /** Время сообщения, мс UTC. */
  readonly tsMs: number;
}

/** Сообщение, отправленное с номера бота: ботом, менеджером с телефона или из панели. */
export interface OwnMessage {
  readonly waId: WaMessageId;
  readonly chatJid: Jid;
  /** Текст нужен, чтобы сохранить в истории слова менеджера с телефона. */
  readonly content: MessageContent;
  readonly tsMs: number;
}

/** Сообщение для записи в историю чата. */
export interface NewMessage {
  readonly chatId: ChatId;
  readonly waId: WaMessageId;
  readonly author: Author;
  readonly kind: MessageKind;
  readonly text: string | null;
  readonly tsMs: number;
}

/** Сообщение из истории чата в базе. */
export interface StoredMessage {
  readonly id: number;
  readonly chatId: ChatId;
  readonly author: Author;
  readonly kind: MessageKind;
  readonly text: string | null;
  readonly tsMs: number;
}

/** Чат клиента: адреса, кто ведёт, уровень интереса и выжимка. */
export interface Chat {
  readonly id: ChatId;
  readonly identity: ChatIdentity;
  /** Последнее известное имя из профиля WhatsApp: недоверенный текст. */
  readonly pushName: string | null;
  readonly control: ChatControl;
  readonly level: InterestLevel;
  readonly profile: ClientProfile;
}

/**
 * Черновик ответа клиенту (первый вызов LLM). Текст модели уходит клиенту только в исходе answer,
 * и только после проверок кодом и второго вызова. Остальные исходы ведут к передаче с фиксированной фразой.
 */
export type ReplyDraft =
  | { readonly outcome: 'answer'; readonly text: string }
  | { readonly outcome: Extract<HandoffReason, 'no_answer' | 'asked_human'> }
  | { readonly outcome: Extract<HandoffReason, 'complaint'>; readonly stopRequested: boolean };

/** Итог проверки черновика вторым вызовом LLM: нет ли фактов не из знаний, цен, скидок, сроков, объёмов. */
export type ReviewResult =
  { readonly ok: true } | { readonly ok: false; readonly problems: readonly string[] };

/** Оценка интереса клиента и обновлённая выжимка (третий вызов LLM). */
export interface InterestAssessment {
  readonly level: InterestLevel;
  readonly profile: ClientProfile;
  readonly reason: string;
}

/** Почему вызов LLM не дал годного результата. Любой отказ ведёт к передаче специалисту (fail-closed). */
export type LlmFailure =
  | 'refusal'
  | 'truncated'
  | 'invalid_output'
  | 'rate_limited'
  | 'unavailable'
  | 'budget_exceeded'
  | 'disabled';

/**
 * Результат вызова LLM или расшифровки: сбой приходит значением, а не исключением, и его нельзя не обработать.
 * budget_exceeded несёт scope: какой дневной лимит исчерпан (вызова API при этом не было).
 */
export type LlmResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: Exclude<LlmFailure, 'budget_exceeded'> }
  | { readonly ok: false; readonly failure: 'budget_exceeded'; readonly scope: BudgetScope };

/** Какой провайдер и какой вызов: Claude делает три вызова плана, OpenRouter только расшифровку. */
export type UsageSource =
  | { readonly provider: 'anthropic'; readonly purpose: LlmPurpose }
  | { readonly provider: 'openrouter'; readonly purpose: 'transcribe' };

/**
 * Запись о вызове API для лога расхода: только числа и ID чата, без текста сообщений, номеров и ключей.
 * Время записи ставит сам лог.
 */
export type TokenUsageEntry = UsageSource & {
  readonly model: string;
  /** Входные токены без кэша (usage.input_tokens). */
  readonly input: number;
  /** Выходные токены, включая размышления модели (usage.output_tokens). */
  readonly output: number;
  /** Чтение из кэша промпта (usage.cache_read_input_tokens; null в ответе API => 0). */
  readonly cacheRead: number;
  /** Запись в кэш промпта (usage.cache_creation_input_tokens; null в ответе API => 0). */
  readonly cacheWrite: number;
  /** Внутренний ID чата: каждый вызов относится к чату, служебных вызовов вне чата нет. */
  readonly chatId: ChatId;
  /** Удался ли вызов: неудачные тоже пишутся. */
  readonly ok: boolean;
};

/** Строка лога расхода API (TOKEN_LOG_PATH). */
export type TokenUsage = TokenUsageEntry & {
  /** Время вызова, ISO 8601 UTC. */
  readonly ts: string;
};
