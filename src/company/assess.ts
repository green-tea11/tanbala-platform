import type { ChatCompaniesRepo, ChatCompanyState, CompanyMention } from '../domain/company.js';
import type { Clock } from '../domain/ports.js';
import type { ChatId } from '../domain/types.js';
import { ensureBrief } from './brief.js';
import type { CompanyEnv } from './env.js';
import { mergeClientPains } from './pains.js';
import {
  confirmCandidate,
  dropForeignCandidate,
  rejectCandidate,
  withStatedCompany,
} from './transitions.js';

/**
 * Ответ клиента на вопрос бота «Вы из компании X?», только пока его ждём (вопрос в последнем отправленном ответе):
 * «да» подтверждает кандидата и сразу запрашивает справку, «нет» отклоняет его навсегда (дальше вопрос о названии).
 * Иначе чужое «да» или «нет» игнорируется. Ответа нет: ожидание остаётся, его снимет markAsked после отправки
 * ответа, поэтому при перегенерации пачки «да» из дописанного сообщения не теряется.
 */
async function applyAnswer(
  env: CompanyEnv,
  chatId: ChatId,
  state: ChatCompanyState,
  answer: CompanyMention['answer'],
): Promise<ChatCompanyState> {
  const { candidate } = state;
  if (candidate === null || !candidate.awaitingAnswer || answer === 'none') return state;
  if (answer === 'no') {
    env.logger.info({ chatId, step: 'answer', answer }, 'Клиент отклонил предложенную компанию');
    return rejectCandidate(state, env.clock.now());
  }
  env.logger.info({ chatId, step: 'answer', answer }, 'Клиент подтвердил компанию');
  return ensureBrief(env, chatId, confirmCandidate(state, env.clock.now()));
}

/**
 * Итог оценки интереса: ответ на вопрос о кандидате, название и город со слов клиента (другая названная компания
 * снимает ещё не спрошенного кандидата не по его словам), боли клиента. Всё сохраняется одной записью; возвращается
 * новое состояние.
 */
export async function applyMention(
  env: CompanyEnv,
  chatId: ChatId,
  mention: CompanyMention,
): Promise<ChatCompanyState> {
  const answered = await applyAnswer(env, chatId, env.repo.get(chatId), mention.answer);
  const nowMs = env.clock.now();
  const state: ChatCompanyState = {
    ...dropForeignCandidate(withStatedCompany(answered, mention), nowMs),
    confirmedPains: mergeClientPains(answered.confirmedPains, mention.pains),
  };
  env.repo.save(state, nowMs);
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
