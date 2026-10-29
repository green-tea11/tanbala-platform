import type { ConversationContext } from '../agent/agent.js';
import { priceAmountsOf } from '../checks/amounts.js';
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
import { askedFields, ESTIMATE_LATER, safeQuestion } from './safe-questions.js';

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
  /**
   * В заметке есть сумма-цена (checks/amounts.priceAmountsOf): на вопрос цены бот отвечает ею, и код не передаёт чат
   * ни при отказе отвечать, ни при четвёртом вопросе цены (ревью 29.10.2026, второй круг).
   */
  readonly notePrice: boolean;
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
 * Спрашивает ли клиент цену в этом ходе. У исхода передачи (hot и другие) вопрос цены по оценке интереса или по
 * aboutPrice черновика. У answer aboutPrice только запасной сигнал (ревью 29.10.2026): он считается, если оценка
 * интереса этого хода не вернула сигналов (сбой, исключение), иначе решает оценка. Модель отмечает «спрашивал цену в
 * последних сообщениях» и в ходах после вопроса цены: без оценки счёт вопросов цены вырос бы на каждом ответе.
 */
function priceAskedOf(
  assessment: InterestAssessment | null,
  draft: LlmResult<ReplyDraft>,
): boolean {
  const signals = assessment?.signals;
  const isAnswer = draft.ok && draft.value.outcome === 'answer';
  if (isAnswer && signals !== undefined) return signals.priceAsked;
  return signals?.priceAsked === true || aboutPriceOf(draft);
}

/**
 * Ход по данным разговора и оценке интереса. Выжимка и сигналы из оценки этого хода; оценки нет => выжимка до этого
 * сообщения, вопрос цены по aboutPrice черновика (priceAskedOf), отказа сейчас нет. Компания для минимума:
 * context.companyName (подтверждённая или со слов клиента) и можно ли о ней спросить по блоку о компании.
 */
export function priceSituation(
  context: ConversationContext,
  assessment: InterestAssessment | null,
  draft: LlmResult<ReplyDraft>,
): PriceSituation {
  const priceAsked = priceAskedOf(assessment, draft);
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
    notePrice: context.note != null && priceAmountsOf(context.note.text).length > 0,
  };
}

/**
 * Ранняя передача по цене: исход hot, клиент спрашивает цену (aboutPrice черновика или оценка интереса), минимума нет,
 * вопрос цены не четвёртый и клиент не отказывался отвечать. Просьба о человеке и жалоба другие исходы, их это не касается.
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

/** Почему код передаёт чат сам, хотя модель ответила answer (решение владельца 29.10.2026, пункт 3). */
export type ForcedPriceHandoff = 'price_asks_limit' | 'refused';

/**
 * Модель ответила answer, а чат по правилу владельца уходит коллеге с фразой о цене: клиент спросил цену четвёртый раз
 * или в этом ходе отказывается отвечать на вопросы и спрашивает цену сейчас или спрашивал раньше (ревью 29.10.2026:
 * отказ передаёт чат кодом, как четвёртый вопрос, а не только разрешает hot модели). В заметке есть сумма-цена: ответ
 * коллеги уже есть, бот называет его, и передачи нет (иначе передача сняла бы заметку). Иначе null.
 */
export function forcedPriceHandoff(
  draft: ReplyDraft,
  situation: PriceSituation,
): ForcedPriceHandoff | null {
  if (draft.outcome !== 'answer' || situation.notePrice) return null;
  const { signals, priceAsks } = situation;
  if (signals.priceAsked && priceAsks >= PRICE_ASKS_FOR_HANDOFF) return 'price_asks_limit';
  return signals.refused && priceAsks > 0 ? 'refused' : null;
}

function firstMissing(situation: PriceSituation): MinimumField {
  return situation.minimum.missing[0] ?? 'items';
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
  return `Передавать чат рано: для передачи по цене не хватает: ${missing}. Верни answer: ответь на то, что есть в документах, напиши «${ESTIMATE_LATER}» и задай один вопрос: ${question}. О передаче чата не пиши.${note}`;
}

/**
 * Фиксированный вопрос о первом недостающем поле с фразой об ориентире (клиент спросил цену); о чём бот спросил прошлым
 * сообщением (lastBotText), второй раз подряд не спрашивается, если есть другое недостающее. Вопрос о компании
 * отмечается как вопрос о названии.
 */
export function minimumFallback(
  situation: PriceSituation,
  lastBotText: string | null = null,
): MinimumFallback {
  const asked = lastBotText === null ? new Set<string>() : askedFields(lastBotText);
  const fresh = situation.minimum.missing.find((missing) => !asked.has(missing));
  const field = fresh ?? firstMissing(situation);
  const text = safeQuestion(field, true);
  return field === 'company' ? { field, text, companyQuestion: 'name' } : { field, text };
}
