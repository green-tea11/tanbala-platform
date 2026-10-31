// Общий словарь проекта: только типы, без кода. Значения из docs/PLAN.md и knowledge/whatsapp.md.
// Брендированные ID не дают перепутать числа и строки разного смысла. Приводить к ним можно только
// на границе: в src/db (ID из базы), src/whatsapp/jid.ts (адреса и номера) и src/config (номер менеджера).
// Компания клиента и её определение: domain/company.ts.

import type { CompanyMention, CompanyQuestion } from './company.js';

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
 * Текст модели, прошедший проверки кодом и второй вызов LLM. Приводится к бренду только в pipeline/decide.ts
 * (вариант send и вариант handoff с text), поэтому Outbox.sendBotReply и Outbox.sendHandoffText не примут
 * непроверенный текст.
 */
export type ReviewedText = string & { readonly __brand: 'ReviewedText' };

/**
 * Ответ модели после нормализации Unicode NFKC. Приводит к бренду только конвейер (этап 4) перед
 * проверками кодом: checks/code-checks.runCodeChecks принимает только такой текст.
 */
export type NormalizedText = string & { readonly __brand: 'NormalizedText' };

/**
 * Уровень интереса клиента (раздел плана «Передача менеджеру»; hot уточнён решением владельца 30.10.2026).
 * cold: спрашивает в общем; warm: рассказывает о бизнесе и задаче;
 * hot: готов к расчёту (для расчёта известно всё) или спрашивает цену, сроки или договор, когда задача понятна, или
 * просит человека. Уровень чат не передаёт: передачу решает код (pipeline/handoff-gate.ts).
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
 * Проверенное сообщение модели при hot, no_answer и asked_human идёт отдельным путём (HandOffRequest.text) и
 * заменяет фразу; повод остаётся тем же. aboutPrice у hot: клиент спрашивал цену (решил вызов ответа), фраза
 * тогда ровно «Цена сильно зависит от объёма. Уточню у коллеги и вернусь к вам.»; нет поля => false.
 */
export type HandoffNotice =
  | {
      readonly reason: Exclude<HandoffReason, 'human_took_over' | 'complaint' | 'limit' | 'hot'>;
    }
  | { readonly reason: 'hot'; readonly aboutPrice?: boolean }
  | { readonly reason: 'complaint'; readonly stopRequested: boolean };

/** Какой дневной лимит вызовов API исчерпан: одного чата или всего бота. */
export type BudgetScope = 'chat' | 'global';

/**
 * Дневной предохранитель расходов (решение владельца): числа из .env, по умолчанию 500 и 100.
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

/**
 * Отдельный вызов LLM: ответ, проверка черновика, оценка интереса и название компании с фото профиля (logo,
 * шаг д определения компании). Ключи config/models.json.
 */
export type LlmPurpose = 'reply' | 'review' | 'interest' | 'logo';

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
  /** Чем занимается компания клиента. */
  readonly business: string | null;
  /**
   * Что лежит на хранении и что клиент хочет метить (решение владельца 29.10.2026: часть минимума для передачи по
   * цене; с 30.10.2026 и для расчёта).
   */
  readonly items: string | null;
  /** В чём вещи: коробки, паллеты, поштучно. */
  readonly packaging: string | null;
  /** Материал вещей: металл и жидкости важны для меток (часть минимума). */
  readonly material: string | null;
  /** Город объекта (часть минимума). */
  readonly city: string | null;
  /** Тип помещения: склад, открытая площадка, магазин (часть минимума). */
  readonly premises: string | null;
  /** Площадь. */
  readonly area: string | null;
  /** Что отмечать: только ввоз и вывоз или где лежит каждая вещь. */
  readonly scope: string | null;
  /** Примерное число вещей (часть минимума). */
  readonly itemCount: string | null;
  /** Сколько нового товара приходит в месяц (для расчёта меток, решение владельца 30.10.2026). */
  readonly monthlyIntake: string | null;
  /** Как часто вещи движутся. */
  readonly turnover: string | null;
  /** Сколько проходов (входов и выходов) нужно учитывать (для расчёта, 30.10.2026). */
  readonly passages: string | null;
  /** Нужен ли пересчёт полок ручным сканером, словами клиента (30.10.2026). */
  readonly shelfRecount: string | null;
  /** Как клиент ведёт учёт сейчас. */
  readonly currentTracking: string | null;
  /** Есть ли 1С. */
  readonly has1C: boolean | null;
  /** Какая 1С, если клиент знает (например, «1С:Управление торговлей»). */
  readonly oneCName: string | null;
  /** Что мешает в нынешнем учёте, какую проблему клиент хочет решить. */
  readonly problem: string | null;
  /** Особенности со слов клиента. */
  readonly specifics: string | null;
  /**
   * Клиент согласился, что трудность у него есть, или сам рассказал о своей задаче; раз выяснив, не теряется. false:
   * ещё не выяснено.
   */
  readonly problemAgreed: boolean;
  /**
   * Поля, значение которых выведено из слов клиента, а не сказано прямо (пункт 4 задания 29.10.2026): менеджеру и
   * модели они показываются с «вероятно». Для минимума вывод считается выясненным, пока клиент не скажет иначе.
   */
  readonly inferred: readonly ProfileFact[];
}

/** Поля выжимки со значением, которое может быть выводом из слов клиента. */
export type ProfileFact = Exclude<keyof ClientProfile, 'problemAgreed' | 'inferred'>;

/** Все поля выжимки со значением, по порядку ClientProfile: так же хранятся и показываются пометки «вероятно». */
export const PROFILE_FACTS: readonly ProfileFact[] = [
  'business',
  'items',
  'packaging',
  'material',
  'city',
  'premises',
  'area',
  'scope',
  'itemCount',
  'monthlyIntake',
  'turnover',
  'passages',
  'shelfRecount',
  'currentTracking',
  'has1C',
  'oneCName',
  'problem',
  'specifics',
];

/**
 * Этап разговора (knowledge/consult.md, раздел 5; решение владельца 30.10.2026): знакомство, крючок (боль и плюс, вопрос
 * о RFID), как это работает, боли и детали для расчёта, финал (сводка и передача коллеге).
 */
export type ConversationStage = 'intro' | 'hook' | 'explain' | 'details' | 'final';

/** Этапы по порядку разговора. */
export const CONVERSATION_STAGES: readonly ConversationStage[] = [
  'intro',
  'hook',
  'explain',
  'details',
  'final',
];

/** Номер сильной стороны Tanbala из knowledge/consult.md (раздел 2): нужен системе, клиенту не пишется. */
export type StrengthId = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7' | 'F8' | 'F9' | 'F10';

/** Номера сильных сторон по порядку: так они хранятся и показываются. */
export const STRENGTH_IDS: readonly StrengthId[] = [
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
];

/**
 * Отметки отправленного ответа модели: на каком этапе он написан и какие сильные стороны в нём рассказаны. stage null:
 * черновик этапа не назвал (подделки LLM в тестах), прежний этап тогда не меняется.
 */
export interface ReplyMarks {
  readonly stage: ConversationStage | null;
  readonly usedFacts: readonly StrengthId[];
}

/**
 * Что оценка интереса узнала о последних сообщениях клиента, на которые бот сейчас отвечает (не выжимка):
 * спрашивает ли он цену, сроки или договор (priceAsked, с 30.10.2026 и сроки и договор) и отказывается ли отвечать на
 * вопросы бота.
 */
export interface TurnSignals {
  readonly priceAsked: boolean;
  readonly refused: boolean;
}

/**
 * Заметка для бота (указание коллеги), которую менеджер оставил при возврате чата из панели: доверенный текст, клиенту
 * не виден, действует до следующей передачи (решение владельца 29.10.2026).
 */
export interface BotNote {
  readonly text: string;
  readonly atMs: number;
}

/** Какая проверка отклонила черновик: проверки кодом (checks/code-checks.ts) или второй вызов (agent/review.ts). */
export type RejectionSource = 'code' | 'review';

/**
 * Отклонённый черновик ответа для панели (пункт 7 задания 29.10.2026): текст модели и замечания проверки, номер попытки
 * и время. Хранится 30 дней, только в базе и в карточке чата за паролем панели; в общий лог не пишется.
 */
export interface RejectedDraft {
  readonly chatId: ChatId;
  readonly attempt: 1 | 2;
  readonly source: RejectionSource;
  readonly draft: string;
  readonly remarks: readonly string[];
  readonly atMs: number;
}

/** Отклонённый черновик из базы. */
export interface StoredRejectedDraft extends RejectedDraft {
  readonly id: number;
}

/**
 * Ход разговора о цене с последнего возврата чата боту (или с начала): сколько раз клиент спрашивал цену (сроки или
 * договор) в ходах, на которые бот ответил, отказывался ли он отвечать на вопросы и сколько ходов подряд уходит от
 * вопросов. Третий вопрос цены и два ухода от вопросов подряд передают чат (решение владельца 30.10.2026).
 */
export interface ChatProgress {
  readonly priceAsks: number;
  /** Клиент хоть раз отказывался отвечать на вопросы бота (для панели). */
  readonly refused: boolean;
  /**
   * Сколько последних ходов подряд, на которые бот ответил, клиент уходит от вопросов (оценка интереса refused); ход без
   * отказа и возврат чата боту обнуляют. Нет поля => ноль.
   */
  readonly refusedStreak?: number;
  /**
   * Чат хоть раз передавался менеджеру, по любой причине (есть запись в handoffs); возврат боту этого не снимает. После
   * передачи финал не предлагается (agent/stage.ts). Нет поля => не передавался.
   */
  readonly handedOff?: boolean;
  /**
   * Сильные стороны, уже рассказанные в отправленных ответах бота, по порядку F1…F10 (решение владельца 30.10.2026).
   * Возврат чата боту их не обнуляет. Нет поля => ничего не рассказано.
   */
  readonly toldFacts?: readonly StrengthId[];
  /** Самый дальний этап отправленных ответов бота (текст модели). Нет поля => бот ещё не отвечал текстом модели. */
  readonly lastStage?: ConversationStage;
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

/**
 * Рабочий режим (этап 8, TEST_MODE=false): бот отвечает всем чатам, кроме тех, что были на номере до перехода
 * (pipeline/working-mode.ts). Номера TEST_ALLOWLIST работают как в закрытом режиме: правило перехода их не трогает.
 */
export interface WorkingMode {
  /** Граница: момент последнего перехода TEST_MODE true => false, мс UTC (app_state). */
  readonly sinceMs: number;
  /** TEST_ALLOWLIST: чаты с этих номеров граница и правило перехода не касаются. */
  readonly allowlist: ReadonlySet<PhoneDigits>;
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
  /**
   * Подтверждённое имя бизнес-аккаунта (verifiedBizName): недоверенный текст, очищенный как pushName. Нет у
   * обычных аккаунтов; поле может отсутствовать.
   */
  readonly verifiedName?: string | null;
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

/** Чат, где сообщения за время простоя бота старше порога BACKLOG_MAX_AGE_HOURS: бот на них не отвечал. */
export interface BacklogChat {
  /** ID чата в панели. */
  readonly chatId: ChatId;
  /** Имя из профиля WhatsApp: недоверенный текст. */
  readonly name: string | null;
  /** Номер клиента; null, если чат пришёл только с адресом @lid. */
  readonly phone: PhoneDigits | null;
  /** Время последнего такого сообщения, мс UTC. */
  readonly lastMessageAtMs: number;
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

/**
 * Входящее клиента без ответа после последнего исходящего (бота или человека): после возврата чата боту его снова
 * отдают в очередь ответа (решение владельца 29.10.2026). У голосового без расшифровки text null.
 */
export interface UnansweredInbound {
  readonly waId: WaMessageId;
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
 * Исходы ответа, после которых чат уходит менеджеру, а сообщение клиенту пишет сама модель: hot (основное о бизнесе
 * собрано, клиент спрашивает цену, сроки или договор), no_answer (ответа нет в знаниях), asked_human (клиент прямо
 * просит живого человека). Решение о передаче принимает вызов ответа, а не оценка интереса.
 */
export type ReplyHandoffOutcome = Extract<HandoffReason, 'hot' | 'no_answer' | 'asked_human'>;

/**
 * Черновик ответа клиенту (первый вызов LLM). Текст модели уходит клиенту только после проверок кодом и второго
 * вызова: при answer как ответ, при hot, no_answer и asked_human как сообщение о передаче (ответ на то, что есть
 * в знаниях, и одна фраза о передаче коллеге). У исходов передачи text может быть пустым: тогда нечего
 * проверять и клиенту уходит фиксированная фраза по причине. complaint без текста: фраза фиксированная, при
 * stopRequested только извинение.
 */
export type ReplyDraft =
  | {
      readonly outcome: 'answer';
      readonly text: string;
      /** О чём из компании спросил ответ (вопрос задаётся один раз); нет поля => ни о чём. */
      readonly companyQuestion?: CompanyQuestion;
      /**
       * Модель считает, что клиент спрашивал цену; нет поля => false. Запасной сигнал вопроса цены: им конвейер
       * пользуется, только если оценка интереса этого хода не вернула сигналов (pipeline/price-gate.ts).
       */
      readonly aboutPrice?: boolean;
      /** Этап разговора, на котором написан text; нет поля => модель не назвала (подделки LLM в тестах). */
      readonly stage?: ConversationStage;
      /** Сильные стороны (consult.md), которые есть в text, без дублей; нет поля => ни одной. */
      readonly usedFacts?: readonly StrengthId[];
    }
  | {
      readonly outcome: ReplyHandoffOutcome;
      readonly text: string;
      /**
       * Клиент в последних сообщениях спрашивал цену или стоимость; нет поля => false (подделки LLM в тестах его
       * не пишут). У hot с фиксированной фразой клиенту уходит фраза о цене (HandoffNotice).
       */
      readonly aboutPrice?: boolean;
      /** Этап разговора, на котором написан text; нет поля => модель не назвала. */
      readonly stage?: ConversationStage;
      /** Сильные стороны (consult.md), которые есть в text, без дублей; нет поля => ни одной. */
      readonly usedFacts?: readonly StrengthId[];
    }
  | { readonly outcome: Extract<HandoffReason, 'complaint'>; readonly stopRequested: boolean };

/** Итог проверки черновика вторым вызовом LLM: нет ли фактов не из знаний, цен, скидок, сроков, объёмов. */
export type ReviewResult =
  { readonly ok: true } | { readonly ok: false; readonly problems: readonly string[] };

/** Оценка интереса клиента и обновлённая выжимка (третий вызов LLM). */
export interface InterestAssessment {
  readonly level: InterestLevel;
  readonly profile: ClientProfile;
  readonly reason: string;
  /** Что клиент сказал о своей компании; нет поля => оценка о компании ничего не вернула. */
  readonly company?: CompanyMention;
  /** Спрашивает ли клиент цену сейчас и отказывается ли отвечать; нет поля => оценка этого не вернула. */
  readonly signals?: TurnSignals;
}

/** Открытая передача чата менеджеру: причина, уровень интереса на момент передачи и время. */
export interface OpenHandoff {
  readonly reason: HandoffReason;
  readonly level: InterestLevel;
  readonly openedAtMs: number;
}

/** Вид уведомления менеджеру: передача чата, исчерпанный лимит или список чатов простоя. */
export type ManagerNotificationKind = 'handoff' | 'limit' | 'backlog';

/**
 * Судьба уведомления менеджеру, видна в панели. pending: записано, отправка идёт; sent: доставлено на
 * MANAGER_WHATSAPP; no_manager: номер менеджера не задан, уведомление только в панели (в логе строка без
 * номеров и текста); skipped_limit: исчерпана часовая квота уведомлений, только в панели; failed: сбой
 * отправки, будет повтор.
 */
export type ManagerNotificationStatus =
  'pending' | 'sent' | 'no_manager' | 'skipped_limit' | 'failed';

/** Уведомление менеджеру в базе: текст целиком, чтобы панель показала его и при пустом MANAGER_WHATSAPP. */
export interface ManagerNotification {
  readonly id: number;
  readonly kind: ManagerNotificationKind;
  /** Чат клиента; null у списка чатов простоя. */
  readonly chatId: ChatId | null;
  readonly text: string;
  readonly status: ManagerNotificationStatus;
  /** Сколько раз пробовали отправить. */
  readonly attempts: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** Строка списка чатов в панели. */
export interface PanelChatRow {
  readonly chat: Chat;
  /** Время последнего сообщения в чате (любого автора), мс UTC; null, если сообщений нет. */
  readonly lastMessageAtMs: number | null;
  readonly openHandoff: OpenHandoff | null;
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
