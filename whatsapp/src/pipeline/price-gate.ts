import type { ConversationContext } from '../agent/agent.js';
import type { CompanyPrompt, CompanyQuestion } from '../domain/company.js';
import type {
  InterestAssessment,
  LlmResult,
  ReplyDraft,
  ReviewedText,
  TurnSignals,
} from '../domain/types.js';
import {
  companyAskable,
  handoffMinimum,
  MINIMUM_LABELS,
  minimumQuestion,
  PRICE_ASKS_FOR_HANDOFF,
  type HandoffMinimum,
  type MinimumField,
} from '../handoff/minimum.js';
import { priceQuestion } from './decide.js';

/**
 * Что код знает о цене в этом ходе (решение владельца 29.10.2026): минимум для передачи по свежей выжимке, сколько
 * раз клиент спросил цену вместе с этим сообщением, отказывался ли отвечать и что записать после отправленного ответа.
 */
export interface PriceSituation {
  readonly minimum: HandoffMinimum;
  /** Вопросов цены с последнего возврата чата боту, включая этот ход. */
  readonly priceAsks: number;
  /** Клиент отказывался отвечать раньше или отказывается сейчас. */
  readonly refused: boolean;
  /** Этот ход: спрашивает ли клиент цену и отказывается ли отвечать (записывается после отправленного ответа). */
  readonly signals: TurnSignals;
  readonly company: CompanyPrompt | undefined;
  /** Есть заметка для бота (указание коллеги): в ней может быть ориентир цены. */
  readonly hasNote: boolean;
}

/** Фиксированный ответ вместо ранней передачи: вопрос о первом недостающем поле минимума. */
export interface MinimumFallback {
  readonly field: MinimumField;
  readonly text: ReviewedText;
  /** Вопрос о названии компании: его надо запомнить, как вопрос модели. */
  readonly companyQuestion?: CompanyQuestion;
}

function aboutPriceOf(draft: LlmResult<ReplyDraft>): boolean {
  return draft.ok && 'aboutPrice' in draft.value && draft.value.aboutPrice === true;
}

/**
 * Ход по данным разговора и оценке интереса. Выжимка и сигналы из оценки этого хода; оценки нет => выжимка до этого
 * сообщения, вопрос цены по aboutPrice черновика, отказа сейчас нет. Компания для минимума: context.companyName
 * (подтверждённая или со слов клиента) и можно ли о ней спросить по блоку о компании.
 */
export function priceSituation(
  context: ConversationContext,
  assessment: InterestAssessment | null,
  draft: LlmResult<ReplyDraft>,
): PriceSituation {
  const priceAsked = assessment?.signals?.priceAsked === true || aboutPriceOf(draft);
  const refusedNow = assessment?.signals?.refused === true;
  const progress = context.progress ?? { priceAsks: 0, refused: false };
  return {
    minimum: handoffMinimum({
      profile: assessment?.profile ?? context.profile,
      companyName: context.companyName ?? null,
      companyAskable: companyAskable(context.company),
    }),
    priceAsks: progress.priceAsks + (priceAsked ? 1 : 0),
    refused: progress.refused || refusedNow,
    signals: { priceAsked, refused: refusedNow },
    company: context.company,
    hasNote: context.note != null,
  };
}

/**
 * Ранняя передача по цене: исход hot, клиент спрашивает цену (aboutPrice черновика или оценка интереса), минимума нет,
 * вопрос цены не третий и клиент не отказывался отвечать. Просьба о человеке и жалоба другие исходы, их это не касается.
 */
export function isPrematurePriceHandoff(draft: ReplyDraft, situation: PriceSituation): boolean {
  if (draft.outcome !== 'hot') return false;
  const aboutPrice = draft.aboutPrice === true || situation.signals.priceAsked;
  return (
    aboutPrice &&
    situation.minimum.missing.length > 0 &&
    situation.priceAsks < PRICE_ASKS_FOR_HANDOFF &&
    !situation.refused
  );
}

/** Клиент спросил цену третий раз, а модель ответила answer: чат передаётся по правилу владельца. */
export function isThirdPriceAsk(draft: ReplyDraft, situation: PriceSituation): boolean {
  return (
    draft.outcome === 'answer' &&
    situation.signals.priceAsked &&
    situation.priceAsks >= PRICE_ASKS_FOR_HANDOFF
  );
}

function firstMissing(situation: PriceSituation): MinimumField {
  return situation.minimum.missing[0] ?? 'itemCount';
}

/**
 * Замечание повтору черновика: передавать рано, чего не хватает и какой один вопрос задать; при заметке для бота
 * напоминание ответить ориентиром из неё, если он там есть.
 */
export function minimumRemark(situation: PriceSituation): string {
  const missing = situation.minimum.missing.map((field) => MINIMUM_LABELS[field]).join(', ');
  const question = minimumQuestion(firstMissing(situation), situation.company);
  const note = situation.hasNote
    ? ' Если в указании коллеги есть ориентир цены, ответь им ровно как там написано, вместо вопроса.'
    : '';
  return `Передавать чат рано: для передачи по цене не хватает: ${missing}. Верни answer: ответь на то, что есть в документах, напиши, что цена сильно зависит от объёма, и задай один вопрос: ${question}. Объясни зачем: чтобы коллега сразу назвал ориентир. О передаче чата не пиши.${note}`;
}

/** Фиксированный вопрос о первом недостающем поле; вопрос о компании отмечается как вопрос о названии. */
export function minimumFallback(situation: PriceSituation): MinimumFallback {
  const field = firstMissing(situation);
  const text = priceQuestion(field);
  return field === 'company' ? { field, text, companyQuestion: 'name' } : { field, text };
}
