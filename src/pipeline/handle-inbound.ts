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
  | { readonly kind: 'voice_notice' }
  | { readonly kind: 'silent'; readonly reason: 'manager_mode' | 'duplicate' }
  | { readonly kind: 'handed_off'; readonly reason: HandoffReason };

/**
 * Обрабатывает пачку сообщений клиента по шагам раздела плана «Как обрабатывается сообщение».
 * TODO(этап 3): шаг 1: записать сообщения (дубли по waId пропустить); голосовое при transcriber.enabled скачать через inbox.downloadAudio с лимитом байт и расшифровать.
 * TODO(этап 3): пока transcriber.enabled false (до этапа 7 или без ключа OpenRouter), на голосовое ответить через outbox.sendVoiceNotice ровно «Сейчас не могу прослушать голосовое, напишите, пожалуйста, текстом» и больше ничего (решение владельца); LLM не вызывать; одна фраза на пачку, даже если голосовых несколько.
 * TODO(этап 3): живая пачка с текстом и голосовым: сначала фраза про голосовое, затем ответ на текст, в порядке входящих; markAnswered один раз в конце пачки, иначе второй ответ получит 'skipped_no_inbound'.
 * TODO(этап 3): пачка простоя (сообщения за время простоя не старше порога) с голосовым и текстом: ОДИН ответ на чат (решение владельца): есть текст => ответ на текст без фразы про голосовое; только голосовые => одна фраза про голосовое.
 * TODO(этап 3): шаг 2: статус чата manager => бот молчит и не отмечает сообщения прочитанными.
 * TODO(этап 3): сообщения за время простоя не старше BACKLOG_MAX_AGE_HOURS приходят сюда как обычные: накопленные сообщения чата одна пачка и ОДИН ответ на чат (решение владельца). Старше порога сюда не попадают: WaEvent 'stale' уходит в pipeline/backlog.ts.
 * TODO(этап 2): в закрытом режиме сюда приходят только чаты из TEST_ALLOWLIST: остальные отсекает whatsapp/inbound.ts, а outbox не отправит в них ('skipped_test_mode').
 * TODO(этап 3): шаг 3: agent.draftReply строго по знаниям. Временно, до сервиса передачи (этап 5), статус manager (by 'bot') и фиксированная фраза через outbox.sendHandoffNotice, без уведомления менеджеру, для всех трёх исходов: no_answer («уточню у специалиста»), asked_human («передал вопрос специалисту, он вам напишет»), complaint (извинение и «передал вопрос специалисту»; со stopRequested только извинение).
 * TODO(этап 3): LlmResult с ok: false (сбой API, отказ, неверный ответ, 'disabled') => так же статус manager и фраза «передам вопрос специалисту».
 * TODO(этап 3): failure 'budget_exceeded' (исчерпан дневной лимит API_DAILY_LIMIT или API_DAILY_LIMIT_PER_CHAT, вызова API не было) => бот замолкает в этом чате: статус manager (by 'bot'), фразы клиенту нет, уведомление менеджеру через outbox.notifyManager(text, 'limit') с указанием лимита (scope); с этапа 5 то же через handoff.handOff({ reason: 'limit', scope }).
 * TODO(этап 3): шаг 6: ответ через outbox.sendBotReply, затем markRead. До этапа 4 проверок нет: временное приведение текста черновика к ReviewedText допустимо только при TEST_MODE=true (отвечаем только номерам из TEST_ALLOWLIST), с TODO(этап 4) на удаление этого приведения.
 * TODO(этап 4): текст ответа LLM сначала через checks/code-checks.normalizeDraft (NFKC, без Cf и Cc, кроме \n), затем runCodeChecks: проверяется и уходит клиенту один и тот же текст.
 * TODO(этап 4): шаг 4: бесплатные проверки кодом (checks/code-checks.ts); шаг 5: agent.reviewDraft; развилка через pipeline/decide.ts: один повтор с замечаниями, потом передача 'check_failed'.
 * TODO(этап 4): agent.assessInterest параллельно с ответом (при горячем клиенте уходит одно сообщение, а не два); chats.saveAssessment.
 * TODO(этап 5): все передачи через handoff.handOff: hot, no_answer, asked_human, complaint, check_failed, llm_error, limit, с уведомлением менеджеру.
 */
export function handleClientBatch(
  deps: PipelineDeps,
  batch: readonly InboundMessage[],
): Promise<PipelineOutcome> {
  return notImplemented('этап 3', 'pipeline/handle-inbound.handleClientBatch');
}
