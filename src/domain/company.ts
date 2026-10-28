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
 * Почему вызов API не дал результата. unavailable: таймаут 3 с, сеть, 503 или пауза после такого сбоя;
 * invalid_response: ответ не по контракту. Клиенту бот об этом ничего не пишет и работает без данных о компании.
 */
export type CompanyApiFailure =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'budget_exhausted'
  | 'unavailable'
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
  /** Когда бот спросил «Вы из компании X?»; null: ещё не спрашивал. Спрашивает один раз. */
  readonly askedAtMs: number | null;
  /**
   * Вопрос задан в прошлом ответе бота, ответа ещё не было. Следующая пачка клиента решает: да, нет или без
   * ответа (тогда false, и вопрос больше не задаётся).
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
       * слишком долго; not_found: проект B не знает задачу.
       */
      readonly reason: ResearchFailReason | 'rate_limited' | 'timeout' | 'not_found' | null;
      readonly finishedAtMs: number;
    };

/** Состояние определения компании в чате: одна запись на чат, без записи всё null и пусто. */
export interface ChatCompanyState {
  readonly chatId: ChatId;
  /** Бизнес-профиль WhatsApp (шаг а), запрашивается один раз: null ещё не запрашивали, unknown запрос не удался. */
  readonly profileKind: 'business' | 'personal' | 'unknown' | null;
  /** Домен из бизнес-профиля (сайт или корпоративная почта); null: нет. */
  readonly profileDomain: string | null;
  /** Бесплатные шаги а, б и в пройдены (один раз на чат); null: ещё нет или API было недоступно. */
  readonly freeStepsAtMs: number | null;
  /** Шаг д пройден: фото профиля проверено (один раз на чат, только у бизнес-аккаунта). */
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
  /** Бот спросил, из какой компании клиент (шаг е): спрашивает один раз. */
  readonly nameAskedAtMs: number | null;
  readonly research: ResearchState | null;
  /** Боли, которые клиент подтвердил или назвал сам (оценка интереса): для уведомления и панели, до пяти. */
  readonly confirmedPains: readonly string[];
}

/** Состояние определения компании в базе: одна запись на чат. */
export interface ChatCompaniesRepo {
  /** Состояние чата; записи нет => пустое состояние (всё null, списки пустые). */
  get(chatId: ChatId): ChatCompanyState;
  /** Записывает состояние целиком. */
  save(state: ChatCompanyState, nowMs: number): void;
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
  /** Бот уже спросил про кандидата и ждёт ответа или ответа не было: не переспрашивать. */
  | { readonly kind: 'asked'; readonly name: string; readonly city: string | null }
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
   * Перед ответом на пачку клиента: бесплатные шаги а, б, в (один раз на чат), опрос идущей проверки (не чаще раза
   * в 5 с), справка подтверждённой компании, если её ещё нет. messages: пачка (verifiedName и pushName из неё).
   */
  prepare(chat: Chat, messages: readonly InboundMessage[]): Promise<CompanyTurn>;
  /**
   * Итог оценки интереса: ответ на вопрос о компании (да => подтверждение и справка, нет => кандидат сброшен),
   * подтверждённые боли, название и город со слов клиента. null: оценки нет. Возвращает обновлённый блок промпта.
   */
  applyAssessment(chatId: ChatId, mention: CompanyMention | null): Promise<CompanyPrompt>;
  /** Ответ ушёл клиенту: если в нём был вопрос о компании, запомнить (каждый вопрос задаётся один раз). */
  markAsked(chatId: ChatId, question: CompanyQuestion): void;
  /**
   * После ответа: шаг г (поиск по названию со слов клиента), при неудаче проверка новой компании (один раз на чат),
   * шаг д (логотип: только бизнес-аккаунт, один раз на чат, если остальное ничего не дало).
   */
  identifyAfterReply(chat: Chat): Promise<void>;
  /** Для уведомления менеджеру и панели. */
  summary(chatId: ChatId): CompanySummary;
}
