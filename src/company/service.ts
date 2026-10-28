import type {
  ChatCompaniesRepo,
  CompanyDirectory,
  CompanyPrompt,
  CompanyQuestion,
  CompanyService,
  LogoReader,
} from '../domain/company.js';
import type { Clock, Logger, WhatsAppContacts } from '../domain/ports.js';
import type { ChatId } from '../domain/types.js';
import { applyMention, savePainsOnly } from './assess.js';
import type { CompanyEnv } from './env.js';
import { identifyChat } from './identify.js';
import { prepareTurn } from './prepare.js';
import { buildPrompt, OFF_PROMPT } from './prompt.js';
import { buildOffSummary, buildSummary } from './summary.js';
import { afterReplySent, stopAwaiting } from './transitions.js';

/** Зависимости сервиса определения компании. */
export interface CompanyDeps {
  readonly directory: CompanyDirectory;
  readonly contacts: WhatsAppContacts;
  readonly logo: LogoReader;
  readonly repo: ChatCompaniesRepo;
  readonly clock: Pick<Clock, 'now'>;
  readonly logger: Logger;
  /** Адрес интерфейса почтового проекта (EMAIL_UI_URL) для ссылки на карточку; null: адреса нет. */
  readonly emailUiUrl: string | null;
}

/** Синхронная работа как промис: исключение базы становится отказом промиса, а не броском. */
function resolved<T>(work: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(work());
  });
}

/**
 * Ответ ушёл клиенту: вопрос о кандидате (один раз, в том числе по названию в тексте) или о названии (один раз),
 * иначе снимается ожидание ответа на прошлый вопрос. Пишется, только если состояние изменилось.
 */
function markAsked(
  env: CompanyEnv,
  chatId: ChatId,
  question: CompanyQuestion,
  sentText: string,
): void {
  const before = env.repo.get(chatId);
  const nowMs = env.clock.now();
  const after = afterReplySent(before, question, sentText, nowMs);
  if (after !== before) env.repo.save(after, nowMs);
}

/**
 * Чат ушёл менеджеру или вернулся боту: ожидание ответа на «Вы из компании X?» снимается, время вопроса и остальное
 * состояние не меняются. Пишется, только если ответа ждали.
 */
function stopAwaitingAnswer(env: CompanyEnv, chatId: ChatId): void {
  const before = env.repo.get(chatId);
  const after = stopAwaiting(before);
  if (after !== before) env.repo.save(after, env.clock.now());
}

/**
 * Определение компании клиента. Выключенный внутренний API (directory.enabled false): бот работает как раньше,
 * ничего не запрашивает ни у API, ни у WhatsApp; из оценки интереса сохраняются только боли клиента.
 * Сбои API, WhatsApp и модели приходят значениями и в лог идут только кодом (ID чата, шаг, код сбоя); сбои базы
 * пробрасываются как есть. Вызовы для одного чата идут по очереди (так работает конвейер ответов), поэтому
 * состояние читается и пишется без блокировок.
 */
export function createCompanyService(deps: CompanyDeps): CompanyService {
  const { directory } = deps;
  if (!directory.enabled) return createOffService(deps);
  const env: CompanyEnv = { ...deps, directory };
  return {
    prepare: (chat, messages) => prepareTurn(env, chat, messages),
    applyAssessment: async (chatId, mention): Promise<CompanyPrompt> =>
      buildPrompt(
        mention === null ? env.repo.get(chatId) : await applyMention(env, chatId, mention),
      ),
    markAsked: (chatId, question, sentText) => {
      markAsked(env, chatId, question, sentText);
    },
    stopAwaiting: (chatId) => {
      stopAwaitingAnswer(env, chatId);
    },
    identifyAfterReply: (chat) => identifyChat(env, chat),
    summary: (chatId) => buildSummary(deps.repo.get(chatId), deps.emailUiUrl),
  };
}

function createOffService(deps: CompanyDeps): CompanyService {
  return {
    prepare: () => Promise.resolve({ prompt: OFF_PROMPT, awaitingAnswer: false }),
    applyAssessment: (chatId, mention) =>
      resolved(() => {
        if (mention !== null) savePainsOnly(deps.repo, deps.clock, chatId, mention.pains);
        return OFF_PROMPT;
      }),
    markAsked: () => undefined,
    stopAwaiting: () => undefined,
    identifyAfterReply: () => Promise.resolve(),
    summary: (chatId) => buildOffSummary(deps.repo.get(chatId)),
  };
}
