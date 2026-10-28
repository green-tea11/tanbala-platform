import type { ChatCandidate, ChatCompanyState } from '../domain/company.js';
import type { Chat } from '../domain/types.js';
import { clipText } from './clip-text.js';
import { contactJid, type CompanyEnv } from './env.js';
import { logFailure } from './log.js';
import { lookupCompany } from './lookup-step.js';
import { normalizeName } from './normalize-name.js';
import { startResearch } from './research.js';
import { candidateFromLookup } from './transitions.js';

/** Фото профиля тяжелее не скачивается: так вызов модели с картинкой остаётся дешёвым и быстрым. */
const MAX_PHOTO_BYTES = 1_000_000;

/** Название с логотипа: слова модели, длиннее 200 знаков проект B не примет. */
const MAX_LOGO_NAME_CHARS = 200;

/**
 * Шаг г: поиск по названию со слов клиента. Название уже искали (после нормализации то же): повторный поиск не нужен,
 * но проверка новой компании, которой ещё не было, запускается (так повторяется запуск, не получивший ответа).
 * Поиск не получил ответа (API недоступно): ничего не запоминается и проверка не запускается, повтор позже.
 * Не нашли и проверки ещё не было: запуск проверки новой компании (один раз на чат).
 */
async function identifyByName(
  env: CompanyEnv,
  chat: Chat,
  state: ChatCompanyState,
  name: string,
): Promise<ChatCompanyState> {
  const normalized = normalizeName(name);
  if (normalized === '') return state;
  let searched = state;
  if (normalized !== state.lookedUpName) {
    const outcome = await lookupCompany(
      env,
      chat.id,
      'message',
      { by: 'name', name },
      state.rejectedIds,
    );
    if (outcome.kind === 'unavailable') return state;
    searched = { ...state, lookedUpName: normalized };
    if (outcome.kind === 'found') {
      env.logger.info({ chatId: chat.id, step: 'message' }, 'Найден кандидат компании');
      return { ...searched, candidate: candidateFromLookup(outcome.candidate, 'message') };
    }
  }
  return searched.research === null ? startResearch(env, chat, searched, name) : searched;
}

/** Кандидат по названию, прочитанному с логотипа на фото профиля; null: фото нет, название не прочитано или не найдено. */
async function candidateFromLogo(
  env: CompanyEnv,
  chat: Chat,
  state: ChatCompanyState,
): Promise<ChatCandidate | null> {
  const photo = await env.contacts.profilePhoto(contactJid(chat), MAX_PHOTO_BYTES);
  if (photo === null) return null;
  const read = await env.logo.readLogo(chat.id, photo);
  if (!read.ok) {
    logFailure(env.logger, chat.id, 'logo', read.failure);
    return null;
  }
  const name = clipText(read.value, MAX_LOGO_NAME_CHARS);
  if (name === null || normalizeName(name) === '') return null;
  const outcome = await lookupCompany(
    env,
    chat.id,
    'logo',
    { by: 'name', name },
    state.rejectedIds,
  );
  return outcome.kind === 'found' ? candidateFromLookup(outcome.candidate, 'logo') : null;
}

/**
 * Шаг д: только у бизнес-аккаунта, у которого бесплатные шаги пройдены, и только если компания не определилась и
 * клиент её не назвал. Один раз на чат: отметка записывается до вызова модели, поэтому сбой после неё не приведёт к
 * повторным платным вызовам.
 */
async function identifyByLogo(
  env: CompanyEnv,
  chat: Chat,
  state: ChatCompanyState,
): Promise<ChatCompanyState> {
  if (state.profileKind !== 'business' || state.logoCheckedAtMs !== null) return state;
  if (state.freeStepsAtMs === null) return state;
  const checked = { ...state, logoCheckedAtMs: env.clock.now() };
  env.repo.save(checked, checked.logoCheckedAtMs);
  const candidate = await candidateFromLogo(env, chat, state);
  if (candidate === null) return checked;
  env.logger.info({ chatId: chat.id, step: 'logo' }, 'Найден кандидат компании');
  return { ...checked, candidate };
}

/** Шаг г, если клиент назвал компанию, иначе шаг д (логотип). */
function identifyStep(
  env: CompanyEnv,
  chat: Chat,
  state: ChatCompanyState,
): Promise<ChatCompanyState> {
  return state.statedName === null
    ? identifyByLogo(env, chat, state)
    : identifyByName(env, chat, state, state.statedName);
}

/**
 * После ответа клиенту: если компания ещё не определилась, шаг г (название со слов клиента, затем проверка новой
 * компании) или, когда клиент компанию не называл, шаг д (логотип). Состояние пишется только если оно изменилось.
 */
export async function identifyChat(env: CompanyEnv, chat: Chat): Promise<void> {
  const before = env.repo.get(chat.id);
  if (before.confirmed !== null || before.candidate !== null) return;
  const after = await identifyStep(env, chat, before);
  if (after !== before) env.repo.save(after, env.clock.now());
}
