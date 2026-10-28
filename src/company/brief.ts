import type { ChatCompanyState, CompanyApiFailure } from '../domain/company.js';
import type { ChatId } from '../domain/types.js';
import type { CompanyEnv } from './env.js';
import { logFailure } from './log.js';
import { withBrief } from './transitions.js';

/** После стольких неудачных запросов справки (кроме временных сбоев) её больше не запрашивают. */
const MAX_BRIEF_FAILURES = 3;

/** Временные сбои: проект B не ответил или не дождались ответа. Их не считают, справку просто спросят снова. */
const TRANSIENT_FAILURES: ReadonlySet<CompanyApiFailure> = new Set(['unavailable', 'timeout']);

/**
 * Справка подтверждённой компании: запрашивается, если её ещё нет, один раз за вызов. Сбой не бросается: справки нет,
 * бот отвечает без болей и рубрики, а следующая пачка попробует снова. Неудачи, кроме временных (unavailable,
 * timeout), считаются: после трёх справку больше не запрашивают.
 */
export async function ensureBrief(
  env: CompanyEnv,
  chatId: ChatId,
  state: ChatCompanyState,
): Promise<ChatCompanyState> {
  const { confirmed } = state;
  if (confirmed === null || confirmed.brief !== null) return state;
  if (state.briefFailures >= MAX_BRIEF_FAILURES) return state;
  const result = await env.directory.brief(confirmed.id);
  if (result.ok) return withBrief(state, result.value, env.clock.now());
  logFailure(env.logger, chatId, 'brief', result.failure);
  if (TRANSIENT_FAILURES.has(result.failure)) return state;
  return { ...state, briefFailures: state.briefFailures + 1 };
}
