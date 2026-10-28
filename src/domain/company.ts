// Компания клиента: данные внутреннего API почтового проекта (проект B) и состояние её определения в чате.
// Только типы, без кода. Контракт API: D-Email+WhatsApp/contract/INTERNAL_API.md (согласован владельцем 27.10.2026).
// Тексты из API недоверенные (с сайтов и из 2ГИС): в промпт модели они идут только внутри блока данных.

import type { ImageInput } from './ports.js';
import type { Chat, ChatId, InboundMessage, LlmResult, PhoneDigits } from './types.js';

/** ID компании в базе проекта B: положительное целое. Приводить к бренду только в адаптере API. */
export type CompanyId = number & { readonly __brand: 'CompanyId' };

/** ID задачи проверки новой компании (research) в проекте B: строка UUID. */
export type ResearchJobId = string & { readonly __brand: 'ResearchJobId' };

/** Как lookup нашёл компанию: по домену и телефону match_score 1.0, по названию не выше 0.9. */
export type CompanyMatchBy = 'domain' | 'phone' | 'name';

/** Кандидат из lookup (до трёх на запрос, по убыванию match_score). */
export interface CompanyCandidate {
  readonly id: CompanyId;
  readonly name: string;
  readonly city: string | null;
  readonly rubric: string | null;
  readonly matchBy: CompanyMatchBy;
  /** 0..1. */
  readonly matchScore: number;
  readonly emailed: boolean;
}

/**
 * Боль из справки: pain одна из девяти строк раздела 5 knowledge/tanbala-agent.md. evidence (дословная цитата
 * с сайта или из 2ГИС) и source только для менеджера в панели: модели они не передаются.
 */
export interface CompanyPain {
  readonly pain: string;
  readonly evidence: string | null;
  readonly source: 'site' | '2gis' | null;
}

export type CompanyFit = 'yes' | 'maybe' | 'no';

/** Справка о компании (GET /internal/companies/{id}/brief). */
export interface CompanyBrief {
  readonly id: CompanyId;
  readonly name: string;
  readonly city: string | null;
  readonly rubric: string | null;
  readonly segment: string | null;
  /** null: компанию ещё не оценивали. */
  readonly fit: CompanyFit | null;
  /** 0..100; null: не оценивали. */
  readonly fitScore: number | null;
  readonly reason: string | null;
  /** До двух болей, только подтверждённые проектом B. */
  readonly pains: readonly CompanyPain[];
  /** Мы уже писали этой компании на почту (тестовые отправки не считаются). */
  readonly emailed: boolean;
  /** ISO 8601 с часовым поясом или null. */
  readonly emailedAt: string | null;
  readonly emailSubject: string | null;
}

/** Запрос lookup: ровно один признак за вызов, шаги определения идут по очереди. */
export type CompanyLookupQuery =
  | { readonly by: 'domain'; readonly domain: string }
  | { readonly by: 'phone'; readonly phone: PhoneDigits }
  | { readonly by: 'name'; readonly name: string };

/** Запуск проверки новой компании (POST /internal/research). */
export interface ResearchRequest {
  readonly name: string;
  readonly city: string | null;
  readonly phone: PhoneDigits | null;
  readonly domain: string | null;
}

/** 200 done: компания уже есть и оценена; 202: задача в очереди. */
export type ResearchStart =
  | { readonly kind: 'done'; readonly companyId: CompanyId }
  | { readonly kind: 'queued'; readonly jobId: ResearchJobId };

/** Почему проверка завершилась неудачей (поле reason статуса). */
export type ResearchFailReason = 'not_in_2gis' | 'city_unsupported' | 'budget_exhausted' | 'error';

/** Статус проверки (GET /internal/research/{job_id}). */
export type ResearchStatus =
  | { readonly status: 'queued' | 'running' }
  | { readonly status: 'done'; readonly brief: CompanyBrief }
  | { readonly status: 'failed'; readonly reason: ResearchFailReason | null }
  | { readonly status: 'not_found' };

/**
 * Почему вызов API не дал результата. unavailable: сеть (отказ соединения), 503 и прочие 5xx или пауза после
 * сбоя; timeout: ответа нет за 3 с (запрос мог дойти: неидемпотентный запуск research после него не повторяется);
 * invalid_response: ответ не по контракту. Клиенту бот об этом ничего не пишет и работает без данных о компании.
 */
export type CompanyApiFailure =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'budget_exhausted'
  | 'unavailable'
  | 'timeout'
  | 'invalid_response';

/** Результат вызова API: сбой приходит значением, а не исключением. */
export type CompanyApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: CompanyApiFailure };

/**
 * Внутренний API почтового проекта (порт, адаптер в src/company-api). Выключен, пока INTERNAL_API_TOKEN пуст:
 * тогда бот работает как раньше, без данных о компании.
 */
export type CompanyDirectory =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      lookup(query: CompanyLookupQuery): Promise<CompanyApiResult<readonly CompanyCandidate[]>>;
      brief(id: CompanyId): Promise<CompanyApiResult<CompanyBrief>>;
      startResearch(request: ResearchRequest): Promise<CompanyApiResult<ResearchStart>>;
      researchStatus(jobId: ResearchJobId): Promise<CompanyApiResult<ResearchStatus>>;
    };

/** Откуда взят кандидат: шаги определения компании (а: домен из бизнес-профиля, б: номер, в: имя профиля,
 * г: название из слов клиента, д: логотип на фото профиля) и проверка новой компании. */
export type CandidateSource =
  'profile_domain' | 'phone' | 'profile_name' | 'message' | 'logo' | 'research';

/** Кандидат в чате: компания найдена, но клиент её ещё не подтвердил. */
export interface ChatCandidate {
  readonly id: CompanyId;
  readonly name: string;
  readonly city: string | null;
  readonly source: CandidateSource;
  /**
   * Когда бот спросил «Вы из компании X?» или назвал кандидата в отправленном ответе; null: ещё нет. После этого о
   * кандидате больше не спрашивают.
   */
  readonly askedAtMs: number | null;
  /**
   * Вопрос задан в последнем отправленном ответе бота (модель вернула confirm или название стоит в вопросе), ответа
   * ещё не было. Только пока true, «да» или «нет» из оценки интереса засчитываются. Снимается следующим отправленным
   * ответом без «да» или «нет» (markAsked), передачей чата менеджеру и возвратом чата боту (stopAwaiting).
   */
  readonly awaitingAnswer: boolean;
}

/** Компания, которую клиент подтвердил («да»). Только для неё справка идёт в промпт. */
export interface ConfirmedCompany {
  readonly id: CompanyId;
  readonly name: string;
  readonly city: string | null;
  readonly confirmedAtMs: number;
  /** Справка; null, пока не получена (API было недоступно): её запрашивают перед следующими ответами. */
  readonly brief: CompanyBrief | null;
  readonly briefAtMs: number | null;
}

/** Проверка новой компании в проекте B: не больше одной на чат. */
export type ResearchState =
  | {
      readonly status: 'queued' | 'running';
      readonly jobId: ResearchJobId;
      readonly startedAtMs: number;
      /** Когда последний раз спрашивали статус: не чаще раза в 5 с. */
      readonly checkedAtMs: number;
    }
  | { readonly status: 'done'; readonly companyId: CompanyId; readonly finishedAtMs: number }
  | {
      readonly status: 'failed';
      /**
       * reason из статуса задачи; rate_limited и budget_exhausted: отказ 429 при запуске; timeout: задача шла
       * слишком долго или запуск не получил ответа за 3 с (запрос мог дойти, повтора нет); not_found: проект B
       * не знает задачу.
       */
      readonly reason: ResearchFailReason | 'rate_limited' | 'timeout' | 'not_found' | null;
      readonly finishedAtMs: number;
    };

/** Состояние определения компании в чате: одна запись на чат, без записи всё null и пусто. */
export interface ChatCompanyState {
  readonly chatId: ChatId;
  /** Бизнес-профиль WhatsApp (шаг а): null ещё не запрашивали, unknown запрос не удался. */
  readonly profileKind: 'business' | 'personal' | 'unknown' | null;
  /** Сколько раз запрашивали бизнес-профиль: после сбоя запрос повторяется на следующих пачках, всего до трёх раз. */
  readonly profileRequests: number;
  /** Домен из бизнес-профиля (сайт или корпоративная почта); null: нет. */
  readonly profileDomain: string | null;
  /**
   * Бесплатные шаги а, б и в пройдены (один раз на чат: нашли кандидата, ничего не нашли или клиент отклонил
   * кандидата); null: ещё нет или API не ответило.
   */
  readonly freeStepsAtMs: number | null;
  /**
   * Шаг д закрыт: фото профиля проверено (один раз на чат, только у бизнес-аккаунта) или больше не нужно (клиент
   * отклонил кандидата).
   */
  readonly logoCheckedAtMs: number | null;
  /** Название и город компании со слов клиента (оценка интереса). */
  readonly statedName: string | null;
  readonly statedCity: string | null;
  /** Название, по которому уже искали (шаг г, после нормализации): по тому же названию повторно не ищут. */
  readonly lookedUpName: string | null;
  readonly candidate: ChatCandidate | null;
  /** Компании, от которых клиент отказался («нет, это не мы»): их больше не предлагать. */
  readonly rejectedIds: readonly CompanyId[];
  readonly confirmed: ConfirmedCompany | null;
  /**
   * Постоянные сбои запроса справки подтверждённой компании (временные: unavailable, timeout, unauthorized,
   * invalid_response не считаются): после трёх справку больше не запрашивают.
   */
  readonly briefFailures: number;
  /** Бот спросил, из какой компании клиент (шаг е): спрашивает один раз. */
  readonly nameAskedAtMs: number | null;
  readonly research: ResearchState | null;
  /**
   * Когда бот отправил запуск проверки новой компании, который мог начать работу в проекте B (задача поставлена,
   * ответа нет или ответ не по контракту); по этим отметкам считается дневной предел проверок на весь бот.
   */
  readonly researchStartedAtMs: number | null;
  /**
   * Запуск проверки ответил «компания уже есть», а справку получить не удалось из-за постоянного сбоя (временные не
   * считаются): после трёх таких запусков проверка больше не повторяется.
   */
  readonly adoptFailures: number;
  /** Боли, которые клиент подтвердил или назвал сам (оценка интереса): для уведомления и панели, до пяти. */
  readonly confirmedPains: readonly string[];
}

/** Состояние определения компании в базе: одна запись на чат. */
export interface ChatCompaniesRepo {
  /** Состояние чата; записи нет => пустое состояние (всё null, списки пустые). */
  get(chatId: ChatId): ChatCompanyState;
  /** Записывает состояние целиком. */
  save(state: ChatCompanyState, nowMs: number): void;
  /** Сколько чатов отправили запуск проверки новой компании позже sinceMs (researchStartedAtMs): дневной предел. */
  countResearchStarts(sinceMs: number): number;
}

/** О чём спросил ответ бота: подтвердить кандидата («Вы из компании X?»), назвать компанию или ни о чём. */
export type CompanyQuestion = 'none' | 'confirm' | 'name';

/**
 * Что оценка интереса узнала о компании из слов клиента. Строки недоверенные: их чистит agent/interest.ts,
 * а ищет по ним только API почтового проекта.
 */
export interface CompanyMention {
  /** Название компании клиента, если он сам его назвал; иначе null. */
  readonly name: string | null;
  /** Город компании со слов клиента; иначе null. */
  readonly city: string | null;
  /** Ответ на вопрос бота «Вы из компании X?»: yes, no или none (не отвечал или вопроса не было). */
  readonly answer: 'yes' | 'no' | 'none';
  /** Боли, с которыми клиент согласился или о которых рассказал сам, коротко; до трёх. */
  readonly pains: readonly string[];
}

/**
 * Что вызовы ответа, проверки и оценки интереса знают о компании клиента. Строки недоверенные: в промпт только
 * внутри блока данных. off: функция выключена, блока о компании нет и бот работает как раньше.
 */
export type CompanyPrompt =
  | { readonly kind: 'off' }
  /** Компания неизвестна. askName: можно один раз естественно спросить, из какой компании клиент. */
  | { readonly kind: 'unknown'; readonly askName: boolean }
  /** Клиент назвал компанию, идёт проверка: название снова не спрашивать. */
  | { readonly kind: 'searching' }
  /**
   * Найден кандидат, бот ещё не спрашивал: один раз спросить «Вы из компании X?». withCity: клиент назвал
   * компанию сам, спросить с городом («X, Алматы, верно?»).
   */
  | {
      readonly kind: 'candidate';
      readonly name: string;
      readonly city: string | null;
      readonly withCity: boolean;
    }
  /**
   * Бот уже спросил про кандидата: не переспрашивать. awaitingAnswer: вопрос задан в последнем отправленном ответе,
   * только тогда оценка интереса определяет «да» или «нет» (иначе случайное «да» на другой вопрос подтвердило бы
   * компанию).
   */
  | {
      readonly kind: 'asked';
      readonly name: string;
      readonly city: string | null;
      readonly awaitingAnswer: boolean;
    }
  /**
   * Клиент подтвердил компанию: из справки только боли и рубрика (без evidence, source и цифр о клиенте) и
   * писали ли мы этой компании на почту.
   */
  | {
      readonly kind: 'confirmed';
      readonly name: string;
      readonly rubric: string | null;
      readonly pains: readonly string[];
      readonly emailed: boolean;
    };

/** Что о компании видят менеджер в уведомлении и панель. */
export interface CompanySummary {
  /** off: функция выключена; unknown: не определена; candidate: найдена, клиент не подтвердил; confirmed: подтверждена. */
  readonly status: 'off' | 'unknown' | 'candidate' | 'confirmed';
  readonly companyId: CompanyId | null;
  readonly name: string | null;
  readonly city: string | null;
  readonly rubric: string | null;
  readonly candidateSource: CandidateSource | null;
  /** Ссылка на карточку в интерфейсе почтового проекта: EMAIL_UI_URL/companies/{id}; null без адреса или компании. */
  readonly cardUrl: string | null;
  readonly confirmedPains: readonly string[];
  /** Боли из справки с цитатой и источником: только менеджеру, не модели. */
  readonly briefPains: readonly CompanyPain[];
  /** Писали ли мы компании на почту; null: справки нет. */
  readonly emailed: boolean | null;
  readonly research: ResearchState | null;
  /** Название со слов клиента: панель показывает его, если компания не найдена. */
  readonly statedName: string | null;
}

/** Чтение названия компании с фото профиля (шаг д): вызов модели с картинкой. Сбой приходит значением. */
export interface LogoReader {
  readLogo(chatId: ChatId, photo: ImageInput): Promise<LlmResult<string | null>>;
}

/** Ход определения компании перед ответом. */
export interface CompanyTurn {
  readonly prompt: CompanyPrompt;
  /**
   * В прошлом ответе бот спросил «Вы из компании X?»: оценку интереса нужно получить до черновика, чтобы ответ
   * уже учёл «да» (справка) или «нет».
   */
  readonly awaitingAnswer: boolean;
}

/**
 * Определение компании клиента (src/company). Ни один метод не бросает из-за API или WhatsApp: сбой пишется в лог
 * без номеров, имён и текста, а бот работает без данных о компании.
 */
export interface CompanyService {
  /**
   * Перед ответом на пачку клиента: бесплатные шаги а, б, в (один раз на чат, временные сбои API повторяются),
   * повторный поиск по названию клиента, если уже есть кандидат и клиент назвал другую компанию, опрос идущей
   * проверки (не чаще раза в 5 с), справка подтверждённой компании, если её ещё нет. messages: пачка (verifiedName и
   * pushName из неё).
   */
  prepare(chat: Chat, messages: readonly InboundMessage[]): Promise<CompanyTurn>;
  /**
   * Итог оценки интереса: ответ на вопрос о компании, только пока ждём ответа (да => подтверждение и справка,
   * нет => кандидат сброшен, дальше вопрос о названии без повторного поиска), подтверждённые боли, название и город
   * со слов клиента. Ожидание здесь не снимается (это делает markAsked после отправки ответа): при перегенерации
   * пачки «да» из дописанного сообщения не теряется. null: оценки нет. Возвращает обновлённый блок промпта.
   */
  applyAssessment(chatId: ChatId, mention: CompanyMention | null): Promise<CompanyPrompt>;
  /**
   * Ответ ушёл клиенту (вызывается после каждого отправленного ответа бота). question: что модель сказала о своём
   * вопросе; sentText: отправленный текст. Вопрос о компании запоминается (каждый задаётся один раз), в том числе
   * если модель не отметила его, но в тексте есть название кандидата; ожидание ответа ставится, только если модель
   * вернула confirm или название стоит в вопросе. Ожидание ответа на «Вы из компании X?» снимается здесь, когда ответ
   * на пачку клиента ушёл, а «да» или «нет» в ней не было, а также в stopAwaiting.
   */
  markAsked(chatId: ChatId, question: CompanyQuestion, sentText: string): void;
  /**
   * Снять ожидание ответа на «Вы из компании X?» без отметки вопроса: чат ушёл менеджеру (после любой фразы или
   * сообщения передачи) или его вернули боту из панели. Иначе «да» на чужой вопрос подтвердило бы компанию.
   */
  stopAwaiting(chatId: ChatId): void;
  /**
   * После ответа: шаг г (поиск по названию со слов клиента; при уже найденном кандидате, если поиск нашёл другую
   * компанию, кандидат меняется), при неудаче проверка новой компании (один раз на чат, не больше 10 запусков за
   * 24 часа на весь бот), шаг д (логотип: только бизнес-аккаунт, один раз на чат, если остальное ничего не дало).
   */
  identifyAfterReply(chat: Chat): Promise<void>;
  /** Для уведомления менеджеру и панели. */
  summary(chatId: ChatId): CompanySummary;
}
