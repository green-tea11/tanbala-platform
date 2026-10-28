import type { ChatCompanyState } from '../domain/company.js';
import type { ChatId } from '../domain/types.js';
import type { CompanyEnv } from './env.js';
import { logFailure } from './log.js';
import { withBrief } from './transitions.js';

/**
 * Справка подтверждённой компании: запрашивается, если её ещё нет, один раз за вызов. Сбой (API недоступно, компании
 * нет) не бросается: справки нет, бот отвечает без болей и рубрики, а следующая пачка попробует снова.
 */
export async function ensureBrief(
  env: CompanyEnv,
  chatId: ChatId,
  state: ChatCompanyState,
): Promise<ChatCompanyState> {
  const { confirmed } = state;
  if (confirmed === null || confirmed.brief !== null) return state;
  const result = await env.directory.brief(confirmed.id);
  if (!result.ok) {
    logFailure(env.logger, chatId, 'brief', result.failure);
    return state;
  }
  return withBrief(state, result.value, env.clock.now());
}
