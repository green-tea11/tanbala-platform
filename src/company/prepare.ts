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
import { pollResearch } from './research.js';
import { searchPhone } from './search-phone.js';
import { candidateFromLookup, withProfile } from './transitions.js';

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

/**
 * Шаг а: бизнес-профиль WhatsApp запрашивается один раз на чат (вид аккаунта и домен), результат записывается
 * сразу: если дальше что-то пойдёт не так, профиль второй раз не запрашивается.
 */
async function ensureProfile(
  env: CompanyEnv,
  chat: Chat,
  state: ChatCompanyState,
): Promise<ChatCompanyState> {
  if (state.profileKind !== null) return state;
  const profile = await env.contacts.businessProfile(contactJid(chat));
  const next = withProfile(state, profile);
  env.repo.save(next, env.clock.now());
  return next;
}

/**
 * Бесплатные шаги а, б, в (один раз на чат), пока нет кандидата и подтверждённой компании. Останавливается на первом
 * выбранном кандидате (шаги не засчитываются: после отказа клиента поиск пойдёт дальше). Если хоть один запрос
 * не получил ответа (API недоступно), шаги не засчитываются и повторятся на следующей пачке; остальные сбои
 * считаются пройденным шагом.
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
  let unavailable = false;
  for (const { source, query } of freeStepsOf(chat, messages, profiled)) {
    if (query === null) continue;
    const outcome = await lookupCompany(env, chat.id, source, query, profiled.rejectedIds);
    if (outcome.kind === 'found') {
      env.logger.info({ chatId: chat.id, step: source }, 'Найден кандидат компании');
      return { ...profiled, candidate: candidateFromLookup(outcome.candidate, source) };
    }
    unavailable ||= outcome.kind === 'unavailable';
  }
  return unavailable ? profiled : { ...profiled, freeStepsAtMs: env.clock.now() };
}

/**
 * Что делать перед ответом на пачку клиента: бесплатные шаги определения компании, справка подтверждённой
 * компании (если её ещё нет) и опрос идущей проверки новой компании. Состояние пишется только если оно изменилось.
 * Возвращает блок промпта и признак «ждём ответ клиента на вопрос о кандидате».
 */
export async function prepareTurn(
  env: CompanyEnv,
  chat: Chat,
  messages: readonly InboundMessage[],
): Promise<CompanyTurn> {
  const before = env.repo.get(chat.id);
  const searched = await runFreeSteps(env, chat, messages, before);
  const briefed = await ensureBrief(env, chat.id, searched);
  const state = await pollResearch(env, chat.id, briefed);
  if (state !== before) env.repo.save(state, env.clock.now());
  return { prompt: buildPrompt(state), awaitingAnswer: state.candidate?.awaitingAnswer ?? false };
}
