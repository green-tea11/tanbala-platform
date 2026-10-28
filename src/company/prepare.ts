import type {
  CandidateSource,
  ChatCompanyState,
  CompanyLookupQuery,
  CompanyTurn,
} from '../domain/company.js';
import type { Chat, InboundMessage } from '../domain/types.js';
import { ensureBrief } from './brief.js';
import { contactJid, type CompanyEnv } from './env.js';
import { lookupCompany } from './lookup-step.js';
import { buildPrompt } from './prompt.js';
import { profileNameForSearch } from './profile-name.js';
import { recheckCandidate } from './recheck.js';
import { pollResearch } from './research.js';
import { searchPhone } from './search-phone.js';
import { candidateFromLookup, withProfile } from './transitions.js';

/** Бизнес-профиль запрашивается не больше трёх раз на чат: первый запрос и два повтора после сбоя. */
const MAX_PROFILE_REQUESTS = 3;

/** Шаг бесплатного поиска: откуда ищем и что искать; null: по этому шагу искать нечего (нет домена, номера, имени). */
interface FreeStep {
  readonly source: CandidateSource;
  readonly query: CompanyLookupQuery | null;
}

/**
 * Имя профиля для шага в из пачки: verifiedName или pushName последнего сообщения, где хоть одно из них есть.
 * Пустые строки именем не считаются.
 */
function profileNameOf(
  messages: readonly InboundMessage[],
  profileKind: ChatCompanyState['profileKind'],
): string | null {
  const named = messages.findLast(
    (message) =>
      (message.verifiedName ?? '').trim() !== '' || (message.pushName ?? '').trim() !== '',
  );
  if (named === undefined) return null;
  return profileNameForSearch({
    verifiedName: named.verifiedName ?? null,
    pushName: named.pushName,
    profileKind,
  });
}

/** Бесплатные шаги по порядку: а (домен из бизнес-профиля), б (номер), в (имя профиля). */
function freeStepsOf(
  chat: Chat,
  messages: readonly InboundMessage[],
  state: ChatCompanyState,
): readonly FreeStep[] {
  const phone = searchPhone(chat.identity.pnJid);
  const name = profileNameOf(messages, state.profileKind);
  return [
    {
      source: 'profile_domain',
      query: state.profileDomain === null ? null : { by: 'domain', domain: state.profileDomain },
    },
    { source: 'phone', query: phone === null ? null : { by: 'phone', phone } },
    { source: 'profile_name', query: name === null ? null : { by: 'name', name } },
  ];
}

/** Профиль ещё нужно запросить: не запрашивали или прошлый запрос не удался, а повторы не исчерпаны. */
function profilePending(state: ChatCompanyState): boolean {
  const known = state.profileKind === 'business' || state.profileKind === 'personal';
  return !known && state.profileRequests < MAX_PROFILE_REQUESTS;
}

/**
 * Шаг а: бизнес-профиль WhatsApp (вид аккаунта и домен). Запрашивается, пока не получен, но не больше трёх раз на чат;
 * результат записывается сразу: если дальше что-то пойдёт не так, удачный запрос не повторится.
 */
async function ensureProfile(
  env: CompanyEnv,
  chat: Chat,
  state: ChatCompanyState,
): Promise<ChatCompanyState> {
  if (!profilePending(state)) return state;
  const profile = await env.contacts.businessProfile(contactJid(chat));
  const next = withProfile(state, profile);
  env.repo.save(next, env.clock.now());
  return next;
}

/**
 * Бесплатные шаги а, б, в (один раз на чат), пока нет кандидата и подтверждённой компании. Останавливается на первом
 * выбранном кандидате; шаги засчитываются (после отказа клиента они не повторяются). Если хоть один запрос не получил
 * ответа по существу (LookupOutcome retry) или бизнес-профиль не получен и его ещё можно запросить, шаги не
 * засчитываются и повторятся на следующей пачке.
 */
async function runFreeSteps(
  env: CompanyEnv,
  chat: Chat,
  messages: readonly InboundMessage[],
  state: ChatCompanyState,
): Promise<ChatCompanyState> {
  if (state.freeStepsAtMs !== null || state.candidate !== null || state.confirmed !== null) {
    return state;
  }
  const profiled = await ensureProfile(env, chat, state);
  let retry = profilePending(profiled);
  for (const { source, query } of freeStepsOf(chat, messages, profiled)) {
    if (query === null) continue;
    const outcome = await lookupCompany(env, chat.id, source, query, profiled.rejectedIds);
    if (outcome.kind === 'found') {
      env.logger.info({ chatId: chat.id, step: source }, 'Найден кандидат компании');
      const candidate = candidateFromLookup(outcome.candidate, source);
      return { ...profiled, candidate, freeStepsAtMs: env.clock.now() };
    }
    retry ||= outcome.kind === 'retry';
  }
  return retry ? profiled : { ...profiled, freeStepsAtMs: env.clock.now() };
}

/**
 * Что делать перед ответом на пачку клиента: бесплатные шаги определения компании, поиск по названию клиента, если
 * он уже назвал компанию, а кандидат есть (recheckCandidate: другой ID заменяет кандидата до ответа), справка
 * подтверждённой компании (если её ещё нет) и опрос идущей проверки новой компании. Состояние пишется только если оно
 * изменилось. Возвращает блок промпта и признак «ждём ответ клиента на вопрос о кандидате».
 */
export async function prepareTurn(
  env: CompanyEnv,
  chat: Chat,
  messages: readonly InboundMessage[],
): Promise<CompanyTurn> {
  const before = env.repo.get(chat.id);
  const found = await runFreeSteps(env, chat, messages, before);
  const searched = await recheckCandidate(env, chat.id, found);
  const briefed = await ensureBrief(env, chat.id, searched);
  const state = await pollResearch(env, chat.id, briefed);
  if (state !== before) env.repo.save(state, env.clock.now());
  return { prompt: buildPrompt(state), awaitingAnswer: state.candidate?.awaitingAnswer ?? false };
}
