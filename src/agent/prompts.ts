import type { ChatTurn, SystemBlock } from '../domain/ports.js';
import type { LlmPurpose, StoredMessage } from '../domain/types.js';
import { notImplemented } from '../shared/todo.js';
import type { Knowledge } from './knowledge.js';

/**
 * Системный промпт одного из трёх вызовов: system = [знания с cache: true, затем инструкция этого вызова без кэша].
 * TODO(этап 3): блок знаний: tanbala-agent.md, затем whatsapp.md, байт в байт одинаковый у всех трёх вызовов; до точки кэша ничего изменчивого: ни времени, ни ID.
 * TODO(этап 3): инструкция вызова (ответ, проверка, оценка интереса) вторым блоком с cache: false; данные вызова в system не кладутся, они идут в buildTurns.
 * TODO(этап 4): кэш общий, только если у трёх вызовов одна модель и одинаковый префикс: проверить по cache_read_input_tokens второго и третьего вызова в логе токенов.
 * TODO(этап 3): минимум для кэша у Haiku 5.5: 512 токенов; знаний намного больше, кэш сработает.
 */
export function buildSystem(knowledge: Knowledge, purpose: LlmPurpose): readonly SystemBlock[] {
  return notImplemented('этап 3', 'agent/prompts.buildSystem');
}

/**
 * Реплики для LLM: последние maxMessages сообщений истории и данные этого вызова.
 * callData: данные вызова (черновик для проверки, текущая выжимка) или null.
 * TODO(этап 3): текст клиента только в роли user, ответы бота и менеджера в роли assistant; это данные, а не инструкции.
 * TODO(этап 3): callData добавлять в ПОСЛЕДНЮЮ реплику user с пометкой «данные»; если история кончается репликой assistant, добавить отдельную реплику user.
 * TODO(этап 3): последняя реплика всегда user: реплика assistant в конце для Haiku 5.5 считается prefill и даёт ошибку 400.
 * TODO(этап 3): номер и имя клиента в промпт не передавать: меньше персональных данных уходит за рубеж.
 */
export function buildTurns(
  history: readonly StoredMessage[],
  maxMessages: number,
  callData: string | null,
): readonly ChatTurn[] {
  return notImplemented('этап 3', 'agent/prompts.buildTurns');
}
