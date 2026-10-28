import type {
  ChatCompanyState,
  CompanyApiFailure,
  CompanyBrief,
  CompanyId,
  ResearchRequest,
  ResearchState,
  ResearchStatus,
} from '../domain/company.js';
import type { Chat, ChatId } from '../domain/types.js';
import type { CompanyEnv } from './env.js';
import { logFailure } from './log.js';
import { searchPhone } from './search-phone.js';
import { candidateFromBrief, isRunning, type RunningResearch } from './transitions.js';

/** Статус идущей проверки спрашивают не чаще раза в 5 с (контракт: опрашивать раз в 5 до 10 секунд). */
const RESEARCH_POLL_INTERVAL_MS = 5_000;

/** Проверка дольше 15 минут считается неудачной: обычно она занимает от одной до трёх минут. */
const RESEARCH_TIMEOUT_MS = 15 * 60_000;

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
 * Отказ при запуске проверки. API недоступно: ничего не записывается, запуск повторится при следующем вызове.
 * Дневной лимит проверок (rate_limited) или бюджет Claude (budget_exhausted): проверка failed с этой причиной,
 * бот работает без справки. Прочие сбои: failed без причины.
 */
function refuseResearch(
  env: CompanyEnv,
  chatId: ChatId,
  state: ChatCompanyState,
  failure: CompanyApiFailure,
): ChatCompanyState {
  logFailure(env.logger, chatId, 'research_start', failure);
  if (failure === 'unavailable') return state;
  const reason = failure === 'rate_limited' || failure === 'budget_exhausted' ? failure : null;
  return failResearch(env, chatId, state, reason);
}

/**
 * Проект B ответил на запуск «компания уже есть и оценена»: справка по company_id, кандидат с источником research.
 * Компанию, которую клиент уже отклонил, не предлагают и справку по ней не берут. Справка недоступна: ничего
 * не записывается, запуск повторится при следующем вызове (повторный запрос той же компании бесплатный).
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
  if (!result.ok) {
    logFailure(env.logger, chatId, 'brief', result.failure);
    return state;
  }
  return finishResearch(env, chatId, state, result.value);
}

/**
 * Запуск проверки новой компании (один раз на чат): название со слов клиента, его город, номер из адреса с номером
 * и домен из бизнес-профиля. Компания уже есть: сразу кандидат из справки; задача поставлена: состояние
 * queued с временем запуска; отказ: см. refuseResearch.
 */
export async function startResearch(
  env: CompanyEnv,
  chat: Chat,
  state: ChatCompanyState,
  name: string,
): Promise<ChatCompanyState> {
  const request: ResearchRequest = {
    name,
    city: state.statedCity,
    phone: searchPhone(chat.identity.pnJid),
    domain: state.profileDomain,
  };
  const result = await env.directory.startResearch(request);
  if (!result.ok) return refuseResearch(env, chat.id, state, result.failure);
  if (result.value.kind === 'done') {
    return adoptReadyCompany(env, chat.id, state, result.value.companyId);
  }
  const nowMs = env.clock.now();
  env.logger.info(
    { chatId: chat.id, step: 'research', status: 'queued' },
    'Проверка новой компании запущена',
  );
  return {
    ...state,
    research: {
      status: 'queued',
      jobId: result.value.jobId,
      startedAtMs: nowMs,
      checkedAtMs: nowMs,
    },
  };
}
