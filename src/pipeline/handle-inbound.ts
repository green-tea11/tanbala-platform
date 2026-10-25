import type { Agent } from '../agent/agent.js';
import type {
  ChatsRepo,
  Clock,
  Logger,
  MessagesRepo,
  Transcriber,
  WhatsAppInbox,
} from '../domain/ports.js';
import type { HandoffReason, InboundMessage } from '../domain/types.js';
import type { HandoffService } from '../handoff/handoff.js';
import type { Outbox } from '../messaging/outbox.js';
import { notImplemented } from '../shared/todo.js';

/** Зависимости конвейера обработки сообщения. */
export interface PipelineDeps {
  chats: ChatsRepo;
  messages: MessagesRepo;
  agent: Agent;
  outbox: Outbox;
  handoff: HandoffService;
  transcriber: Transcriber;
  inbox: WhatsAppInbox;
  clock: Clock;
  logger: Logger;
}

/** Чем закончилась обработка пачки сообщений клиента. */
export type PipelineOutcome =
  | { readonly kind: 'replied' }
  | { readonly kind: 'silent'; readonly reason: 'manager_mode' | 'duplicate' }
  | { readonly kind: 'handed_off'; readonly reason: HandoffReason };

/**
 * Обрабатывает пачку сообщений клиента по шагам раздела плана «Как обрабатывается сообщение».
 * TODO(этап 3): шаг 1: записать сообщения (дубли по waId пропустить); голосовое при transcriber.enabled скачать через inbox.downloadAudio с лимитом байт и расшифровать.
 * TODO(этап 3): что отвечать на голосовое, пока расшифровки нет (этап 7 или пустой ключ OpenRouter): спросить владельца.
 * TODO(этап 3): шаг 2: статус чата manager => бот молчит и не отмечает сообщения прочитанными.
 * TODO(этап 3): шаг 3: agent.draftReply строго по знаниям. Временно, до сервиса передачи (этап 5), статус manager (by 'bot') и фиксированная фраза через outbox.sendHandoffNotice, без уведомления менеджеру, для всех трёх исходов: no_answer («уточню у специалиста»), asked_human («передал вопрос специалисту, он вам напишет»), complaint (извинение и «передал вопрос специалисту»; со stopRequested только извинение).
 * TODO(этап 3): LlmResult с ok: false (сбой API, отказ, неверный ответ, 'disabled') и дневной потолок вызовов (без вызова LLM) => так же статус manager и фраза «передам вопрос специалисту».
 * TODO(этап 3): шаг 6: ответ через outbox.sendBotReply, затем markRead. До этапа 4 проверок нет: временное приведение текста черновика к ReviewedText допустимо только при подключённом тестовом номере, с TODO(этап 4) на удаление этого приведения.
 * TODO(этап 4): шаг 4: бесплатные проверки кодом (checks/code-checks.ts); шаг 5: agent.reviewDraft; развилка через pipeline/decide.ts: один повтор с замечаниями, потом передача 'check_failed'.
 * TODO(этап 4): agent.assessInterest параллельно с ответом (при горячем клиенте уходит одно сообщение, а не два); chats.saveAssessment.
 * TODO(этап 5): все передачи через handoff.handOff: hot, no_answer, asked_human, complaint, check_failed, llm_error, с уведомлением менеджеру.
 */
export function handleClientBatch(
  deps: PipelineDeps,
  batch: readonly InboundMessage[],
): Promise<PipelineOutcome> {
  return notImplemented('этап 3', 'pipeline/handle-inbound.handleClientBatch');
}
