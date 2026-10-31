import { z } from 'zod';
import type { ModelsConfig } from '../config/env.js';
import type { CompanyPrompt, LogoReader } from '../domain/company.js';
import type { ImageInput, LlmClient, SystemBlock } from '../domain/ports.js';
import {
  CONVERSATION_STAGES,
  STRENGTH_IDS,
  type BotNote,
  type ChatId,
  type ChatProgress,
  type ClientProfile,
  type ConversationStage,
  type InterestAssessment,
  type InterestLevel,
  type LlmPurpose,
  type LlmResult,
  type ReplyDraft,
  type ReviewResult,
  type StoredMessage,
  type StrengthId,
} from '../domain/types.js';
import { cleanLine } from './clean-text.js';
import { companyReplyData, companyReviewData } from './company-data.js';
import { interestCallData, interestSchema, normalizeInterest } from './interest.js';
import type { Knowledge } from './knowledge.js';
import { profileText } from './profile.js';
import { buildSystem, buildTurns, noteBlock } from './prompts.js';
import { recommendStage, stageReplyData, taskUnderstood } from './stage.js';
import {
  EMPTY_DRAFT_REVIEW,
  normalizeReview,
  reviewCallData,
  reviewSchema,
  type DraftKind,
} from './review.js';

export type { DraftKind } from './review.js';

/** Что агент знает о разговоре. */
export interface ConversationContext {
  readonly chatId: ChatId;
  readonly history: readonly StoredMessage[];
  /** Текущая выжимка о клиенте. */
  readonly profile: ClientProfile;
  /**
   * Уровень интереса, который хранится у чата сейчас (Chat.level). Его видит оценка интереса в данных вызова;
   * конвейер передаёт chat.level. Не передан => оценка идёт без текущего уровня.
   */
  readonly level?: InterestLevel;
  /**
   * Что известно о компании клиента (сервис компании, src/company). Её видят ответ, проверка и оценка интереса в
   * данных вызова. Не передана или off => вызовы идут как раньше, без блока о компании.
   */
  readonly company?: CompanyPrompt;
  /**
   * Ход разговора (chats.getProgress): вопросы цены с последнего возврата боту, отказ отвечать, передавался ли чат,
   * рассказанные сильные стороны и этап последнего ответа. Его видит вызов ответа в строках об этапе (agent/stage.ts).
   * Не передан => вопросов цены не было, ничего не рассказано, бот ещё не отвечал.
   */
  readonly progress?: ChatProgress;
  /**
   * Название компании клиента: подтверждённое или со слов клиента. Известно => безопасный вопрос знакомства о названии
   * не спрашивает. Не передано или null => неизвестно.
   */
  readonly companyName?: string | null;
  /**
   * Заметка для бота (указание коллеги), оставленная при возврате чата: доверенный текст менеджера. Идёт отдельным
   * блоком системного промпта ответа и проверки (prompts.noteBlock); оценка интереса её не видит. Нет => без блока.
   */
  readonly note?: BotNote | null;
}

/**
 * Три отдельных вызова LLM из плана: ответ, проверка черновика, оценка интереса.
 * Сбой любого вызова приходит как LlmResult с ok: false и ведёт к передаче специалисту.
 * Решение о передаче чата принимает вызов ответа (исходы hot, no_answer, asked_human, complaint); оценка
 * интереса только хранит уровень и выжимку. readLogo (шаг д определения компании): название компании с фото
 * профиля бизнес-аккаунта.
 */
export interface Agent extends LogoReader {
  /**
   * Черновик ответа строго по файлам знаний. feedback: замечания проверки для повторной попытки. Исход answer
   * оставляет чат у бота; hot, no_answer, asked_human и complaint передают его специалисту, и у первых трёх text
   * (ответ на то, что есть в знаниях, и фраза о передаче) может быть непустым.
   */
  draftReply(
    context: ConversationContext,
    feedback?: readonly string[],
  ): Promise<LlmResult<ReplyDraft>>;
  /**
   * Проверка текста черновика: нет ли фактов не из знаний, обещаний цен, скидок, сроков или объёмов работ.
   * Результат нормализован: ok true только без замечаний, ok false всегда с замечанием. Пустой черновик не проходит.
   * kind: 'answer' (по умолчанию) для обычного ответа; 'handoff' для сообщения о передаче чата специалисту
   * (hot, no_answer, asked_human): проверяющему сказано, что фраза «Уточню у коллеги и вернусь к вам»
   * допустима, а обещания времени и цены по-прежнему нет.
   */
  reviewDraft(
    context: ConversationContext,
    draftText: string,
    kind?: DraftKind,
  ): Promise<LlmResult<ReviewResult>>;
  /** Уровень интереса и обновлённая выжимка для менеджера: известное раньше сохраняется, если клиент не поправил. */
  assessInterest(context: ConversationContext): Promise<LlmResult<InterestAssessment>>;
}

/** Зависимости агента. */
export interface AgentDeps {
  llm: LlmClient;
  knowledge: Knowledge;
  models: ModelsConfig;
}

/** Сколько последних сообщений истории уходит в промпт: столько же конвейеру достаточно брать из базы. */
export const HISTORY_MESSAGES = 30;

/**
 * Ответ, проверка и оценка короткие (две или три фразы, несколько полей), но размышления Sonnet 5.5 (и Haiku 5.5 у
 * logo) входят в max_tokens: запас, чтобы не получить truncated.
 */
const MAX_TOKENS = 4096;

const INVALID_OUTPUT = { ok: false, failure: 'invalid_output' } as const;

/**
 * Схема ответа модели: плоский объект, все поля обязательны (structured outputs вместо запрещённого prefill).
 * Без transform: вход и выход совпадают. В ReplyDraft её переводит normalizeReplyDraft.
 */
export const replyDraftSchema = z.object({
  outcome: z
    .enum(['answer', 'hot', 'no_answer', 'asked_human', 'complaint'])
    .describe('Исход: answer, hot, no_answer, asked_human или complaint.'),
  text: z
    .string()
    .describe(
      'Текст сообщения клиенту при answer, hot, no_answer и asked_human; при complaint пустая строка.',
    ),
  stopRequested: z
    .boolean()
    .describe('true только при complaint, если клиент просит больше не писать; иначе false.'),
  companyQuestion: z
    .enum(['none', 'confirm', 'name'])
    .describe(
      'О чём из компании ты спросил в text: confirm, если спросил, из той ли компании клиент; name, если спросил, из какой он компании; иначе none.',
    ),
  aboutPrice: z
    .boolean()
    .describe(
      'true, если клиент в последних сообщениях спрашивал цену или стоимость; иначе false.',
    ),
  stage: z
    .enum(CONVERSATION_STAGES as [ConversationStage, ...ConversationStage[]])
    .describe('Этап разговора, на котором написан text'),
  usedFacts: z
    .array(z.enum(STRENGTH_IDS as [StrengthId, ...StrengthId[]]))
    .describe('Номера сильных сторон из consult.md, которые есть в text; иначе пустой список'),
});

type RawReplyDraft = z.infer<typeof replyDraftSchema>;

/** Схема вызова logo: название компании с картинки или null. */
export const logoSchema = z.object({
  companyName: z
    .string()
    .describe('Название компании, которое видно на картинке; null, если его нет.')
    .nullable(),
});

/** Реплика user вызова logo: к ней прикладывается фото профиля. */
const LOGO_TASK = 'Фото профиля клиента в WhatsApp. Какое название компании на нём видно?';

/** Предел контракта API почтового проекта для названия компании. */
const MAX_LOGO_NAME_CHARS = 200;

/**
 * Этап и сильные стороны черновика с текстом: этап, если модель его назвала; номера без дублей по порядку F1…F10, если
 * они есть. Подделки LLM в тестах полей не пишут: тогда их нет и в черновике.
 */
function stageMarks(raw: RawReplyDraft): {
  readonly stage?: ConversationStage;
  readonly usedFacts?: readonly StrengthId[];
} {
  const { stage, usedFacts } = raw as Partial<RawReplyDraft>;
  const used = new Set(usedFacts ?? []);
  const facts = STRENGTH_IDS.filter((id) => used.has(id));
  return {
    ...(stage === undefined ? {} : { stage }),
    ...(facts.length === 0 ? {} : { usedFacts: facts }),
  };
}

/**
 * Противоречивый ответ модели нормализуется здесь один раз: text берётся у answer, hot, no_answer и asked_human,
 * stopRequested только у complaint, aboutPrice у исходов передачи и у answer (там он запасной сигнал вопроса цены),
 * этап и сильные стороны (stageMarks) у тех же исходов с текстом. answer без текста => invalid_output, не
 * угадывать (fail-closed). У hot, no_answer и asked_human пустой text допустим: чат всё равно уходит менеджеру,
 * клиенту пишется фиксированная фраза.
 */
function normalizeReplyDraft(raw: RawReplyDraft): LlmResult<ReplyDraft> {
  switch (raw.outcome) {
    case 'answer': {
      const text = raw.text.trim();
      return text === '' ? INVALID_OUTPUT : { ok: true, value: answerDraft(text, raw) };
    }
    case 'complaint':
      return { ok: true, value: { outcome: 'complaint', stopRequested: raw.stopRequested } };
    case 'hot':
    case 'no_answer':
    case 'asked_human': {
      const draft = { outcome: raw.outcome, text: raw.text.trim(), ...stageMarks(raw) };
      // Подделки LLM в тестах поля не пишут: нет поля => false, и в черновик оно не попадает.
      return { ok: true, value: raw.aboutPrice === true ? { ...draft, aboutPrice: true } : draft };
    }
  }
}

/**
 * Ответ answer: вопрос о компании (confirm или name) сохраняется, чтобы система не задала его второй раз; none
 * и отсутствие поля (подделки LLM в тестах его не пишут) не сохраняются. aboutPrice сохраняется только true: это
 * запасной сигнал вопроса цены, если оценка интереса не получилась (pipeline/handoff-gate.ts).
 */
function answerDraft(text: string, raw: RawReplyDraft): ReplyDraft {
  const question = (raw as Partial<RawReplyDraft>).companyQuestion;
  const asked = question === 'confirm' || question === 'name' ? { companyQuestion: question } : {};
  const price = raw.aboutPrice === true ? { aboutPrice: true } : {};
  return { outcome: 'answer', text, ...asked, ...price, ...stageMarks(raw) };
}

/**
 * Строки об этапе (agent/stage.ts, решение владельца 30.10.2026): рекомендуемый этап по выжимке до этого хода, этапу
 * последнего ответа бота и тому, передавался ли чат (заметка для бота бывает только после возврата, значит, передавался),
 * недостающее для расчёта, понятна ли задача клиента (что делать с вопросом цены, сроков или договора), рассказанные
 * сильные стороны и сколько раз клиент спрашивал цену. Всё по выжимке до этого хода: решение о передаче код принимает по
 * выжимке после оценки этого хода (pipeline/handoff-gate.ts).
 */
function stageData(context: ConversationContext): string {
  const progress = context.progress;
  const advice = recommendStage({
    profile: context.profile,
    lastStage: progress?.lastStage ?? null,
    handedOff: progress?.handedOff === true || context.note != null,
  });
  return stageReplyData({
    advice,
    toldFacts: progress?.toldFacts ?? [],
    priceAsks: progress?.priceAsks ?? 0,
    taskUnderstood: taskUnderstood(context.profile),
  });
}

/**
 * Данные вызова ответа по порядку: строки системы об этапе (stageData; они есть всегда), что известно о компании
 * клиента (companyReplyData), выясненное о клиенте (выжимка, подписанная как слова клиента) и непустые замечания
 * проверки. Строки системы идут раньше значений из слов клиента (ревью 29.10.2026): значение выжимки не выдаст себя за
 * строку системы. Боли справки в блоке о компании до трёх, как их отдал сервис компании (решение владельца 30.10.2026:
 * без отбора по разделу 5 документа владельца).
 */
function replyCallData(
  context: ConversationContext,
  company: CompanyPrompt | undefined,
  feedback: readonly string[],
): string {
  const problems = feedback.map((item) => item.trim()).filter((item) => item !== '');
  const numbered = problems.map((item, index) => `${index + 1}. ${item}`);
  const remarks =
    problems.length === 0
      ? null
      : ['Замечания проверки к прошлому черновику, исправь их:', ...numbered].join('\n');
  const parts = [
    stageData(context),
    companyReplyData(company),
    profileText(context.profile),
    remarks,
  ];
  return parts.filter((part) => part !== null).join('\n\n');
}

/** Один вызов LLM: что в нём общее для трёх назначений (история, лимит токенов, чат) и что своё (модель, инструкция). */
type Ask = <T>(
  purpose: LlmPurpose,
  schema: z.ZodType<T, T>,
  context: ConversationContext,
  callData: string | null,
) => Promise<LlmResult<T>>;

/** system вызова: готовый для назначения; у ответа и проверки с заметкой ещё блок указания коллеги в конце. */
function systemOf(
  systems: Readonly<Record<LlmPurpose, readonly SystemBlock[]>>,
  purpose: LlmPurpose,
  note: BotNote | null | undefined,
): readonly SystemBlock[] {
  if (note == null || (purpose !== 'reply' && purpose !== 'review')) return systems[purpose];
  return [...systems[purpose], noteBlock(purpose, note.text)];
}

/**
 * system строится один раз на назначение: блок знаний у трёх вызовов один и тот же (кэш общий), после него
 * инструкция вызова, а у ответа и проверки при заметке для бота ещё блок указания коллеги (после точки кэша). Модель
 * берётся из конфига по назначению.
 */
function createAsk(deps: AgentDeps): Ask {
  const systems: Readonly<Record<LlmPurpose, readonly SystemBlock[]>> = {
    reply: buildSystem(deps.knowledge, 'reply'),
    review: buildSystem(deps.knowledge, 'review'),
    interest: buildSystem(deps.knowledge, 'interest'),
    logo: buildSystem(deps.knowledge, 'logo'),
  };
  return (purpose, schema, context, callData) =>
    deps.llm.structured({
      purpose,
      model: deps.models[purpose],
      system: systemOf(systems, purpose, context.note),
      turns: buildTurns(context.history, HISTORY_MESSAGES, callData),
      schema,
      maxTokens: MAX_TOKENS,
      chatId: context.chatId,
    });
}

/**
 * Создаёт агента поверх LlmClient. Модели из config/models.json: ответ, проверка и оценка интереса на Sonnet, logo на
 * Haiku.
 * Все вызовы: system = buildSystem(knowledge, purpose) (знания с кэшем, затем инструкция вызова без кэша; блок
 * знаний у трёх вызовов один и тот же, поэтому кэш общий); turns = buildTurns(history, HISTORY_MESSAGES, данные
 * вызова): данные в последней реплике user в блоке «данные». Сбой LLM возвращается как есть, значением.
 * draftReply: модель models.reply, данные вызова: строки об этапе (этап, недостающее для расчёта, рассказанное, вопросы
 * цены), блок о компании, текущая выжимка и замечания проверки (feedback); схема replyDraftSchema, ответ нормализуется в
 * ReplyDraft.
 * reviewDraft: модель models.review, данные вызова: что допустимо о компании клиента и текст черновика (не репликой
 * assistant); схема reviewSchema, противоречия снимает normalizeReview. Пустой черновик не проходит и LLM не вызывает.
 * В блоке о компании ответа и проверки до трёх болей справки, как их отдал сервис компании (без цифр).
 * assessInterest: модель models.interest, данные вызова: текущий уровень, выжимка и вопрос «Вы из компании X?»;
 * схема interestSchema, normalizeInterest чистит поля и сохраняет известное раньше.
 * readLogo: модель models.logo, system только инструкция logo (без знаний и истории), одна реплика user с фото;
 * название после cleanLine, пустое => null.
 */
export function createAgent(deps: AgentDeps): Agent {
  const ask = createAsk(deps);
  const logoSystem = buildSystem(deps.knowledge, 'logo');
  return {
    async draftReply(
      context: ConversationContext,
      feedback: readonly string[] = [],
    ): Promise<LlmResult<ReplyDraft>> {
      const callData = replyCallData(context, context.company, feedback);
      const result = await ask('reply', replyDraftSchema, context, callData);
      return result.ok ? normalizeReplyDraft(result.value) : result;
    },
    async reviewDraft(
      context: ConversationContext,
      draftText: string,
      kind: DraftKind = 'answer',
    ): Promise<LlmResult<ReviewResult>> {
      if (draftText.trim() === '') {
        return { ok: true, value: EMPTY_DRAFT_REVIEW };
      }
      const callData = reviewCallData(draftText, kind, companyReviewData(context.company));
      const result = await ask('review', reviewSchema, context, callData);
      return result.ok ? { ok: true, value: normalizeReview(result.value) } : result;
    },
    async assessInterest(context: ConversationContext): Promise<LlmResult<InterestAssessment>> {
      const callData = interestCallData(context.profile, context.level, context.company);
      const result = await ask('interest', interestSchema, context, callData);
      return result.ok
        ? { ok: true, value: normalizeInterest(result.value, context.profile) }
        : result;
    },
    async readLogo(chatId: ChatId, photo: ImageInput): Promise<LlmResult<string | null>> {
      const result = await deps.llm.structured({
        purpose: 'logo',
        model: deps.models.logo,
        system: logoSystem,
        turns: [{ role: 'user', text: LOGO_TASK }],
        image: photo,
        schema: logoSchema,
        maxTokens: MAX_TOKENS,
        chatId,
      });
      if (!result.ok) return result;
      const name = cleanLine(result.value.companyName ?? '', MAX_LOGO_NAME_CHARS);
      return { ok: true, value: name === '' ? null : name };
    },
  };
}
