import type {
  ChatCompanyState,
  CompanyApiFailure,
  CompanyApiResult,
  CompanyBrief,
  CompanyId,
  ResearchJobId,
  ResearchRequest,
  ResearchStart,
  ResearchState,
  ResearchStatus,
} from '../domain/company.js';
import type { Chat, ChatId } from '../domain/types.js';
import { isTransientBriefFailure } from './api-failures.js';
import type { CompanyEnv } from './env.js';
import { logFailure } from './log.js';
import { searchPhone } from './search-phone.js';
import { candidateFromBrief, isRunning, type RunningResearch } from './transitions.js';

/** Статус идущей проверки спрашивают не чаще раза в 5 с (контракт: опрашивать раз в 5 до 10 секунд). */
const RESEARCH_POLL_INTERVAL_MS = 5_000;

/** Проверка дольше 15 минут считается неудачной: обычно она занимает от одной до трёх минут. */
const RESEARCH_TIMEOUT_MS = 15 * 60_000;

/**
 * Свой дневной предел бота: не больше 10 запусков проверки новой компании за скользящие 24 часа на все чаты.
 * Константа в коде, а не настройка: каждая проверка тратит бюджет Claude в проекте B.
 */
export const RESEARCH_MAX_STARTS_PER_DAY = 10;

const RESEARCH_WINDOW_MS = 24 * 60 * 60_000;

/** После стольких ответов «компания уже есть» без справки запуск проверки больше не повторяется. */
const MAX_ADOPT_FAILURES = 3;

/**
 * Запуск не дошёл до проверки в проекте B (сеть, 5xx, отказ в доступе, неизвестный адрес): повтор при следующем
 * вызове, предел не тратится. timeout сюда не входит: запрос мог дойти, и повтор запустил бы вторую проверку.
 */
const RETRY_LATER: ReadonlySet<CompanyApiFailure> = new Set([
  'unavailable',
  'unauthorized',
  'not_found',
]);

/** Причина неудачи проверки в состоянии чата (null: причина неизвестна). */
type FailedReason = Extract<ResearchState, { readonly status: 'failed' }>['reason'];

/** Проверка закончилась неудачей: состояние failed с причиной. Причина кодом, без имён и названий. */
function failResearch(
  env: CompanyEnv,
  chatId: ChatId,
  state: ChatCompanyState,
  reason: FailedReason,
): ChatCompanyState {
  env.logger.info(
    { chatId, step: 'research', status: 'failed', reason },
    'Проверка новой компании не удалась',
  );
  return { ...state, research: { status: 'failed', reason, finishedAtMs: env.clock.now() } };
}

/**
 * Проверка закончилась успешно. Кандидат из справки появляется, только если компанию не отклонял клиент, нет
 * подтверждённой компании и нет другого кандидата (его, возможно, уже спрашивали).
 */
function finishResearch(
  env: CompanyEnv,
  chatId: ChatId,
  state: ChatCompanyState,
  brief: CompanyBrief,
): ChatCompanyState {
  const research: ResearchState = {
    status: 'done',
    companyId: brief.id,
    finishedAtMs: env.clock.now(),
  };
  const offer =
    state.confirmed === null && state.candidate === null && !state.rejectedIds.includes(brief.id);
  env.logger.info(
    { chatId, step: 'research', status: 'done', offered: offer },
    'Проверка новой компании завершена',
  );
  return { ...state, research, candidate: offer ? candidateFromBrief(brief) : state.candidate };
}

function applyStatus(
  env: CompanyEnv,
  chatId: ChatId,
  state: ChatCompanyState,
  research: RunningResearch,
  status: ResearchStatus,
): ChatCompanyState {
  switch (status.status) {
    case 'queued':
    case 'running':
      return {
        ...state,
        research: { ...research, status: status.status, checkedAtMs: env.clock.now() },
      };
    case 'done':
      return finishResearch(env, chatId, state, status.brief);
    case 'failed':
      return failResearch(env, chatId, state, status.reason);
    case 'not_found':
      return failResearch(env, chatId, state, 'not_found');
  }
}

/** Один опрос статуса. Сбой не бросается: время опроса обновляется, проверка остаётся идущей. */
async function pollOnce(
  env: CompanyEnv,
  chatId: ChatId,
  state: ChatCompanyState,
  research: RunningResearch,
): Promise<ChatCompanyState> {
  const result = await env.directory.researchStatus(research.jobId);
  if (!result.ok) {
    logFailure(env.logger, chatId, 'research_status', result.failure);
    return { ...state, research: { ...research, checkedAtMs: env.clock.now() } };
  }
  return applyStatus(env, chatId, state, research, result.value);
}

/**
 * Идущая проверка новой компании: статус опрашивается не чаще раза в 5 с. Завершена: кандидат из справки;
 * не удалась или проекту B задача неизвестна: состояние failed; всё ещё идёт дольше 15 минут с запуска: failed
 * с причиной timeout (сначала опрос: готовый результат важнее таймаута). Проверки нет или она закончилась:
 * состояние то же.
 */
export async function pollResearch(
  env: CompanyEnv,
  chatId: ChatId,
  state: ChatCompanyState,
): Promise<ChatCompanyState> {
  const { research } = state;
  if (!isRunning(research)) return state;
  const nowMs = env.clock.now();
  const due = nowMs - research.checkedAtMs >= RESEARCH_POLL_INTERVAL_MS;
  const polled = due ? await pollOnce(env, chatId, state, research) : state;
  const current = polled.research;
  if (!isRunning(current) || nowMs - current.startedAtMs <= RESEARCH_TIMEOUT_MS) return polled;
  return failResearch(env, chatId, polled, 'timeout');
}

/**
 * Отказ при запуске проверки. Запрос не дошёл до проверки (RETRY_LATER): ничего не записывается, запуск повторится
 * при следующем вызове. Нет ответа за 3 с (timeout): запрос мог дойти, failed с причиной timeout, повтора нет.
 * Дневной лимит проверок (rate_limited) или бюджет Claude (budget_exhausted): failed с этой причиной, бот работает
 * без справки. Прочие сбои (bad_request, invalid_response): failed без причины.
 */
function refuseResearch(
  env: CompanyEnv,
  chatId: ChatId,
  state: ChatCompanyState,
  failure: CompanyApiFailure,
): ChatCompanyState {
  logFailure(env.logger, chatId, 'research_start', failure);
  if (RETRY_LATER.has(failure)) return state;
  const named =
    failure === 'rate_limited' || failure === 'budget_exhausted' || failure === 'timeout';
  return failResearch(env, chatId, state, named ? failure : null);
}

/**
 * Проект B ответил на запуск «компания уже есть и оценена»: справка по company_id, кандидат с источником research.
 * Компанию, которую клиент уже отклонил, не предлагают и справку по ней не берут. Справка не получена: проверка не
 * записывается, запуск повторится при следующем вызове (повторный запрос той же компании бесплатный). Временный сбой
 * справки (isTransientBriefFailure) неудачей не считается; после трёх постоянных проверка failed без причины и больше
 * не повторяется.
 */
async function adoptReadyCompany(
  env: CompanyEnv,
  chatId: ChatId,
  state: ChatCompanyState,
  companyId: CompanyId,
): Promise<ChatCompanyState> {
  if (state.rejectedIds.includes(companyId)) {
    return { ...state, research: { status: 'done', companyId, finishedAtMs: env.clock.now() } };
  }
  const result = await env.directory.brief(companyId);
  if (result.ok) return finishResearch(env, chatId, state, result.value);
  logFailure(env.logger, chatId, 'brief', result.failure);
  if (isTransientBriefFailure(result.failure)) return state;
  const failed = { ...state, adoptFailures: state.adoptFailures + 1 };
  return failed.adoptFailures >= MAX_ADOPT_FAILURES
    ? failResearch(env, chatId, failed, null)
    : failed;
}

/** Задача поставлена в очередь: состояние queued с временем запуска. */
function queueResearch(
  env: CompanyEnv,
  chatId: ChatId,
  state: ChatCompanyState,
  jobId: ResearchJobId,
): ChatCompanyState {
  const nowMs = env.clock.now();
  env.logger.info(
    { chatId, step: 'research', status: 'queued' },
    'Проверка новой компании запущена',
  );
  return {
    ...state,
    research: { status: 'queued', jobId, startedAtMs: nowMs, checkedAtMs: nowMs },
  };
}

/**
 * Запрос проверки: название со слов клиента, его город, домен из бизнес-профиля и номер из адреса с номером, но
 * номер только у бизнес-аккаунта (номер частного человека в проверку компании не отдаём).
 */
function researchRequest(chat: Chat, state: ChatCompanyState, name: string): ResearchRequest {
  return {
    name,
    aliases: [],
    city: state.statedCity,
    phone: state.profileKind === 'business' ? searchPhone(chat.identity.pnJid) : null,
    domain: state.profileDomain,
  };
}

/**
 * Мог ли запуск начать работу в проекте B: задача поставлена, ответа нет за 3 с или ответ не по контракту.
 * Только такие запуски остаются в дневном пределе.
 */
function mayHaveStarted(result: CompanyApiResult<ResearchStart>): boolean {
  if (result.ok) return result.value.kind === 'queued';
  return result.failure === 'timeout' || result.failure === 'invalid_response';
}

/**
 * Запуск проверки новой компании (один раз на чат). Сначала свой дневной предел на весь бот: за 24 часа уже
 * RESEARCH_MAX_STARTS_PER_DAY запусков => проверка не запускается, состояние то же (повтор позже), предупреждение
 * без названий. Иначе отметка запуска пишется в базу до запроса (так предел видит запуск, пока ждём ответа) и
 * снимается, если запуск не мог начать работу в проекте B. Компания уже есть: см. adoptReadyCompany; задача
 * поставлена: queued; отказ: см. refuseResearch.
 */
export async function startResearch(
  env: CompanyEnv,
  chat: Chat,
  state: ChatCompanyState,
  name: string,
): Promise<ChatCompanyState> {
  const nowMs = env.clock.now();
  const windowStartMs = Math.max(0, nowMs - RESEARCH_WINDOW_MS);
  if (env.repo.countResearchStarts(windowStartMs) >= RESEARCH_MAX_STARTS_PER_DAY) {
    env.logger.warn(
      { chatId: chat.id, step: 'research_start', limit: RESEARCH_MAX_STARTS_PER_DAY },
      'Дневной предел проверок новых компаний исчерпан: проверка будет позже',
    );
    return state;
  }
  const reserved = { ...state, researchStartedAtMs: nowMs };
  env.repo.save(reserved, nowMs);
  const result = await env.directory.startResearch(researchRequest(chat, state, name));
  const started = mayHaveStarted(result)
    ? reserved
    : { ...reserved, researchStartedAtMs: state.researchStartedAtMs };
  if (!result.ok) return refuseResearch(env, chat.id, started, result.failure);
  if (result.value.kind === 'done') {
    return adoptReadyCompany(env, chat.id, started, result.value.companyId);
  }
  return queueResearch(env, chat.id, started, result.value.jobId);
}
