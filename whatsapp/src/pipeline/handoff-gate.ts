import type { ConversationContext } from '../agent/agent.js';
import {
  CALC_LABELS,
  calcMissing,
  ESTIMATE_LATER,
  taskUnderstood,
  type CalcField,
} from '../agent/stage.js';
import { priceAmountsOf } from '../checks/amounts.js';
import type {
  ClientProfile,
  InterestAssessment,
  LlmResult,
  ReplyDraft,
  TurnSignals,
} from '../domain/types.js';
import { companyAskable } from '../handoff/minimum.js';
import { calcSafeQuestion, type SafeQuestion } from './safe-questions.js';

/** Какой по счёту вопрос цены передаёт чат без понятной задачи (решение владельца 30.10.2026, было четыре). */
export const PRICE_ASKS_FOR_HANDOFF = 3;

/** Сколько ходов подряд клиент уходит от вопросов, чтобы чат ушёл коллеге (решение владельца 30.10.2026). */
export const REFUSALS_FOR_HANDOFF = 2;

/**
 * Почему чат уходит коллеге с исходом hot (решение владельца 30.10.2026): клиент спросил цену третий раз
 * (price_third), спрашивает цену, сроки или договор, когда задача понятна (price), два хода подряд уходит от вопросов
 * (refused), для расчёта известно всё (final).
 */
export type HotKind = 'price_third' | 'price' | 'refused' | 'final';

/** Что код знает о ходе для решения о передаче. */
export interface TurnSituation {
  /** Выжимка из оценки этого хода, без неё прежняя. */
  readonly profile: ClientProfile;
  /** Чего не хватает для расчёта по этой выжимке (agent/stage.calcMissing). */
  readonly missing: readonly CalcField[];
  /** Задача клиента понятна (agent/stage.taskUnderstood). */
  readonly taskUnderstood: boolean;
  /** Вопросов цены (и сроков или договора) с последнего возврата чата боту, включая этот ход. */
  readonly priceAsks: number;
  /** Сколько ходов подряд клиент уходит от вопросов, включая этот; ход без отказа даёт ноль. */
  readonly refusedStreak: number;
  /** Этот ход: спрашивает ли клиент цену и отказывается ли отвечать (записывается после отправленного ответа). */
  readonly signals: TurnSignals;
  /** О названии компании можно спросить в вопросе знакомства: оно неизвестно, и блок о компании это разрешает. */
  readonly companyAskable: boolean;
  /** Есть заметка для бота (указание коллеги): в ней может быть ориентир цены. */
  readonly hasNote: boolean;
  /**
   * В заметке есть сумма-цена (checks/amounts.priceAmountsOf): на вопрос цены бот отвечает ею, и вопрос цены чат не
   * передаёт (ревью 29.10.2026, второй круг).
   */
  readonly notePrice: boolean;
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

function hasText(value: string | null | undefined): boolean {
  return value != null && value.trim() !== '';
}

/**
 * Ход по данным разговора и оценке интереса. Выжимка и сигналы из оценки этого хода; оценки нет => выжимка до этого
 * сообщения, вопрос цены по aboutPrice черновика (priceAskedOf), отказа сейчас нет. Уходы от вопросов подряд: прежний
 * счёт (ChatProgress.refusedStreak) и этот ход, ход без отказа обнуляет счёт.
 */
export function turnSituation(
  context: ConversationContext,
  assessment: InterestAssessment | null,
  draft: LlmResult<ReplyDraft>,
): TurnSituation {
  const priceAsked = priceAskedOf(assessment, draft);
  const refusedNow = assessment?.signals?.refused === true;
  const progress = context.progress;
  const profile = assessment?.profile ?? context.profile;
  return {
    profile,
    missing: calcMissing(profile),
    taskUnderstood: taskUnderstood(profile),
    priceAsks: (progress?.priceAsks ?? 0) + (priceAsked ? 1 : 0),
    refusedStreak: refusedNow ? (progress?.refusedStreak ?? 0) + 1 : 0,
    signals: { priceAsked, refused: refusedNow },
    companyAskable: !hasText(context.companyName) && companyAskable(context.company),
    hasNote: context.note != null,
    notePrice: context.note != null && priceAmountsOf(context.note.text).length > 0,
  };
}

/**
 * Почему hot в этом ходе передаёт чат, по порядку: третий вопрос цены, вопрос цены при понятной задаче, два ухода от
 * вопросов подряд, для расчёта известно всё. Вопрос цены не передаёт чат, если в заметке для бота есть сумма-цена. null:
 * передавать рано (ранний hot). Исход hot модели принимается, только если причина есть; ответ answer код сам превращает
 * в передачу при любой причине, кроме финала (финал объявляет модель своей сводкой).
 */
export function hotKindOf(situation: TurnSituation): HotKind | null {
  const priceTurn = situation.signals.priceAsked && !situation.notePrice;
  if (priceTurn && situation.priceAsks >= PRICE_ASKS_FOR_HANDOFF) return 'price_third';
  if (priceTurn && situation.taskUnderstood) return 'price';
  if (situation.refusedStreak >= REFUSALS_FOR_HANDOFF) return 'refused';
  return situation.missing.length === 0 ? 'final' : null;
}

/** Заметка коллеги может отвечать на вопрос цены: тогда ответить ею. */
const NOTE_REMINDER =
  ' Если в указании коллеги есть ориентир цены, ответь им ровно как там написано.';

/**
 * Замечание повтору раннего hot (решение владельца 30.10.2026). Клиент спрашивает цену, сроки или договор, а задача не
 * понятна: фраза об ориентире и вопрос о первом недостающем для расчёта (при заметке для бота ещё напоминание ответить
 * ориентиром из неё). Без вопроса цены: чего не хватает для финала и один открытый вопрос о недостающем.
 */
export function earlyHotRemark(situation: TurnSituation): string {
  const labels = situation.missing.map((field) => CALC_LABELS[field]);
  if (!situation.signals.priceAsked) {
    return `Для финала не хватает: ${labels.join(', ')}. Задай один открытый вопрос о недостающем.`;
  }
  const first = labels[0] ?? CALC_LABELS.items;
  const note = situation.hasNote ? NOTE_REMINDER : '';
  return `Цену, сроки и договор называет коллега. Ответь «${ESTIMATE_LATER}» и задай один открытый вопрос о недостающем: ${first}.${note}`;
}

/**
 * Готовый вопрос, если повтор раннего hot не удался: первое недостающее для расчёта, о котором бот ещё не спрашивал в
 * чате (botTexts: все его прошлые ответы в окне истории), на ходу с вопросом цены с фразой об ориентире.
 */
export function earlyHotFallback(
  situation: TurnSituation,
  botTexts: readonly string[],
): SafeQuestion {
  const { profile, companyAskable: askCompany } = situation;
  return calcSafeQuestion(
    { profile, companyAskable: askCompany, lastBotText: null, botTexts },
    situation.signals.priceAsked,
  );
}
