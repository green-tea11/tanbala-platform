import type { ChatCompaniesRepo, ChatCompanyState, CompanyMention } from '../domain/company.js';
import type { Clock } from '../domain/ports.js';
import type { ChatId } from '../domain/types.js';
import { ensureBrief } from './brief.js';
import type { CompanyEnv } from './env.js';
import { mergeClientPains } from './pains.js';
import {
  confirmCandidate,
  rejectCandidate,
  stopAwaiting,
  withStatedCompany,
} from './transitions.js';

/**
 * Ответ клиента на вопрос бота «Вы из компании X?». Вопрос задавался (askedAtMs не null): «да» подтверждает кандидата
 * и сразу запрашивает справку, «нет» отклоняет его навсегда. Ответа не было: ожидание снимается, и вопрос больше
 * не задаётся. Если вопроса не было, чужое «да» или «нет» игнорируется.
 */
async function applyAnswer(
  env: CompanyEnv,
  chatId: ChatId,
  state: ChatCompanyState,
  answer: CompanyMention['answer'],
): Promise<ChatCompanyState> {
  const { candidate } = state;
  if (candidate === null) return state;
  if (answer === 'none') return stopAwaiting(state);
  if (candidate.askedAtMs === null) return state;
  if (answer === 'no') {
    env.logger.info({ chatId, step: 'answer', answer }, 'Клиент отклонил предложенную компанию');
    return rejectCandidate(state);
  }
  env.logger.info({ chatId, step: 'answer', answer }, 'Клиент подтвердил компанию');
  return ensureBrief(env, chatId, confirmCandidate(state, env.clock.now()));
}

/**
 * Итог оценки интереса: ответ на вопрос о кандидате, название и город со слов клиента, боли клиента. Всё
 * сохраняется одной записью; возвращается новое состояние.
 */
export async function applyMention(
  env: CompanyEnv,
  chatId: ChatId,
  mention: CompanyMention,
): Promise<ChatCompanyState> {
  const answered = await applyAnswer(env, chatId, env.repo.get(chatId), mention.answer);
  const state: ChatCompanyState = {
    ...withStatedCompany(answered, mention),
    confirmedPains: mergeClientPains(answered.confirmedPains, mention.pains),
  };
  env.repo.save(state, env.clock.now());
  return state;
}

/** Функция выключена: из оценки сохраняются только боли клиента (для уведомления и панели). */
export function savePainsOnly(
  repo: ChatCompaniesRepo,
  clock: Pick<Clock, 'now'>,
  chatId: ChatId,
  pains: readonly string[],
): void {
  const state = repo.get(chatId);
  repo.save(
    { ...state, confirmedPains: mergeClientPains(state.confirmedPains, pains) },
    clock.now(),
  );
}
